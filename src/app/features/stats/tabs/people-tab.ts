import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { format } from 'date-fns';
import { BarList, type BarRow } from '../charts/bar-list';
import { ChartCard } from '../charts/chart-card';
import { ColumnChart, type ColumnSeries } from '../charts/column-chart';
import { KpiTile } from '../charts/kpi-tile';
import { StatSection } from '../charts/stat-section';
import { REF_MIN } from '../flow-stats';
import { formatDuration } from '../insights';
import { completedInRange, cycleDays, durations, percentiles } from '../stats-flow';
import { UNASSIGNED, activityRows, closedByPersonPerBucket, personRows } from '../stats-people';
import { StatsScope } from '../stats-scope';

const PERSON_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'] as const;

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/** People: who has how much open work, who closed what, and the activity that is on record. */
@Component({
  selector: 'app-stats-people-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatSection, KpiTile, ChartCard, BarList, ColumnChart],
  host: { class: 'block' },
  template: `
    <app-stat-section
      title="Who has what"
      description="Load is the tasks in Todo, In progress and In review for each person: the backlog is nobody's load yet. Closed counts tasks moved to Done in the period ({{ s.range().label }}). Stale tasks (no activity for {{ s.idleDays() }} days) are listed next to the load and left out of every duration."
    >
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3" aria-label="Key figures">
        <li class="flex"><app-kpi-tile class="w-full" label="People with open work" [value]="'' + withLoad().length" [hint]="'of ' + people().length + ' with any task'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Closed" [value]="'' + closedTotal()" [hint]="s.range().label" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Closed most" [value]="top() ? top()!.label : '—'" [hint]="top() ? plural(top()!.closed, 'task') + ' closed' : 'nobody closed a task'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Median cycle time" [value]="median() === undefined ? '—' : days(median()!)" [hint]="'all tasks closed in the period'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Open work nobody owns" [value]="'' + unassigned()" [hint]="unassigned() ? 'todo or in progress, unassigned' : 'everything has an owner'" /></li>
      </ul>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="Open load per person"
          subtitle="Todo, in progress and in review. Hover a row for the split."
          [empty]="loadRows().length ? undefined : 'No open work is assigned to anyone.'"
        >
          <app-bar-list [rows]="loadRows()" ariaLabel="Open tasks per person" />
        </app-chart-card>
        <app-chart-card
          title="Closed per person"
          subtitle="Tasks moved to Done in the period."
          [empty]="closedRows().length ? undefined : 'No task was closed in this period.'"
        >
          <app-bar-list [rows]="closedRows()" ariaLabel="Tasks closed per person" />
        </app-chart-card>
        <app-chart-card
          [title]="'Closed per person per ' + s.bucketSet().unit"
          subtitle="The three people who closed most, everybody else together as Others."
          [empty]="closedRows().length ? undefined : 'No task was closed in this period.'"
          class="lg:col-span-2"
        >
          <app-column-chart [series]="closedSeries()" [labels]="labels()" [tooltipTitles]="titles()" [stacked]="true" ariaLabel="Tasks closed per person per bucket" />
        </app-chart-card>
        <app-chart-card
          title="Median cycle time per person"
          subtitle="Start to done for what each person closed. Grey bars come from fewer than three tasks."
          [empty]="cycleRows().length ? undefined : 'No task closed in this period has a start date.'"
        >
          <app-bar-list [rows]="cycleRows()" ariaLabel="Median cycle time per person" />
        </app-chart-card>
        <app-chart-card
          title="Recent activity"
          [subtitle]="'Comments, status changes, tasks created and review requests in the period. The project filter does not apply.'"
          [empty]="activityBars().length ? undefined : 'No comment, status change, new task or review request is on record in this period.'"
          [note]="eventsNote()"
        >
          <app-bar-list [rows]="activityBars()" ariaLabel="Recent activity per person" />
        </app-chart-card>
      </div>
    </app-stat-section>
  `,
})
export class PeopleTab {
  protected readonly s = inject(StatsScope);
  protected readonly plural = plural;
  protected readonly days = (d: number): string => formatDuration(d);

  protected readonly people = computed(() =>
    personRows(this.s.issues(), this.s.range(), (id) => this.s.personName(id), (i) => this.s.staleIds().has(i.id)),
  );
  protected readonly withLoad = computed(() => this.people().filter((p) => p.load > 0 && p.key !== UNASSIGNED));
  protected readonly closedTotal = computed(() => this.people().reduce((n, p) => n + p.closed, 0));
  protected readonly top = computed(() => [...this.people()].filter((p) => p.closed > 0 && p.key !== UNASSIGNED).sort((a, b) => b.closed - a.closed)[0]);
  protected readonly median = computed(() => percentiles(durations(completedInRange(this.s.issues(), this.s.range()), cycleDays)).median);
  protected readonly unassigned = computed(() => this.people().find((p) => p.key === UNASSIGNED)?.load ?? 0);

  protected readonly loadRows = computed<BarRow[]>(() =>
    this.people()
      .filter((p) => p.load > 0)
      .map((p) => ({
        key: p.key,
        label: p.label,
        hint: p.stale ? `${p.stale} stale` : undefined,
        value: p.load,
        detail: `${p.label}: ${p.todo} todo, ${p.inProgress} in progress, ${p.inReview} in review${p.points ? ` · ${p.points} points` : ''}${p.stale ? ` · ${p.stale} stale` : ''}`,
        color: p.key === UNASSIGNED ? 'var(--status-draft)' : 'var(--chart-3)',
      })),
  );
  protected readonly closedRows = computed<BarRow[]>(() =>
    [...this.people()]
      .filter((p) => p.closed > 0)
      .sort((a, b) => b.closed - a.closed || a.label.localeCompare(b.label))
      .map((p) => ({
        key: p.key,
        label: p.label,
        value: p.closed,
        detail: `${p.label}: ${plural(p.closed, 'task')} closed`,
        color: p.key === UNASSIGNED ? 'var(--status-draft)' : 'var(--chart-1)',
      })),
  );
  protected readonly cycleRows = computed<BarRow[]>(() =>
    this.people()
      .filter((p) => p.medianCycle !== undefined)
      .sort((a, b) => b.medianCycle! - a.medianCycle!)
      .map((p) => ({
        key: p.key,
        label: p.label,
        hint: plural(p.closed, 'task'),
        value: p.medianCycle!,
        valueLabel: formatDuration(p.medianCycle!),
        detail: `${p.label}: median ${formatDuration(p.medianCycle!)} over ${plural(p.closed, 'closed task')}${p.closed < REF_MIN ? ` (fewer than ${REF_MIN}: treat with care)` : ''}`,
        color: p.closed < REF_MIN ? 'var(--status-draft)' : 'var(--chart-2)',
      })),
  );

  // ── per bucket
  private readonly items = computed(() => this.s.bucketSet().items);
  protected readonly labels = computed(() => this.items().map((b) => b.label));
  protected readonly titles = computed(() => this.items().map((b) => b.title));
  protected readonly closedSeries = computed<ColumnSeries[]>(() =>
    closedByPersonPerBucket(this.s.issues(), this.items(), this.s.range(), (id) => this.s.personName(id)).map((p, i) => ({
      key: p.key,
      label: p.label,
      values: p.values,
      color: p.key === 'others' || p.key === UNASSIGNED ? 'var(--status-draft)' : (PERSON_COLORS[i] ?? 'var(--status-draft)'),
    })),
  );

  // ── activity on record
  private readonly activity = computed(() =>
    activityRows(this.s.store.events(), this.s.range(), (e) => (e.actor.type === 'system' ? 'System' : this.s.store.actorName(e.actor))),
  );
  protected readonly activityBars = computed<BarRow[]>(() =>
    this.activity().map((a) => ({
      key: a.key,
      label: a.label,
      value: a.total,
      detail: `${a.label}: ${a.comments} comments, ${a.statusChanges} status changes, ${a.created} tasks created, ${a.reviews} review requests`,
      color: 'var(--chart-4)',
    })),
  );
  protected readonly eventsNote = computed(() => {
    const events = this.s.store.events();
    if (!events.length) return undefined;
    const oldest = events.reduce((min, e) => (e.at < min ? e.at : min), events[0].at);
    return `Based on the ${events.length} most recent events on record, back to ${format(new Date(oldest), 'MMM d, yyyy')}. Older activity is not counted.`;
  });
}
