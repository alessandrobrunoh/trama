import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';
import { LucideDynamicIcon, type LucideIcon } from '@lucide/angular';

/**
 * One "label ⟷ value" line of a properties panel (sidebar of a detail screen).
 * Project the value (a Spartan select / popover trigger / plain text) as content; `icon` is a small muted
 * lucide glyph in front of the label. `compact` is the inspector density: a narrower label column (the glyph stays).
 *   <app-property-row label="Priority" [icon]="flag"><app-priority-icon priority="high" showLabel /></app-property-row>
 */
@Component({
  selector: 'app-property-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class: 'flex items-center gap-2 text-sm',
    '[class.min-h-8]': '!compact()',
    '[class.min-h-7]': 'compact()',
  },
  template: `
    <span
      class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs"
      [class.w-28]="!compact()"
      [class.w-[5.75rem]]="compact()"
    >
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
  readonly compact = input(false, { transform: booleanAttribute });
}
