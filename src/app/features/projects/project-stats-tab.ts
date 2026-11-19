import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideChartBar } from '@lucide/angular';
import { format } from 'date-fns';
import { TramaStore, type Project } from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { BarList, type BarRow } from '../stats/charts/bar-list';
import { ChartCard } from '../stats/charts/chart-card';
import type { ChartSeries } from '../stats/charts/chart-utils';
import { ColumnChart, type ColumnSeries } from '../stats/charts/column-chart';
import { KpiTile } from '../stats/charts/kpi-tile';
import { TimeChart } from '../stats/charts/time-chart';
import { ISSUE_COLOR } from '../stats/stats-colors';
import { isClosed } from './project-model';
import { projectStats, type ProjectStats } from './project-stats-model';

/**
 * Progress of a project in four plain panels: key numbers, burn-up, tasks completed per week with a finish
 * estimate, and milestones and open work per person. Everything is counted from the project's tasks and
 * milestones; no time is measured here (tracked time and estimates live on the Statistics page).
 */
@Component({
  selector: 'app-project-stats-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, KpiTile, ChartCard, TimeChart, ColumnChart, BarList],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-4 px-4 py-5 sm:px-6">
      @if (stats(); as s) {
        @if (s.kpis.total + s.kpis.canceled === 0) {
          <app-empty-state
            [icon]="chartIcon"
            title="No data to chart yet"
            description="Insights appear once tasks are planned under this project."
          />
        } @else {
          <section aria-label="Key numbers" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <app-kpi-tile label="Tasks" [value]="'' + s.kpis.total" [hint]="issuesHint()" />
            <app-kpi-tile
              label="Completed"
              [value]="'' + s.kpis.done"
              [hint]="s.kpis.percent + '% of scope'"
              [spark]="s.completedTrend"
              sparkColor="var(--status-shipped)"
            />
            <app-kpi-tile
              label="In progress"
              [value]="'' + s.kpis.active"
              [hint]="s.kpis.open + ' open in total'"
            />
            <app-kpi-tile label="Target date" [value]="targetValue()" [hint]="targetHint()" />
            <app-kpi-tile
              label="Pace"
              [value]="s.forecast.perWeek + '/wk'"
              hint="Tasks completed per week, last 4 weeks"
            />
            <app-kpi-tile label="Finish estimate" [value]="etaValue()" [hint]="etaHint()" />
          </section>

          <div class="grid gap-4">
            <app-chart-card
              title="Burn-up"
              subtitle="Scope, started and completed tasks over time; canceled tasks are not counted"
              [empty]="burnSeries().length ? undefined : 'Not enough history yet.'"
            >
              <app-time-chart
                mode="line"
                [series]="burnSeries()"
                [labels]="s.burnUp?.labels ?? []"
                [tooltipTitles]="s.burnUp?.titles"
                ariaLabel="Project burn-up: scope, started and completed tasks over time"
              />
            </app-chart-card>

          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <app-chart-card
              class="lg:col-span-2"
              title="Weekly velocity"
              subtitle="Tasks closed per week, with a 3-week average"
              [note]="forecastNote()"
              [empty]="s.velocity.length ? undefined : 'No task has been completed yet.'"
            >
              <app-column-chart
                [series]="velocitySeries()"
                [labels]="velocityLabels()"
                [tooltipTitles]="velocityTitles()"
                ariaLabel="Tasks closed per week"
              />
            </app-chart-card>

            <app-chart-card
              title="Milestones"
              subtitle="Completion per milestone"
              [empty]="milestoneRows().length ? undefined : 'This project has no milestones.'"
            >
              <app-bar-list
                [rows]="milestoneRows()"
                [max]="100"
                ariaLabel="Completion per milestone"
              />
            </app-chart-card>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <app-chart-card
              title="Open by assignee"
              subtitle="Workload on the open tasks"
              [empty]="assigneeRows().length ? undefined : 'No open tasks.'"
            >
              <app-bar-list
                [rows]="assigneeRows()"
                defaultColor="var(--chart-3)"
                ariaLabel="Open tasks by assignee"
              />
            </app-chart-card>
          </div>
        }
      }
    </div>
  `,
})
export class ProjectStatsTab {
  private readonly store = inject(TramaStore);

  readonly project = input.required<Project>();

  protected readonly chartIcon = LucideChartBar;

  protected readonly stats = computed<ProjectStats>(() => {
    const p = this.project();
    return projectStats({
      project: p,
      issues: this.store.issuesByProject().get(p.id) ?? [],
      milestones: this.store.milestonesByProject().get(p.id) ?? [],
      userName: (id) => this.store.getUser(id)?.name,
      weekStartsOn: this.store.weekStartsOn(),
      now: Date.now(),
    });
  });

  protected readonly issuesHint = computed(() => {
    const { canceled } = this.stats().kpis;
    return canceled ? `${canceled} canceled, not counted` : 'In scope';
  });

  protected readonly targetValue = computed(() => {
    const p = this.project();
    const { daysLeft } = this.stats().kpis;
    if (!p.targetDate) return '—';
    if (isClosed(p)) return format(new Date(p.targetDate), 'MMM d');
    if (daysLeft === undefined) return '—';
    const n = Math.abs(daysLeft);
    if (daysLeft < 0) return `${n}d over`;
    return daysLeft === 0 ? 'Today' : `${n}d left`;
  });

  protected readonly targetHint = computed(() => {
    const p = this.project();
    if (!p.targetDate) return 'No target date set';
    const date = format(new Date(p.targetDate), 'MMM d, yyyy');
    if (p.status === 'completed') return `Completed, target ${date}`;
    if (p.status === 'canceled') return `Canceled, target ${date}`;
    const { daysLeft } = this.stats().kpis;
    return daysLeft !== undefined && daysLeft < 0 ? `Overdue since ${date}` : `Due ${date}`;
  });

  protected readonly etaValue = computed(() => {
    const f = this.stats().forecast;
    if (f.kind === 'done') return 'Done';
    if (f.kind === 'no_pace' || f.etaAt === undefined) return '—';
    return format(new Date(f.etaAt), 'MMM d');
  });

  protected readonly etaHint = computed(() => {
    const f = this.stats().forecast;
    if (f.kind === 'done') return 'Nothing left open';
    if (f.kind === 'no_pace') return 'Nothing closed in the last 4 weeks';
    return this.versusTarget(f.daysVsTarget) ?? `${f.remaining} left at ${f.perWeek}/wk`;
  });

  protected readonly forecastNote = computed(() => {
    const f = this.stats().forecast;
    if (f.kind === 'done') return 'Every task in scope is closed.';
    if (f.kind === 'no_pace')
      return `${f.remaining} tasks are open, but none were closed in the last 4 weeks, so there is no pace to estimate from.`;
    const eta = f.etaAt === undefined ? '' : format(new Date(f.etaAt), 'MMM d, yyyy');
    const vs = this.versusTarget(f.daysVsTarget);
    return `At ${f.perWeek} tasks per week, the ${f.remaining} open tasks would be closed around ${eta}${vs ? ` (${vs})` : ''}. A straight-line estimate, not a commitment.`;
  });

  protected readonly burnSeries = computed<ChartSeries[]>(() => {
    const b = this.stats().burnUp;
    if (!b || b.labels.length < 2) return [];
    return [
      { key: 'scope', label: 'Scope', color: ISSUE_COLOR.backlog, values: b.scope },
      { key: 'started', label: 'Started', color: ISSUE_COLOR.in_progress, values: b.started },
      { key: 'completed', label: 'Completed', color: ISSUE_COLOR.done, values: b.completed },
    ];
  });

  protected readonly velocityLabels = computed(() => this.stats().velocity.map((w) => w.label));
  protected readonly velocityTitles = computed(() => this.stats().velocity.map((w) => w.title));
  protected readonly velocitySeries = computed<ColumnSeries[]>(() => {
    const weeks = this.stats().velocity;
    return [
      { key: 'done', label: 'Closed', color: ISSUE_COLOR.done, values: weeks.map((w) => w.done) },
      {
        key: 'avg',
        label: '3-week average',
        color: 'var(--chart-1)',
        type: 'line',
        values: weeks.map((w) => w.average),
      },
    ];
  });

  protected readonly milestoneRows = computed<BarRow[]>(() =>
    this.stats().milestones.map((m) => ({
      key: m.id,
      label: m.name,
      hint: m.targetDate ? format(new Date(m.targetDate), 'MMM d') : undefined,
      value: m.percent,
      valueLabel: `${m.percent}%`,
      detail: `${m.name}: ${m.done} of ${m.total} tasks done${m.late ? ', past its target date' : ''}`,
      color: m.late
        ? 'var(--status-blocked)'
        : m.percent === 100
          ? ISSUE_COLOR.done
          : 'var(--chart-1)',
    })),
  );

  protected readonly assigneeRows = computed<BarRow[]>(() =>
    this.stats().assignees.map((a) => ({
      key: a.key,
      label: a.label,
      value: a.value,
      detail: a.detail,
      color: a.key === 'unassigned' ? 'var(--status-draft)' : undefined,
    })),
  );

  private versusTarget(days: number | undefined): string | null {
    if (days === undefined) return null;
    if (days === 0) return 'on the target date';
    return `${Math.abs(days)}d ${days > 0 ? 'after' : 'before'} target`;
  }
}
