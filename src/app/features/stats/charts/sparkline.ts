import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** 12-ish point trend for a KPI tile. Stretches to its box; the end dot is a separate element so it stays round. */
@Component({
  selector: 'app-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative block h-8 pe-1', 'aria-hidden': 'true' },
  template: `
    @if (geo(); as g) {
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" class="block h-full w-full overflow-visible">
        <path [attr.d]="g.area" [style.fill]="color()" fill-opacity="0.1" />
        <path
          [attr.d]="g.line"
          fill="none"
          [style.stroke]="color()"
          stroke-width="1.75"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <span
        class="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        [style.background]="color()"
        [style.box-shadow]="'0 0 0 2px var(--background)'"
        [style.left]="'calc((100% - 4px) * ' + g.endX / 100 + ')'"
        [style.top.%]="g.endY / 32 * 100"
      ></span>
    }
  `,
})
export class Sparkline {
  readonly values = input.required<readonly number[]>();
  readonly color = input('var(--chart-1)');

  protected readonly geo = computed(() => {
    const v = this.values();
    if (v.length < 2) return null;
    const min = Math.min(...v, 0);
    const max = Math.max(...v);
    const span = max - min || 1;
    const pts = v.map((val, i) => [(i / (v.length - 1)) * 100, 28 - ((val - min) / span) * 24] as const);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
    const last = pts[pts.length - 1];
    return { line, area: `${line}L100,32L0,32Z`, endX: last[0], endY: last[1] };
  });
}
