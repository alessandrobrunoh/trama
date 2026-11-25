import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { LucideChevronRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmCollapsibleImports } from '@spartan-ng/helm/collapsible';

/**
 * A collapsed-by-default group of the task inspector: one 32px header row (mono 10 label in capitals, chevron and
 * an optional one-line summary on the right) that reveals its content in place.
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
        class="text-faint hover:text-muted-foreground focus-visible:ring-ring flex h-8 w-full items-center gap-1.5 px-[18px] font-mono text-[10px] outline-none focus-visible:ring-2"
      >
        <svg
          [lucideIcon]="chevron"
          [size]="12"
          class="shrink-0 transition-transform"
          [class.rotate-90]="open()"
          aria-hidden="true"
        ></svg>
        <span>{{ label() }}</span>
        @if (summary(); as s) {
          <span class="ml-auto min-w-0 truncate pl-2 text-[10.5px] tabular-nums">{{ s }}</span>
        }
      </button>
      <div hlmCollapsibleContent class="px-3 pt-0.5 pb-2">
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
