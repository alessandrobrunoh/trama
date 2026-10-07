import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * One "label ⟷ value" line of a properties panel (sidebar of a detail screen).
 * Project the value (a Spartan select / popover trigger / plain text) as content.
 *   <app-property-row label="Priority"><app-priority-icon priority="high" showLabel /></app-property-row>
 */
@Component({
  selector: 'app-property-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-8 items-center gap-2 text-sm' },
  template: `
    <span class="text-muted-foreground w-28 shrink-0 truncate text-xs">{{ label() }}</span>
    <div class="flex min-w-0 flex-1 items-center gap-1.5"><ng-content /></div>
  `,
})
export class PropertyRow {
  readonly label = input.required<string>();
}
