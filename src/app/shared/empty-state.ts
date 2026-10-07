import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LucideDynamicIcon, LucideInbox, type LucideIcon } from '@lucide/angular';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';

/**
 * Centered empty / zero state. Project buttons (Spartan `hlmBtn`) into the default slot.
 *   <app-empty-state [icon]="inboxIcon" title="Nothing needs you" description="You're all caught up.">
 *     <button hlmBtn size="sm">Create workstream</button>
 *   </app-empty-state>
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmEmptyImports, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    <div hlmEmpty class="py-12">
      <div hlmEmptyHeader>
        <div hlmEmptyMedia variant="icon">
          <svg [lucideIcon]="icon()" [size]="18" [strokeWidth]="1.5"></svg>
        </div>
        <div hlmEmptyTitle>{{ title() }}</div>
        @if (description()) {
          <div hlmEmptyDescription>{{ description() }}</div>
        }
      </div>
      <div hlmEmptyContent class="empty:hidden">
        <ng-content />
      </div>
    </div>
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly icon = input<LucideIcon>(LucideInbox);
}
