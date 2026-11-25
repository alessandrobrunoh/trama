// One v3 filter chip: "Status  is not Done" (mono 11px, hairline box). Idle chips read "Assignee  any";
// a chip that filters is tinted blue and can be removed. The trigger opens the menu template the owner passes.
import { ChangeDetectionStrategy, Component, input, output, type TemplateRef } from '@angular/core';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';

@Component({
  selector: 'app-filter-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDropdownMenuImports, LucideDynamicIcon],
  host: {
    class:
      'inline-flex h-[22px] shrink-0 items-stretch border font-mono text-[11px] leading-[13px] whitespace-nowrap',
    '[class]': 'active() ? "border-delta-line/40 bg-delta-line/8" : "border-border"',
  },
  template: `
    <button
      type="button"
      class="hover:bg-hover aria-expanded:bg-hover flex max-w-64 items-center gap-1.5 px-2 outline-none focus-visible:underline disabled:pointer-events-none"
      [hlmDropdownMenuTrigger]="menu()"
      [disabled]="disabled()"
      [attr.aria-label]="label() + ' ' + value()"
    >
      <span class="text-muted-foreground">{{ label() }}</span>
      <span class="text-foreground truncate">{{ value() }}</span>
    </button>
    @if (active() && removable() && !disabled()) {
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground hover:bg-hover inline-flex w-5 items-center justify-center outline-none focus-visible:underline"
        [attr.aria-label]="'Remove ' + label() + ' filter'"
        (click)="removed.emit()"
      >
        <svg [lucideIcon]="xIcon" [size]="11"></svg>
      </button>
    }
  `,
})
export class FilterChip {
  readonly label = input.required<string>();
  /** What the chip says it is filtering by: "any", "is not Done", "is In progress +1". */
  readonly value = input('any');
  /** The chip narrows the list: tinted blue. */
  readonly active = input(false);
  readonly removable = input(true);
  readonly disabled = input(false);
  /** The dropdown the trigger opens (an `<ng-template>` holding an `hlm-dropdown-menu`). */
  readonly menu = input.required<TemplateRef<unknown>>();
  readonly removed = output<void>();

  protected readonly xIcon = LucideX;
}
