// The shell of one filter chip, as in the v3 design: one hairline box, "Status  is not Merged" (muted
// property, then the operator and value). The owner projects the segments (each one its own trigger)
// and the chip turns blue while it narrows the list. A filter that is on can be removed with the small
// × that appears on the chip's corner on hover / focus.
// `CHIP_SEGMENT` is the class of one segment's button or span.
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';

/** Class of a segment (a button or a plain span) inside a chip. */
export const CHIP_SEGMENT =
  'flex h-full max-w-64 items-center gap-1.5 outline-none focus-visible:underline disabled:pointer-events-none';
/** A segment that opens something. */
export const CHIP_SEGMENT_BUTTON = `${CHIP_SEGMENT} hover:text-foreground aria-expanded:text-foreground`;

@Component({
  selector: 'app-filter-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class:
      'group/chip relative inline-flex h-[22px] shrink-0 items-center gap-1.5 border px-2 font-mono text-[11px] leading-[14px] whitespace-nowrap',
    '[class]': 'active() ? "border-delta-line/40 bg-delta-line/8" : "border-border"',
    '[attr.role]': '"group"',
    '[attr.aria-label]': 'label()',
  },
  template: `
    <ng-content />
    @if (removable()) {
      <button
        type="button"
        class="bg-secondary border-border-strong text-muted-foreground hover:text-foreground absolute -top-[7px] -right-[7px] z-[1] inline-flex size-3.5 items-center justify-center border opacity-0 outline-none group-focus-within/chip:opacity-100 group-hover/chip:opacity-100 focus-visible:opacity-100"
        [attr.aria-label]="'Remove ' + label() + ' filter'"
        (click)="removed.emit()"
      >
        <svg [lucideIcon]="xIcon" [size]="9"></svg>
      </button>
    }
  `,
})
export class FilterChip {
  /** Accessible name: "Status is any of 3 statuses". */
  readonly label = input.required<string>();
  /** The chip narrows the list: tinted blue. */
  readonly active = input(false);
  readonly removable = input(true);
  readonly removed = output<void>();

  protected readonly xIcon = LucideX;
}
