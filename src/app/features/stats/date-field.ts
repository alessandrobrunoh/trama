import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCalendar } from '@spartan-ng/helm/calendar';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { format } from 'date-fns';
import { TramaStore } from '../../core';
import { DATE_KEY } from './stats-range';

/** One day picked from a calendar: the From and To of a custom period. The value is `yyyy-MM-dd`. */
@Component({
  selector: 'app-stats-date-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmPopoverImports, HlmCalendar, HlmButtonImports],
  host: { class: 'inline-flex min-w-0' },
  template: `
    <hlm-popover sideOffset="4" align="start" [state]="state()" (stateChanged)="state.set($event)">
      <button hlmPopoverTrigger hlmBtn variant="outline" size="sm" type="button" class="max-sm:h-9 tabular-nums" [attr.aria-label]="label() + ': ' + text()">
        {{ text() }}
      </button>
      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-fit gap-0 p-0">
        <hlm-calendar class="border-0" [date]="date()" [max]="max()" [weekStartsOn]="store.weekStartsOn()" (dateChange)="pick($event)" />
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class StatsDateField {
  protected readonly store = inject(TramaStore);
  readonly label = input.required<string>();
  /** `yyyy-MM-dd`. */
  readonly value = input.required<string>();
  /** Latest pickable day. */
  readonly max = input<Date | undefined>(undefined);
  readonly valueChange = output<string>();

  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly date = computed(() => {
    const [y, m, d] = this.value().split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : undefined;
  });
  protected readonly text = computed(() => {
    const d = this.date();
    return d ? format(d, 'MMM d, yyyy') : 'Pick a day';
  });

  protected pick(date: Date | null | undefined): void {
    if (!date) return;
    this.state.set('closed');
    this.valueChange.emit(format(date, DATE_KEY));
  }
}
