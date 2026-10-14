// Generic target-date editor with quick presets, a calendar and a clear action.
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCalendar } from '@spartan-ng/helm/calendar';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { TramaStore } from '../core';

/** Quick target-date choices ("end of this week" means the coming Friday). */
export const DATE_PRESETS: { label: string; at: () => Date }[] = [
  { label: 'Today', at: () => daysFromNow(0) },
  { label: 'Tomorrow', at: () => daysFromNow(1) },
  { label: 'End of this week', at: () => daysFromNow(daysUntilFriday()) },
  { label: 'In one week', at: () => daysFromNow(7) },
  { label: 'In two weeks', at: () => daysFromNow(14) },
  { label: 'In one month', at: () => daysFromNow(30) },
];

function daysUntilFriday(): number {
  const day = new Date().getDay();
  return day <= 5 ? 5 - day : 6;
}

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

@Component({
  selector: 'app-date-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmPopoverImports, HlmCalendar, HlmButtonImports],
  host: { class: 'inline-flex min-w-0' },
  template: `
    <hlm-popover [align]="align()" sideOffset="4" [state]="state()" (stateChanged)="state.set($event)">
      <button
        hlmPopoverTrigger
        type="button"
        class="focus-visible:ring-ring hover:bg-accent inline-flex min-w-0 items-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none"
        [class]="triggerClass()"
        [disabled]="disabled()"
        [attr.aria-label]="label()"
      >
        <ng-content />
      </button>
      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-fit gap-0 p-0">
        <div class="grid grid-cols-2 gap-0.5 border-b p-1">
          @for (p of presets; track p.label) {
            <button hlmBtn variant="ghost" size="xs" class="justify-start font-normal" (click)="pick(p.at())">{{ p.label }}</button>
          }
        </div>
        <hlm-calendar class="border-0" [date]="date()" [weekStartsOn]="store.weekStartsOn()" (dateChange)="pick($event)" />
        @if (value()) {
          <div class="border-t p-1">
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground w-full" (click)="pick(null)">Clear date</button>
          </div>
        }
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class DatePicker {
  protected readonly store = inject(TramaStore);
  readonly value = input<string | undefined>();
  readonly disabled = input(false);
  readonly label = input('Target date');
  readonly triggerClass = input('');
  readonly align = input<'start' | 'center' | 'end'>('start');
  readonly dateChange = output<Date | null>();

  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly date = computed(() => {
    const value = this.value();
    return value ? new Date(value) : undefined;
  });
  protected readonly presets = DATE_PRESETS;

  open(): void {
    if (!this.disabled()) this.state.set('open');
  }

  protected pick(date: Date | null | undefined): void {
    this.state.set('closed');
    this.dateChange.emit(date ?? null);
  }
}
