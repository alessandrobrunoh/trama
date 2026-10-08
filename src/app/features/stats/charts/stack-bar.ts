import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChartTip } from './chart-tip';
import type { ChartSlice } from './chart-utils';

/**
 * 100% stacked bar for a share of a whole. Segments touch through a 2px surface gap, the outer
 * ends are rounded, and each segment has its own tooltip. `legend` adds the count + share list.
 */
@Component({
  selector: 'app-stack-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartTip],
  host: { class: 'relative block min-w-0' },
  template: `
    <div class="flex w-full gap-0.5" [style.height.px]="thickness()" role="img" [attr.aria-label]="summary()" (pointerleave)="hover.set(null)">
      @for (s of live(); track s.key; let first = $first; let last = $last) {
        <span
          class="min-w-1 motion-safe:transition-opacity"
          [class.rounded-s-full]="first"
          [class.rounded-e-full]="last"
          [style.flex-grow]="s.value"
          [style.background]="s.color"
          [style.opacity]="hover() === null || hover()?.key === s.key ? 1 : 0.45"
          (pointermove)="move($event, s)"
        ></span>
      }
    </div>

    @if (legend()) {
      <ul class="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        @for (s of live(); track s.key) {
          <li class="flex items-center gap-1.5 text-xs">
            <span class="size-2 rounded-[2px]" [style.background]="s.color"></span>
            <span class="text-muted-foreground">{{ s.label }}</span>
            <span class="font-medium tabular-nums">{{ s.value }}</span>
            <span class="text-meta tabular-nums">{{ pct(s.value) }}%</span>
          </li>
        }
      </ul>
    }

    @if (hover(); as h) {
      <app-chart-tip [x]="h.x" [y]="0" [above]="true" [bounds]="width()">
        <div class="flex items-center gap-2">
          <span class="size-2 shrink-0 rounded-[2px]" [style.background]="h.color"></span>
          <span class="text-muted-foreground flex-1 truncate">{{ h.label }}</span>
          <span class="text-foreground font-medium tabular-nums">{{ h.value }}</span>
          <span class="text-muted-foreground tabular-nums">{{ pct(h.value) }}%</span>
        </div>
      </app-chart-tip>
    }
  `,
})
export class StackBar {
  readonly slices = input.required<readonly ChartSlice[]>();
  readonly thickness = input(10);
  readonly legend = input(false);

  protected readonly hover = signal<{ key: string; label: string; color: string; value: number; x: number } | null>(null);
  protected readonly width = signal(320);
  protected readonly live = computed(() => this.slices().filter((s) => s.value > 0));
  private readonly total = computed(() => this.live().reduce((n, s) => n + s.value, 0));
  protected readonly summary = computed(() => this.live().map((s) => `${s.label} ${s.value}`).join(', '));

  protected pct(value: number): number {
    const t = this.total();
    return t ? Math.round((value / t) * 100) : 0;
  }

  protected move(event: PointerEvent, s: ChartSlice): void {
    const host = (event.currentTarget as HTMLElement).parentElement?.parentElement;
    const rect = host?.getBoundingClientRect();
    if (!rect) return;
    this.width.set(rect.width);
    this.hover.set({ key: s.key, label: s.label, color: s.color, value: s.value, x: event.clientX - rect.left });
  }
}
