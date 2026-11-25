import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { format, parseISO, startOfDay } from 'date-fns';
import { BarList, type BarRow } from '../charts/bar-list';
import { ChartCard } from '../charts/chart-card';
import type { ChartSeries } from '../charts/chart-utils';
import { ColumnChart, type ColumnSeries } from '../charts/column-chart';
import { KpiTile } from '../charts/kpi-tile';
import { StatSection } from '../charts/stat-section';
import { TimeChart } from '../charts/time-chart';
import { ProjectGlyph } from '../../projects/project-glyph';
import { StatusBadge } from '../../../shared/status';
import { shortDate, type SignalKind } from '../../timeline/timeline-model';
import { ISSUE_COLOR } from '../stats-colors';
import {
  burnup,
  milestoneTotals,
  projectRows,
  scopeVsClosed,
  type MilestoneRow,
  type ProjectRow,
} from '../stats-projects';
import { StatsScope } from '../stats-scope';

const MILESTONES_SHOWN = 10;

const SIGNAL_COLOR: Record<SignalKind, string> = {
  on_track: 'var(--status-shipped)',
  at_risk: 'var(--status-needs-input)',
  off_track: 'var(--status-blocked)',
  not_enough_data: 'var(--status-draft)',
  no_target: 'var(--status-draft)',
  closed: 'var(--status-draft)',
};

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Projects: how far each one is, when it will end at its current pace (the same projection the Timeline page draws),
 * whether its milestones were hit, and how much work was added against how much was closed.
 */
@Component({
  selector: 'app-stats-projects-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, StatSection, KpiTile, ChartCard, TimeChart, ColumnChart, BarList, ProjectGlyph, StatusBadge],
  host: { class: 'block' },
  template: `
    <app-stat-section
      title="Project progress"
      description="Progress counts the tasks of each project that are done out of all its tasks, canceled ones left out. The projected end uses the pace of the last six weeks, the same as the Timeline page: with fewer than two tasks closed there is no projection and the project says so."
    >
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3" aria-label="Key figures">
        <li class="flex"><app-kpi-tile class="w-full" label="Running projects" [value]="'' + running()" [hint]="'of ' + rows().length + ' ' + (rows().length === 1 ? 'project' : 'projects')" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="On track" [value]="'' + count('on_track')" [hint]="count('at_risk') + ' at risk · ' + count('off_track') + ' off track'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Tasks closed" [value]="'' + closedTotal()" [hint]="s.range().label" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Scope added" [value]="'' + createdTotal()" [hint]="'tasks created, ' + s.range().label" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Milestones hit" [value]="'' + (totals().hit + totals().hitLate)" [hint]="totals().hitLate + ' of them late'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Milestones missed" [value]="'' + totals().missed" [hint]="totals().upcoming + ' still ahead'" /></li>
      </ul>

      <div class="border-border mt-4 border-t">
        @if (rows().length) {
          <ul>
            @for (r of rows(); track r.project.id) {
              <li class="border-border hover:bg-secondary flex flex-col gap-2 border-b px-1 py-3">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <a class="flex min-w-0 items-center gap-2 text-[13.5px] hover:underline" [routerLink]="['/', s.slug(), 'projects', r.project.id]">
                    <app-project-glyph [project]="r.project" [size]="15" />
                    <span class="truncate">{{ r.project.name }}</span>
                  </a>
                  <app-status-badge [status]="r.project.status" entity="project" />
                  <span class="text-muted-foreground ms-auto flex items-center gap-1.5 font-mono text-[10.5px]" [title]="r.forecast.explanation">
                    <span class="size-2" [style.background]="signalColor(r.forecast.signal)" aria-hidden="true"></span>
                    {{ r.forecast.label }}
                  </span>
                </div>
                <div class="flex items-center gap-3">
                  <div class="bg-secondary h-1.5 min-w-0 flex-1 overflow-hidden" role="progressbar" [attr.aria-valuenow]="pct(r)" aria-valuemin="0" aria-valuemax="100" [attr.aria-label]="r.project.name + ' progress'">
                    <div class="h-full" [style.width.%]="pct(r)" style="background: var(--status-shipped)"></div>
                  </div>
                  <span class="text-foreground w-32 shrink-0 text-end font-mono text-[10.5px] tabular-nums">{{ r.done }} / {{ r.total }} done · {{ pct(r) }}%</span>
                </div>
                <p class="text-faint flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10.5px]">
                  <span>{{ r.open }} open</span>
                  <span>{{ r.closed }} closed in the period</span>
                  <span>{{ r.created }} added</span>
                  <span>{{ pace(r) }}</span>
                  <span>{{ endText(r) }}</span>
                </p>
              </li>
            }
          </ul>
        } @else {
          <p class="text-muted-foreground border-border border-b px-4 py-8 text-center text-[13px]">No projects yet. Create a project and add tasks to follow its progress here.</p>
        }
      </div>
    </app-stat-section>

    <app-stat-section
      title="Scope and delivery"
      description="Scope is every task of the projects that is not canceled. When scope climbs faster than done, the finish line is moving away."
    >
      <div class="grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="Burn-up: scope against done"
          subtitle="All tasks of the projects, and how many of them are done, day by day."
          [empty]="burnEmpty() ? 'No project has tasks yet.' : undefined"
        >
          <app-time-chart [series]="burnSeries()" [labels]="timeLabels()" [tooltipTitles]="timeTitles()" ariaLabel="Burn-up of project scope and done tasks" />
        </app-chart-card>
        <app-chart-card
          [title]="'Scope added vs closed per ' + s.bucketSet().unit"
          subtitle="Tasks added to the projects against tasks closed from them."
          [empty]="scopeEmpty() ? 'No task was added to or closed from a project in this period.' : undefined"
        >
          <app-column-chart [series]="scopeSeries()" [labels]="labels()" [tooltipTitles]="titles()" ariaLabel="Scope added and closed per bucket" />
        </app-chart-card>
        <app-chart-card
          title="Closed per project"
          subtitle="Tasks closed in the period."
          [empty]="closedRows().length ? undefined : 'No task was closed in a project during this period.'"
        >
          <app-bar-list [rows]="closedRows()" ariaLabel="Tasks closed per project" />
        </app-chart-card>
        <app-chart-card
          title="Projected end against target"
          subtitle="Days between where each project will end at its current pace and its target date."
          [empty]="gapRows().length ? undefined : 'Needs a target date and at least two tasks closed in the last six weeks.'"
          note="Green is ahead of the target, red is behind it."
        >
          <app-bar-list [rows]="gapRows()" ariaLabel="Projected end against target per project" />
        </app-chart-card>
      </div>
    </app-stat-section>

    <app-stat-section
      title="Milestones"
      description="A milestone is hit when every task in it is done, on time when the last one was done by the target date. It is missed when the target date has passed with tasks still open."
    >
      <div class="border-border border-t">
        @if (milestones().length) {
          <ul>
            @for (m of shownMilestones(); track m.milestone.id) {
              <li class="border-border hover:bg-secondary flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-1 py-2.5 text-xs">
                <div class="min-w-0 flex-1 basis-48">
                  <p class="truncate text-[13px]">{{ m.milestone.name }}</p>
                  <p class="text-faint truncate font-mono text-[10.5px]">{{ s.projectName(m.milestone.projectId) }}</p>
                </div>
                <span class="flex items-center gap-1.5 font-mono text-[10.5px]">
                  <span class="size-2" [style.background]="stateColor(m)" aria-hidden="true"></span>
                  {{ stateText(m) }}
                </span>
                <span class="text-muted-foreground w-20 text-end font-mono text-[10.5px] tabular-nums">{{ m.done }} / {{ m.total }} done</span>
                <span class="text-muted-foreground w-24 text-end font-mono text-[10.5px] tabular-nums">{{ targetText(m) }}</span>
              </li>
            }
          </ul>
          @if (milestones().length > shownMilestones().length) {
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground w-full justify-start" (click)="allMilestones.set(true)">
              Show all {{ milestones().length }}
            </button>
          }
        } @else {
          <p class="text-muted-foreground border-border border-b px-4 py-8 text-center text-[13px]">No milestones yet. Add milestones with target dates to a project to see which ones were hit.</p>
        }
      </div>
    </app-stat-section>
  `,
})
export class ProjectsTab {
  protected readonly s = inject(StatsScope);
  protected readonly allMilestones = signal(false);

  protected readonly rows = computed<ProjectRow[]>(() => {
    const issuesBy = this.s.store.issuesByProject();
    const milestonesBy = this.s.store.milestonesByProject();
    return projectRows(
      this.s.projects(),
      (id) => issuesBy.get(id) ?? [],
      (id) => milestonesBy.get(id) ?? [],
      this.s.now(),
      this.s.range(),
    );
  });
  protected readonly running = computed(() => this.rows().filter((r) => r.project.status === 'in_progress').length);
  protected readonly closedTotal = computed(() => this.rows().reduce((n, r) => n + r.closed, 0));
  protected readonly createdTotal = computed(() => this.rows().reduce((n, r) => n + r.created, 0));
  protected count(kind: SignalKind): number {
    return this.rows().filter((r) => r.project.status !== 'completed' && r.project.status !== 'canceled' && r.forecast.signal === kind).length;
  }

  // ── milestones
  protected readonly milestones = computed<MilestoneRow[]>(() => {
    const order: Record<MilestoneRow['state'], number> = { missed: 0, upcoming: 1, no_date: 2, hit_late: 3, hit: 4, empty: 5 };
    return this.rows()
      .flatMap((r) => r.milestones)
      .sort((a, b) => order[a.state] - order[b.state] || (a.milestone.targetDate ?? '9').localeCompare(b.milestone.targetDate ?? '9'));
  });
  protected readonly shownMilestones = computed(() => (this.allMilestones() ? this.milestones() : this.milestones().slice(0, MILESTONES_SHOWN)));
  protected readonly totals = computed(() => milestoneTotals(this.milestones()));

  // ── charts
  private readonly projectIssues = computed(() => this.s.issues().filter((i) => !!i.projectId));
  private readonly items = computed(() => this.s.bucketSet().items);
  protected readonly labels = computed(() => this.items().map((b) => b.label));
  protected readonly titles = computed(() => this.items().map((b) => b.title));
  private readonly scope = computed(() => scopeVsClosed(this.projectIssues(), this.items()));
  protected readonly scopeEmpty = computed(() => this.scope().added.every((v) => v === 0) && this.scope().closed.every((v) => v === 0));
  protected readonly scopeSeries = computed<ColumnSeries[]>(() => [
    { key: 'added', label: 'Scope added', color: 'var(--chart-1)', values: this.scope().added },
    { key: 'closed', label: 'Closed', color: ISSUE_COLOR.done, values: this.scope().closed },
  ]);
  private readonly timesList = computed(() => this.s.times());
  protected readonly timeLabels = computed(() => this.timesList().map((t) => format(t, 'MMM d')));
  protected readonly timeTitles = computed(() => this.timesList().map((t) => format(t, 'EEE, MMM d')));
  private readonly burn = computed(() => burnup(this.projectIssues(), this.timesList(), this.s.now()));
  protected readonly burnEmpty = computed(() => this.burn().scope.every((v) => v === 0));
  protected readonly burnSeries = computed<ChartSeries[]>(() => [
    { key: 'scope', label: 'Scope', color: 'var(--chart-1)', values: this.burn().scope },
    { key: 'done', label: 'Done', color: ISSUE_COLOR.done, values: this.burn().done },
  ]);
  protected readonly closedRows = computed<BarRow[]>(() =>
    this.rows()
      .filter((r) => r.closed > 0)
      .sort((a, b) => b.closed - a.closed)
      .map((r) => ({
        key: r.project.id,
        label: r.project.name,
        project: r.project,
        value: r.closed,
        detail: `${r.project.name}: ${plural(r.closed, 'task')} closed, ${r.created} added`,
        color: r.project.color,
      })),
  );
  protected readonly gapRows = computed<BarRow[]>(() =>
    this.rows()
      .filter((r) => r.forecast.daysVsTarget !== undefined && r.project.status !== 'completed' && r.project.status !== 'canceled')
      .sort((a, b) => b.forecast.daysVsTarget! - a.forecast.daysVsTarget!)
      .map((r) => {
        const d = r.forecast.daysVsTarget!;
        const text = d === 0 ? 'on the target' : d > 0 ? `${plural(d, 'day')} late` : `${plural(-d, 'day')} early`;
        return {
          key: r.project.id,
          label: r.project.name,
          project: r.project,
          value: Math.abs(d),
          valueLabel: d === 0 ? '0d' : d > 0 ? `+${d}d` : `−${-d}d`,
          detail: `${r.project.name}: ends ${text}`,
          color: d > 0 ? 'var(--status-blocked)' : 'var(--status-shipped)',
        };
      }),
  );

  // ── words
  protected pct(r: ProjectRow): number {
    return r.total ? Math.round((r.done / r.total) * 100) : 0;
  }
  protected pace(r: ProjectRow): string {
    return r.forecast.closedInWindow ? `${+r.perWeek.toFixed(1)} closed per week` : 'no pace yet';
  }
  protected endText(r: ProjectRow): string {
    const now = new Date(this.s.now());
    const f = r.forecast;
    const target = r.project.targetDate ? shortDate(parseISO(r.project.targetDate), now) : undefined;
    const end = f.projectedEnd && f.signal !== 'closed' ? `ends ${shortDate(f.projectedEnd, now)}` : undefined;
    if (end && target) return `${end}, target ${target}`;
    if (end) return `${end}, no target`;
    return target ? `target ${target}` : 'no target date';
  }
  protected signalColor(signal: SignalKind): string {
    return SIGNAL_COLOR[signal];
  }
  protected stateColor(m: MilestoneRow): string {
    return m.state === 'hit' ? 'var(--status-shipped)' : m.state === 'missed' ? 'var(--status-blocked)' : m.state === 'hit_late' ? 'var(--status-needs-input)' : 'var(--status-draft)';
  }
  protected stateText(m: MilestoneRow): string {
    const d = m.daysAfterTarget;
    switch (m.state) {
      case 'hit':
        return 'Hit on time';
      case 'hit_late':
        return `Hit ${plural(d ?? 0, 'day')} late`;
      case 'missed':
        return `Missed, ${plural(d ?? 0, 'day')} overdue`;
      case 'upcoming':
        return d === undefined || d >= 0 ? 'Due today' : `Due in ${plural(-d, 'day')}`;
      case 'no_date':
        return 'No target date';
      default:
        return 'No tasks yet';
    }
  }
  protected targetText(m: MilestoneRow): string {
    return m.milestone.targetDate ? shortDate(startOfDay(parseISO(m.milestone.targetDate)), new Date(this.s.now())) : '';
  }
}
