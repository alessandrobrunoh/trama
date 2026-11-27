import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowUpRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { formatSpan } from '../../../core/format';
import { TimeEntriesStore } from '../../../core/stores/time-entries.store';
import { TramaStore } from '../../../core/stores/trama.store';
import { SECTION_KIT, type StatCell } from './section-kit';

const DAY_MS = 86_400_000;
const WEEKDAY: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/**
 * Settings · Time tracking (v4 frame 08). Trama has no per-workspace timer options yet (rounding, idle
 * detection, billable rates), so this page only shows the stats that are real (this week, running now).
 */
@Component({
  selector: 'app-time-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Time tracking"
      description="Timers and timesheets. Time is always logged by people, one timer at a time."
    >
      <a actions hlmBtn variant="outline" [routerLink]="['/', store.slug(), 'timer']">
        <svg [lucideIcon]="open" [size]="13"></svg>
        Open timesheet
      </a>
    </app-section-header>

    <app-stat-strip large [cells]="stats()" />
  `,
})
export class TimeSection {
  protected readonly store = inject(TramaStore);
  protected readonly timers = inject(TimeEntriesStore);
  protected readonly open = LucideArrowUpRight;

  protected readonly runningKey = computed(() => {
    const id = this.timers.running()?.issueId;
    return id ? (this.store.getIssue(id)?.key ?? null) : null;
  });
  protected readonly finished = computed(() => this.timers.entries().filter((e) => !!e.endedAt));
  private readonly spanOf = (e: { startedAt: string; endedAt?: string | null }): number =>
    Date.parse(e.endedAt ?? e.startedAt) - Date.parse(e.startedAt);

  /** Midnight (local) of the day the current week started on, following the workspace's week start. */
  private readonly weekFrom = computed(() => {
    const now = new Date();
    const start = WEEKDAY[this.store.settings().weekStart] ?? 1;
    const back = (now.getDay() - start + 7) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - back * DAY_MS;
  });
  protected readonly stats = computed<StatCell[]>(() => {
    const from = this.weekFrom();
    const week = this.finished().filter((e) => Date.parse(e.startedAt) >= from);
    const weekMs = week.reduce((sum, e) => sum + this.spanOf(e), 0);
    const running = this.timers.running();
    return [
      { label: 'This week', value: week.length ? formatSpan(weekMs) : '—', note: `${week.length} ${week.length === 1 ? 'entry' : 'entries'}` },
      { label: 'Running now', value: running ? '1' : '0', note: running ? (this.runningKey() ?? 'a timer') : 'no timer' },
    ];
  });

  constructor() {
    void this.timers.load();
  }
}
