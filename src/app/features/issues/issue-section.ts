import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { LucideChevronRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmCollapsibleImports } from '@spartan-ng/helm/collapsible';

/**
 * A collapsed-by-default group of the task inspector: one 28px header row (chevron, label and an optional
 * one-line summary on the right) that reveals its content in place.
 */
@Component({
  selector: 'app-issue-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCollapsibleImports, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    <div hlmCollapsible [expanded]="open()" (expandedChange)="open.set($event)">
      <button
        hlmCollapsibleTrigger
        type="button"
        class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex h-7 w-full items-center gap-1 rounded-md px-1 text-xs font-medium outline-none focus-visible:ring-2"
      >
        <svg
          [lucideIcon]="chevron"
          [size]="13"
          class="shrink-0 transition-transform"
          [class.rotate-90]="open()"
          aria-hidden="true"
        ></svg>
        <span>{{ label() }}</span>
        @if (summary(); as s) {
          <span class="ml-auto min-w-0 truncate pl-2 font-normal tabular-nums">{{ s }}</span>
        }
      </button>
      <div hlmCollapsibleContent class="pt-0.5 pb-1">
        <ng-content />
      </div>
    </div>
  `,
})
export class IssueSection {
  readonly label = input.required<string>();
  readonly summary = input('');
  readonly open = model(false);
  protected readonly chevron = LucideChevronRight;
}
