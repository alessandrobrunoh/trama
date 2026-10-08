import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { ChartSlice } from './chart-utils';

/**
 * Current mix as a ring + a legend that carries every number. Hovering a slice (or its legend
 * row) dims the rest and puts that slice in the centre. The 2px gaps are surface colour.
 */
@Component({
  selector: 'app-donut-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-wrap items-center gap-x-6 gap-y-4' },
  template: `
    <div class="relative shrink-0" [style.width.px]="size()" [style.height.px]="size()">
      <svg [attr.viewBox]="'0 0 ' + size() + ' ' + size()" class="block -rotate-90" role="img" [attr.aria-label]="summary()">
        <circle [attr.cx]="c()" [attr.cy]="c()" [attr.r]="r()" fill="none" style="stroke: var(--border)" [attr.stroke-width]="stroke" stroke-opacity="0.6" />
        @for (a of arcs(); track a.key) {
          <circle
            [attr.cx]="c()"
            [attr.cy]="c()"
            [attr.r]="r()"
            fill="none"
            [style.stroke]="a.color"
            [attr.stroke-width]="active() === a.key ? stroke + 3 : stroke"
            [attr.stroke-dasharray]="a.dash"
            [attr.stroke-dashoffset]="a.offset"
            [attr.stroke-opacity]="active() === null || active() === a.key ? 1 : 0.35"
            class="motion-safe:transition-[stroke-width,stroke-opacity]"
          />
        }
        @for (a of arcs(); track a.key) {
          <!-- wide invisible hit target, stays put when the visible arc grows -->
          <circle
            [attr.cx]="c()"
            [attr.cy]="c()"
            [attr.r]="r()"
            fill="none"
            stroke="transparent"
            [attr.stroke-width]="stroke + 10"
            [attr.stroke-dasharray]="a.hitDash"
            [attr.stroke-dashoffset]="a.hitOffset"
            (pointerenter)="active.set(a.key)"
            (pointerleave)="active.set(null)"
          />
        }
      </svg>
      <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span class="text-2xl leading-7 font-semibold tracking-tight">{{ center().value }}</span>
        <span class="text-muted-foreground max-w-[84px] truncate text-[11px]">{{ center().label }}</span>
      </div>
    </div>

    <ul class="grid min-w-44 flex-1 gap-0.5">
      @for (s of slices(); track s.key) {
        <li
          class="hover:bg-hover -mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors"
          [class.bg-hover]="active() === s.key"
          (pointerenter)="active.set(s.key)"
          (pointerleave)="active.set(null)"
        >
          <span class="size-2 shrink-0 rounded-[2px]" [style.background]="s.color"></span>
          <span class="text-muted-foreground min-w-0 flex-1 truncate">{{ s.label }}</span>
          <span class="font-medium tabular-nums">{{ s.value }}</span>
          <span class="text-meta w-9 text-end tabular-nums">{{ pct(s.value) }}%</span>
        </li>
      }
    </ul>
  `,
})
export class DonutChart {
  readonly slices = input.required<readonly ChartSlice[]>();
  readonly centerLabel = input('Total');
  readonly size = input(148);

  protected readonly stroke = 16;
  protected readonly active = signal<string | null>(null);

  protected readonly c = computed(() => this.size() / 2);
  protected readonly r = computed(() => (this.size() - this.stroke - 8) / 2);
  private readonly total = computed(() => this.slices().reduce((n, s) => n + s.value, 0));

  protected readonly arcs = computed(() => {
    const total = this.total();
    const circ = 2 * Math.PI * this.r();
    const live = this.slices().filter((s) => s.value > 0);
    const gap = live.length > 1 ? 2 : 0;
    let acc = 0;
    return live.map((s) => {
      const len = (s.value / total) * circ;
      const arc = Math.max(1, len - gap);
      const out = {
        key: s.key,
        color: s.color,
        dash: `${arc} ${circ - arc}`,
        offset: -acc,
        hitDash: `${len} ${circ - len}`,
        hitOffset: -acc,
      };
      acc += len;
      return out;
    });
  });

  protected readonly center = computed(() => {
    const a = this.active();
    const hit = a ? this.slices().find((s) => s.key === a) : undefined;
    return hit ? { value: String(hit.value), label: hit.label } : { value: String(this.total()), label: this.centerLabel() };
  });

  protected readonly summary = computed(() => this.slices().map((s) => `${s.label} ${s.value}`).join(', '));

  protected pct(value: number): number {
    const t = this.total();
    return t ? Math.round((value / t) * 100) : 0;
  }
}
