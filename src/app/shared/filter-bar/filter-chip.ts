// The shell of one filter chip: a hairline box of segments, "[icon Status] [is any of ▾] [3 statuses ▾] [×]".
// The owner projects the segments (each one its own trigger) and draws the chip amber while it narrows the
// list. `CHIP_SEGMENT` is the class of one segment's button; every segment after the first adds a hairline.
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';

/** Class of a segment (a button or a plain span) inside a chip. */
export const CHIP_SEGMENT =
  'flex h-full max-w-64 items-center gap-1.5 px-2 outline-none focus-visible:underline disabled:pointer-events-none';
/** A segment that opens something. */
export const CHIP_SEGMENT_BUTTON = `${CHIP_SEGMENT} hover:bg-hover aria-expanded:bg-hover`;

@Component({
  selector: 'app-filter-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class:
      'inline-flex h-[22px] shrink-0 items-stretch border font-mono text-[11px] leading-[13px] whitespace-nowrap',
    '[class]': 'active() ? "border-primary/40 bg-primary/10" : "border-border"',
    '[attr.role]': '"group"',
    '[attr.aria-label]': 'label()',
  },
  template: `
    <ng-content />
    @if (removable()) {
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground hover:bg-hover inline-flex w-5 items-center justify-center outline-none focus-visible:underline"
        [class]="active() ? 'border-primary/25 border-l' : 'border-border border-l'"
        [attr.aria-label]="'Remove ' + label() + ' filter'"
        (click)="removed.emit()"
      >
        <svg [lucideIcon]="xIcon" [size]="11"></svg>
      </button>
    }
  `,
})
export class FilterChip {
  /** Accessible name: "Status is any of 3 statuses". */
  readonly label = input.required<string>();
  /** The chip narrows the list: tinted amber. */
  readonly active = input(false);
  readonly removable = input(true);
  readonly removed = output<void>();

  protected readonly xIcon = LucideX;
}
