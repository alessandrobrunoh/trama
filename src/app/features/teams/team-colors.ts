import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { LucideCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';

/**
 * Team colours. These are stored data (the `color` field of a Team, sent to the API), not UI tokens,
 * so the palette is a list of hex values. Muted Linear-style hues that read on light and dark.
 */
export const TEAM_COLORS: readonly { value: string; label: string }[] = [
  { value: '#6b7280', label: 'Grey' },
  { value: '#64748b', label: 'Slate' },
  { value: '#ef4444', label: 'Red' },
  { value: '#f97316', label: 'Orange' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#84cc16', label: 'Lime' },
  { value: '#22c55e', label: 'Green' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#0ea5e9', label: 'Sky' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#6366f1', label: 'Indigo' },
  { value: '#8b5cf6', label: 'Violet' },
  { value: '#d946ef', label: 'Fuchsia' },
  { value: '#ec4899', label: 'Pink' },
];

/**
 * Colour swatch that opens a palette popover (read-only dot when `canEdit` is false).
 *   <app-team-color-picker [color]="t.color" [canEdit]="canAdmin()" (colorChange)="save($event)" />
 */
@Component({
  selector: 'app-team-color-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmPopoverImports, HlmTooltip, LucideDynamicIcon],
  host: { class: 'inline-flex shrink-0' },
  template: `
    @if (canEdit()) {
      <hlm-popover align="start" sideOffset="6" [state]="state()" (stateChanged)="state.set($event)">
        <button
          hlmPopoverTrigger
          type="button"
          class="hover:bg-accent focus-visible:ring-ring flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
          hlmTooltip="Change colour"
          aria-label="Change team colour"
        >
          <span class="rounded-full" [style.width.px]="size()" [style.height.px]="size()" [style.background]="color()"></span>
        </button>
        <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-auto p-2">
          <div class="grid grid-cols-5 gap-1.5" role="listbox" aria-label="Team colour">
            @for (c of colors; track c.value) {
              <button
                type="button"
                role="option"
                class="ring-offset-popover focus-visible:ring-ring flex size-7 items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-offset-2"
                [style.background]="c.value"
                [attr.aria-selected]="same(c.value)"
                [attr.aria-label]="c.label"
                [hlmTooltip]="c.label"
                (click)="pick(c.value)"
              >
                @if (same(c.value)) {
                  <svg [lucideIcon]="check" [size]="14" [strokeWidth]="3" class="text-background"></svg>
                }
              </button>
            }
          </div>
        </hlm-popover-content>
      </hlm-popover>
    } @else {
      <span class="m-1 rounded-full" [style.width.px]="size()" [style.height.px]="size()" [style.background]="color()"></span>
    }
  `,
})
export class TeamColorPicker {
  readonly color = input.required<string>();
  readonly canEdit = input(false);
  readonly size = input(12);
  readonly colorChange = output<string>();

  protected readonly colors = TEAM_COLORS;
  protected readonly check = LucideCheck;
  protected readonly state = signal<'open' | 'closed'>('closed');

  protected same(value: string): boolean {
    return value.toLowerCase() === (this.color() ?? '').toLowerCase();
  }

  protected pick(value: string): void {
    this.state.set('closed');
    if (!this.same(value)) this.colorChange.emit(value);
  }
}
