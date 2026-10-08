import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LucideDynamicIcon, type LucideIcon } from '@lucide/angular';

/**
 * One "label ⟷ value" line of a properties panel (sidebar of a detail screen).
 * Project the value (a Spartan select / popover trigger / plain text) as content; `icon` is a small muted
 * lucide glyph in front of the label.
 *   <app-property-row label="Priority" [icon]="flag"><app-priority-icon priority="high" showLabel /></app-property-row>
 */
@Component({
  selector: 'app-property-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'flex min-h-8 items-center gap-2 text-sm' },
  template: `
    <span class="text-muted-foreground flex w-28 shrink-0 items-center gap-1.5 text-xs">
      @if (icon(); as ic) {
        <svg [lucideIcon]="ic" [size]="13" [strokeWidth]="1.75" class="shrink-0 opacity-80" aria-hidden="true"></svg>
      }
      <span class="truncate">{{ label() }}</span>
    </span>
    <div class="flex min-w-0 flex-1 items-center gap-1.5"><ng-content /></div>
  `,
})
export class PropertyRow {
  readonly label = input.required<string>();
  readonly icon = input<LucideIcon | null>(null);
}
