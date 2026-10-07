import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import type { Priority } from '../core/contracts/domain';

const LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
};
const BARS: Record<Priority, number> = { urgent: 3, high: 3, medium: 2, low: 1, none: 0 };
const COLOR: Record<Priority, string> = {
  urgent: 'text-priority-urgent',
  high: 'text-priority-high',
  medium: 'text-priority-medium',
  low: 'text-priority-low',
  none: 'text-priority-none',
};

/**
 * Priority glyph: three signal bars (urgent = filled warning square).
 *   <app-priority-icon [priority]="ws.priority" />   <app-priority-icon priority="high" showLabel />
 */
@Component({
  selector: 'app-priority-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex items-center gap-1.5 whitespace-nowrap',
    '[class]': 'color()',
    '[attr.role]': '"img"',
    '[attr.aria-label]': '"Priority: " + label()',
  },
  template: `
    @if (priority() === 'urgent') {
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor" />
        <rect x="7.25" y="4" width="1.5" height="5.5" rx="0.75" fill="var(--background)" />
        <rect x="7.25" y="10.75" width="1.5" height="1.5" rx="0.75" fill="var(--background)" />
      </svg>
    } @else {
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        @for (i of [0, 1, 2]; track i) {
          <rect
            [attr.x]="2 + i * 4.5"
            [attr.y]="10 - i * 3"
            width="3"
            [attr.height]="4 + i * 3"
            rx="0.8"
            fill="currentColor"
            [attr.opacity]="i < bars() ? 1 : 0.22"
          />
        }
      </svg>
    }
    @if (showLabel()) {
      <span class="text-foreground">{{ label() }}</span>
    }
  `,
})
export class PriorityIcon {
  readonly priority = input.required<Priority>();
  readonly showLabel = input(false, { transform: booleanAttribute });

  protected readonly label = computed(() => LABEL[this.priority()]);
  protected readonly color = computed(() => COLOR[this.priority()]);
  protected readonly bars = computed(() => BARS[this.priority()]);
}
