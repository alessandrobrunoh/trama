import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideCircleCheck, LucideDynamicIcon, LucideFlag } from '@lucide/angular';
import { format } from 'date-fns';
import { PreviewLink } from '../issues/list-preview';
import { OverviewLinks } from './overview-links';
import { plural, type FlowDay, type FlowEvent, type WeekTotal } from './overview-model';

/** Height of each half of the river, in px: tasks closed grow up from the axis, tasks opened grow down. */
const HALF = 46;
/** A day with any activity shows at least this much bar, so a single task is visible. */
const MIN_BAR = 3;

interface Column {
  day: FlowDay;
  up: number;
  down: number;
  event?: FlowEvent;
  label: string;
  title: string;
}

/**
 * The river: the last four weeks, one thin column per day. Above the axis the tasks closed that day (accent),
 * below it the tasks opened (neutral), on one shared scale, so a week where more was closed than opened reads as
 * a river running up. Milestones reached, milestones missed and projects completed are pinned above their day.
 * Hover or focus a day for the numbers; the same numbers are in a table for screen readers.
 */
@Component({
  selector: 'app-overview-river',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, PreviewLink],
  host: { class: 'block' },
  template: `
    <div class="text-meta mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span class="flex items-center gap-1.5"><span class="bg-primary size-2 rounded-[2px]"></span>Closed</span>
      <span class="flex items-center gap-1.5"><span class="bg-muted-foreground/35 size-2 rounded-[2px]"></span>Opened</span>
      @if (hasEvents()) {
        <span class="flex items-center gap-1.5">
          <svg [lucideIcon]="flag" [size]="12" [strokeWidth]="2" style="color: var(--tone-green)"></svg>Reached
        </span>
        <span class="flex items-center gap-1.5">
          <svg [lucideIcon]="flag" [size]="12" [strokeWidth]="2" style="color: var(--tone-red)"></svg>Missed
        </span>
        <span class="flex items-center gap-1.5">
          <svg [lucideIcon]="check" [size]="12" [strokeWidth]="2" style="color: var(--tone-green)"></svg>Project completed
        </span>
      }
    </div>

    <div class="relative" (pointerleave)="hover.set(null)">
      <!-- pinned events -->
      <div class="grid h-5 grid-cols-[repeat(28,minmax(0,1fr))]">
        @for (c of columns(); track c.day.key; let i = $index) {
          <span class="flex items-center justify-center">
            @if (c.event; as e) {
              <a
                [appPreviewLink]="links.route(e.target)"
                (preview)="links.show(e.target)"
                (pointerenter)="hover.set(i)"
                (focus)="hover.set(i)"
                class="focus-visible:ring-ring/50 inline-flex rounded-sm outline-none focus-visible:ring-2"
                [attr.aria-label]="e.label"
              >
                <svg
                  [lucideIcon]="e.kind === 'project_done' ? check : flag"
                  [size]="14"
                  [strokeWidth]="2"
                  [style.color]="e.kind === 'milestone_missed' ? 'var(--tone-red)' : 'var(--tone-green)'"
                ></svg>
              </a>
            }
          </span>
        }
      </div>

      <!-- bars -->
      <div
        class="relative grid grid-cols-[repeat(28,minmax(0,1fr))]"
        [style.height.px]="HALF * 2"
        role="group"
        aria-label="Tasks closed and opened per day, last four weeks"
      >
        <span class="bg-border pointer-events-none absolute inset-x-0 h-px" [style.top.px]="HALF" aria-hidden="true"></span>
        @for (c of columns(); track c.day.key; let i = $index) {
          <div
            class="relative flex flex-col outline-none"
            [class.bg-hover]="c.day.weekend || hover() === i"
            [class.rounded-sm]="hover() === i"
            tabindex="0"
            [attr.aria-label]="c.title"
            (pointerenter)="hover.set(i)"
            (focus)="hover.set(i)"
            (blur)="hover.set(null)"
          >
            <span class="flex items-end justify-center" [style.height.px]="HALF">
              @if (c.up > 0) {
                <span class="bg-primary block w-[58%] max-w-3 rounded-t-[4px]" [style.height.px]="c.up"></span>
              }
            </span>
            <span class="flex items-start justify-center" [style.height.px]="HALF">
              @if (c.down > 0) {
                <span class="bg-muted-foreground/35 block w-[58%] max-w-3 rounded-b-[4px]" [style.height.px]="c.down"></span>
              }
            </span>
            @if (c.day.today) {
              <span class="bg-primary absolute -bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full" aria-hidden="true"></span>
            }
          </div>
        }

        @if (tip(); as t) {
          <div
            class="bg-popover text-popover-foreground border-border pointer-events-none absolute z-20 w-max max-w-56 rounded-md border px-2.5 py-2 text-xs shadow-md"
            [style.left]="'clamp(5.5rem, ' + t.left + '%, calc(100% - 5.5rem))'"
            style="top: -0.25rem; transform: translate(-50%, -100%)"
            role="tooltip"
          >
            <div class="text-muted-foreground mb-1">{{ t.date }}</div>
            <div class="flex items-center justify-between gap-6">
              <span class="flex items-center gap-1.5"><span class="bg-primary size-2 rounded-[2px]"></span>Closed</span>
              <span class="tabular-nums">{{ t.closed }}</span>
            </div>
            <div class="flex items-center justify-between gap-6">
              <span class="flex items-center gap-1.5"><span class="bg-muted-foreground/35 size-2 rounded-[2px]"></span>Opened</span>
              <span class="tabular-nums">{{ t.created }}</span>
            </div>
            @for (e of t.events; track e) {
              <div class="mt-1 border-t border-border pt-1">{{ e }}</div>
            }
          </div>
        }
      </div>

      <!-- week labels -->
      <div class="mt-3 grid grid-cols-4">
        @for (w of weeks(); track w.start.getTime()) {
          <div class="flex min-w-0 flex-col gap-0.5 pe-2 text-[11px] leading-4">
            <span class="text-muted-foreground">{{ w.current ? 'This week' : 'From ' + short(w.start) }}</span>
            <span class="tabular-nums"><span>{{ w.closed }}</span> closed<span class="text-muted-foreground"> · {{ w.created }} opened</span></span>
          </div>
        }
      </div>
    </div>

    <table class="sr-only">
      <caption>Tasks closed and opened per day, last four weeks</caption>
      <thead><tr><th>Day</th><th>Closed</th><th>Opened</th><th>Events</th></tr></thead>
      <tbody>
        @for (c of columns(); track c.day.key) {
          <tr><td>{{ c.day.key }}</td><td>{{ c.day.closed }}</td><td>{{ c.day.created }}</td><td>{{ eventsText(c.day) }}</td></tr>
        }
      </tbody>
    </table>
  `,
})
export class OverviewRiver {
  protected readonly links = inject(OverviewLinks);

  readonly days = input.required<readonly FlowDay[]>();
  readonly weeks = input.required<readonly WeekTotal[]>();

  protected readonly HALF = HALF;
  protected readonly flag = LucideFlag;
  protected readonly check = LucideCircleCheck;
  protected readonly hover = signal<number | null>(null);

  protected readonly hasEvents = computed(() => this.days().some((d) => d.events.length > 0));

  protected readonly columns = computed<Column[]>(() => {
    const days = this.days();
    const max = Math.max(1, ...days.map((d) => Math.max(d.created, d.closed)));
    const scale = (n: number): number => (n === 0 ? 0 : Math.max(MIN_BAR, Math.round((n / max) * (HALF - 2))));
    return days.map((day) => ({
      day,
      up: scale(day.closed),
      down: scale(day.created),
      event: day.events[0],
      label: format(day.date, 'EEE d MMM'),
      title: `${format(day.date, 'EEE d MMM')}: ${plural(day.closed, 'task')} closed, ${day.created} opened${this.eventsText(day) ? '. ' + this.eventsText(day) : ''}`,
    }));
  });

  protected readonly tip = computed(() => {
    const i = this.hover();
    const c = i === null ? undefined : this.columns()[i];
    if (!c || i === null) return null;
    return {
      left: ((i + 0.5) / this.columns().length) * 100,
      date: c.label,
      closed: c.day.closed,
      created: c.day.created,
      events: c.day.events.map((e) => e.label),
    };
  });

  protected short(d: Date): string {
    return format(d, 'd MMM');
  }

  protected eventsText(day: FlowDay): string {
    return day.events.map((e) => e.label).join(', ');
  }
}
