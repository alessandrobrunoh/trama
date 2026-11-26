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
 * detection, billable rates), so this page shows what is real: the timer and the entries of the signed-in
 * person, and the two workspace settings the timesheet follows (week start, time zone), which are edited in
 * General.
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
      [description]="'Time is always logged by people. The timer runs on one task at a time, and an entry belongs to whoever logged it.'"
    >
      <a actions hlmBtn variant="outline" [routerLink]="['/', store.slug(), 'timer']">
        <svg [lucideIcon]="open" [size]="13"></svg>
        Open timesheet
      </a>
    </app-section-header>

    <app-stat-strip large [cells]="stats()" />

    <app-settings-block title="Timer" caption="this account">
      <app-settings-card>
        <app-card-row label="Running now" description="The timer runs on one task at a time; starting another stops it.">
          @if (timers.running()) {
            <span class="border-border text-foreground inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[11.5px]">
              <span class="bg-red size-1.5" aria-hidden="true"></span>
              {{ runningKey() ?? 'a timer' }}
            </span>
          } @else {
            <span class="border-border text-faint border px-2.5 py-1 font-mono text-[11.5px]">no timer</span>
          }
        </app-card-row>
        <app-card-row label="Entries logged" description="Finished entries of yours in this workspace.">
          <span class="text-foreground font-mono text-[12px] tabular-nums">{{ finished().length }}</span>
        </app-card-row>
        <app-card-row label="Time logged in total">
          <span class="text-foreground font-mono text-[12px] tabular-nums">{{ total() }}</span>
        </app-card-row>
      </app-settings-card>
    </app-settings-block>

    <app-settings-block title="Timesheet" caption="follows the workspace">
      <app-settings-card>
        <app-card-row label="Week starts on" description="Used by calendars, date pickers, cycles and the timesheet.">
          <span class="text-foreground font-mono text-[12px]">{{ weekStartLabel() }}</span>
        </app-card-row>
        <app-card-row label="Time zone" description="Entries are grouped by day in this zone.">
          <span class="text-foreground font-mono text-[12px]">{{ timeZone() }}</span>
        </app-card-row>
        <app-card-row label="Change them" description="Both are workspace settings, edited in General.">
          <a hlmBtn variant="outline" [routerLink]="['/', store.slug(), 'settings', 'workspace']">Open General</a>
        </app-card-row>
      </app-settings-card>
    </app-settings-block>
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
  protected readonly total = computed(() => {
    const ms = this.finished().reduce((sum, e) => sum + this.spanOf(e), 0);
    return this.finished().length ? formatSpan(ms) : '—';
  });
  protected readonly weekStartLabel = computed(() => {
    const w = this.store.settings().weekStart;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  protected readonly timeZone = computed(() => this.store.settings().timeZone);

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
      { label: 'Entries logged', value: String(this.finished().length), note: 'yours, all time' },
      { label: 'Logged in total', value: this.total(), note: 'yours, all time' },
    ];
  });

  constructor() {
    void this.timers.load();
  }
}
