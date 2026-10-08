import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Popover-style readout positioned inside a `position: relative` chart wrapper.
 * It flips to the left of the pointer once the pointer passes the middle of the wrapper.
 */
@Component({
  selector: 'app-chart-tip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'bg-popover text-popover-foreground border-border pointer-events-none absolute z-20 min-w-36 max-w-64 rounded-md border px-2.5 py-2 text-xs shadow-md',
    '[style.left.px]': 'x()',
    '[style.top.px]': 'y()',
    '[style.transform]': 'transform()',
    role: 'tooltip',
  },
  template: `<ng-content />`,
})
export class ChartTip {
  /** Anchor, in wrapper pixels. */
  readonly x = input.required<number>();
  readonly y = input<number>(0);
  /** Wrapper width, to decide on which side of the pointer the tip sits. */
  readonly bounds = input<number>(0);
  /** Sit above the anchor instead of beside it (for thin horizontal marks). */
  readonly above = input(false);
  protected readonly transform = computed(() => {
    const flip = this.bounds() > 0 && this.x() > this.bounds() / 2;
    return `translate(${flip ? 'calc(-100% - 14px)' : '14px'}, ${this.above() ? 'calc(-100% - 10px)' : '0'})`;
  });
}
