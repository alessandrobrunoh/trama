import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ISSUE_KIND_META, PRIORITY_META, formatEstimate, formatSpan, type EstimateScale, type Priority } from '../../../core';
import { BarList, type BarRow } from '../charts/bar-list';
import { ChartCard } from '../charts/chart-card';
import { ColumnChart, type ColumnSeries } from '../charts/column-chart';
import { KpiTile } from '../charts/kpi-tile';
import { StatSection } from '../charts/stat-section';
import { TaskList, type TaskListRow } from '../charts/task-list';
import { isRunning, openByStatus } from '../flow-stats';
import { formatDuration } from '../insights';
import { ISSUE_COLOR, PRIORITY_COLOR } from '../stats-colors';
import { StatsScope } from '../stats-scope';
import { AGE_BINS, agingBuckets, isOpen, medianOpenAge, openBreakdown, subtaskDonePct, subtaskProgress } from '../stats-work';

const SHOWN_ROWS = 10;
const SUBTASK_ROWS = 8;

/** Work: what is open today, grouped six ways, how old it is, what is stale and how far subtasks are. */
@Component({
  selector: 'app-stats-work-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatSection, KpiTile, ChartCard, BarList, ColumnChart, TaskList],
  host: { class: 'block' },
  template: `
    <app-stat-section
      title="What is open right now"
      description="A snapshot of today, so the period does not apply here. Open means not done and not canceled, backlog included. A task is stale when it is In progress or In review and nothing has happened on it for {{ s.idleDays() }} days: no edit, comment, linked pull request or tracked time. Stale tasks are counted on their own and left out of every average."
    >
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3" aria-label="Key figures">
        <li class="flex"><app-kpi-tile class="w-full" label="Open tasks" [value]="'' + open().length" [hint]="openHint()" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="In progress" [value]="'' + running()" [hint]="running() ? 'including in review' : 'nothing is moving'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Stale tasks" [value]="'' + s.stale().length" [hint]="'no activity for ' + s.idleDays() + '+ days'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Median age" [value]="age() === undefined ? '—' : formatAge(age()!)" [hint]="ageHint()" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Unassigned" [value]="'' + unassigned()" [hint]="unassigned() ? 'open tasks nobody owns' : 'every open task has an owner'" /></li>
        <li class="flex"><app-kpi-tile class="w-full" label="Subtasks done" [value]="subtasks() ? subtasks()!.pct + '%' : '—'" [hint]="subtasks() ? subtasks()!.done + ' of ' + subtasks()!.total + ' subtasks' : 'no task has subtasks'" /></li>
      </ul>

      <div class="mt-4 grid gap-4 lg:grid-cols-3">
        <app-chart-card title="By status" subtitle="Where the open tasks stand, from backlog to in review." [empty]="open().length ? undefined : 'Nothing is open.'">
          <app-bar-list [rows]="statusRows()" ariaLabel="Open tasks by status" />
        </app-chart-card>
        <app-chart-card title="By priority" subtitle="How urgent the open tasks are." [empty]="open().length ? undefined : 'Nothing is open.'">
          <app-bar-list [rows]="priorityRows()" ariaLabel="Open tasks by priority" />
        </app-chart-card>
        <app-chart-card title="By kind" subtitle="Bugs, features, incidents and the rest." [empty]="open().length ? undefined : 'Nothing is open.'">
          <app-bar-list [rows]="kindRows()" ariaLabel="Open tasks by kind" />
        </app-chart-card>
        <app-chart-card
          title="By label"
          subtitle="A task with several labels counts under each."
          [empty]="labelRows().length ? undefined : open().length ? 'No open task has a label. Add labels to tasks to see this chart.' : 'Nothing is open.'"
          [note]="more(labelTotal())"
        >
          <app-bar-list [rows]="labelRows()" ariaLabel="Open tasks by label" />
        </app-chart-card>
        <app-chart-card title="By project" subtitle="Which projects hold the most open work." [empty]="open().length ? undefined : 'Nothing is open.'" [note]="more(projectTotal())">
          <app-bar-list [rows]="projectRows()" ariaLabel="Open tasks by project" />
        </app-chart-card>
        <app-chart-card title="By assignee" subtitle="Who the open tasks are assigned to." [empty]="open().length ? undefined : 'Nothing is open.'" [note]="more(assigneeTotal())">
          <app-bar-list [rows]="assigneeRows()" ariaLabel="Open tasks by assignee" />
        </app-chart-card>
      </div>
    </app-stat-section>

    <app-stat-section
      title="How old the open work is"
      description="Age is counted from the day a task was created. A long tail on the right is work that has been waiting for months."
    >
      <div class="grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="Age of open tasks"
          subtitle="Open tasks by how long ago they were created. Stale tasks have their own colour and are left out of the median."
          [empty]="open().length ? undefined : 'Nothing is open.'"
        >
          <app-column-chart [series]="agingSeries()" [labels]="ageLabels" [stacked]="true" ariaLabel="Open tasks by age" />
        </app-chart-card>
        <app-chart-card
          title="Stale tasks"
          [subtitle]="'In progress or in review with no activity for ' + s.idleDays() + ' days, longest idle first. Change the limit with “Stale after” above.'"
          [empty]="staleRows().length ? undefined : 'No task is stale. Everything that is in progress has been touched in the last ' + s.idleDays() + ' days.'"
        >
          <app-task-list [rows]="staleRows()" [slug]="s.slug()" ariaLabel="Stale tasks" />
        </app-chart-card>
      </div>
    </app-stat-section>

    <app-stat-section
      title="Subtasks"
      description="Parent tasks and how many of their subtasks, at any depth, are done. Canceled subtasks are left out."
    >
      <div class="grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="Subtask completion"
          subtitle="The parent tasks with the most subtasks still to do."
          [empty]="subtaskRows().length ? undefined : 'No task has subtasks yet. Add subtasks to a task to follow its progress here.'"
        >
          <app-bar-list [rows]="subtaskRows()" [max]="100" [interactive]="true" (rowClick)="openTask($event)" ariaLabel="Share of subtasks done per parent task" />
        </app-chart-card>
        <app-chart-card
          title="Open work by estimate"
          subtitle="How many open tasks carry each estimate. Tasks without one cannot be planned."
          [empty]="open().length ? undefined : 'Nothing is open.'"
        >
          <app-bar-list [rows]="estimateRows()" ariaLabel="Open tasks by estimate" />
        </app-chart-card>
      </div>
    </app-stat-section>
  `,
})
export class WorkTab {
  protected readonly s = inject(StatsScope);
  private readonly router = inject(Router);
  protected readonly ageLabels = AGE_BINS.map((b) => b.label);

  protected readonly open = computed(() => this.s.issues().filter(isOpen));
  protected readonly running = computed(() => this.s.issues().filter(isRunning).length);
  protected readonly unassigned = computed(() => this.open().filter((i) => !i.assigneeId).length);
  protected readonly subtasks = computed(() => subtaskDonePct(this.s.issues()));
  protected readonly age = computed(() => medianOpenAge(this.open(), this.s.now(), this.s.staleIds()));
  protected readonly ageHint = computed(() => {
    const n = this.s.staleIds().size;
    return n ? `of open tasks, ${n} stale left out` : 'of open tasks, since created';
  });
  protected readonly openHint = computed(() => {
    const points = this.open().reduce((n, i) => n + (i.estimate ?? 0), 0);
    return points ? `${points} estimate points` : 'backlog included';
  });

  // ── grouped
  protected readonly statusRows = computed<BarRow[]>(() =>
    openByStatus(this.s.issues(), (st) => this.s.statusLabel(st)).map((r) => ({
      key: r.key,
      label: r.label,
      status: r.key,
      value: r.count,
      detail: `${r.label}: ${r.count} ${r.count === 1 ? 'task' : 'tasks'}${r.points ? ` · ${r.points} points` : ''}`,
      color: ISSUE_COLOR[r.key as keyof typeof ISSUE_COLOR],
    })),
  );
  protected readonly priorityRows = computed<BarRow[]>(() => {
    const order = (k: string) => PRIORITY_META[k as keyof typeof PRIORITY_META]?.order ?? 9;
    return openBreakdown(this.s.issues(), (i) => [i.priority], (k) => PRIORITY_META[k as keyof typeof PRIORITY_META]?.label ?? k, 'No priority')
      .sort((a, b) => order(a.key) - order(b.key))
      .map((r) => ({
        key: r.key,
        label: r.label,
        priority: r.key as Priority,
        value: r.count,
        detail: `${r.label}: ${r.count} open ${r.count === 1 ? 'task' : 'tasks'}`,
        color: PRIORITY_COLOR[r.key as keyof typeof PRIORITY_COLOR],
      }));
  });
  protected readonly kindRows = computed<BarRow[]>(() =>
    openBreakdown(this.s.issues(), (i) => [i.kind], (k) => ISSUE_KIND_META[k as keyof typeof ISSUE_KIND_META]?.label ?? k, 'No kind').map((r) => ({
      key: r.key,
      label: r.label,
      value: r.count,
      detail: `${r.label}: ${r.count} open ${r.count === 1 ? 'task' : 'tasks'}`,
      color: 'var(--chart-1)',
    })),
  );
  private readonly labelAll = computed(() => {
    const labels = this.s.store.settings().labels;
    const rows = openBreakdown(this.s.issues(), (i) => i.labels, (id) => labels.find((l) => l.id === id)?.name ?? 'Unknown label', 'No label');
    return rows.every((r) => r.key === 'none') ? [] : rows;
  });
  protected readonly labelTotal = computed(() => this.labelAll().length);
  protected readonly labelRows = computed<BarRow[]>(() => {
    const labels = this.s.store.settings().labels;
    return this.labelAll().slice(0, SHOWN_ROWS).map((r) => ({
      key: r.key,
      label: r.label,
      value: r.count,
      detail: `${r.label}: ${r.count} open ${r.count === 1 ? 'task' : 'tasks'}`,
      color: r.key === 'none' ? 'var(--status-draft)' : (labels.find((l) => l.id === r.key)?.color ?? 'var(--chart-1)'),
    }));
  });
  private readonly projectAll = computed(() =>
    openBreakdown(this.s.issues(), (i) => (i.projectId ? [i.projectId] : []), (id) => this.s.projectName(id), 'No project'),
  );
  protected readonly projectTotal = computed(() => this.projectAll().length);
  protected readonly projectRows = computed<BarRow[]>(() =>
    this.projectAll().slice(0, SHOWN_ROWS).map((r) => ({
      key: r.key,
      label: r.label,
      project: this.s.store.getProject(r.key),
      value: r.count,
      detail: `${r.label}: ${r.count} open ${r.count === 1 ? 'task' : 'tasks'}${r.points ? ` · ${r.points} points` : ''}`,
      color: r.key === 'none' ? 'var(--status-draft)' : (this.s.store.getProject(r.key)?.color ?? 'var(--chart-1)'),
    })),
  );
  private readonly assigneeAll = computed(() =>
    openBreakdown(this.s.issues(), (i) => (i.assigneeId ? [i.assigneeId] : []), (id) => this.s.personName(id), 'Unassigned'),
  );
  protected readonly assigneeTotal = computed(() => this.assigneeAll().length);
  protected readonly assigneeRows = computed<BarRow[]>(() =>
    this.assigneeAll().slice(0, SHOWN_ROWS).map((r) => ({
      key: r.key,
      label: r.label,
      value: r.count,
      detail: `${r.label}: ${r.count} open ${r.count === 1 ? 'task' : 'tasks'}${r.points ? ` · ${r.points} points` : ''}`,
      color: r.key === 'none' ? 'var(--status-draft)' : 'var(--chart-3)',
    })),
  );
  protected readonly estimateRows = computed<BarRow[]>(() => {
    const counts = new Map<number | 'none', number>();
    for (const i of this.open()) counts.set(i.estimate ?? 'none', (counts.get(i.estimate ?? 'none') ?? 0) + 1);
    const scale = this.s.estimateScale();
    return [...counts.entries()]
      .sort((a, b) => (a[0] === 'none' ? 1 : b[0] === 'none' ? -1 : a[0] - b[0]))
      .map(([k, n]) => ({
        key: String(k),
        label: k === 'none' ? 'No estimate' : `${formatEstimateLabel(k, scale)}`,
        value: n,
        detail: `${k === 'none' ? 'No estimate' : formatEstimateLabel(k, scale)}: ${n} open ${n === 1 ? 'task' : 'tasks'}`,
        color: k === 'none' ? 'var(--status-draft)' : 'var(--chart-1)',
      }));
  });

  // ── age and stale
  protected readonly agingSeries = computed<ColumnSeries[]>(() => {
    const rows = agingBuckets(this.open(), this.s.now(), this.s.staleIds());
    return [
      { key: 'fresh', label: 'Not stale', color: 'var(--chart-1)', values: rows.map((r) => r.fresh) },
      { key: 'stale', label: 'Stale', color: 'var(--status-needs-input)', values: rows.map((r) => r.stale) },
    ];
  });
  protected readonly staleRows = computed<TaskListRow[]>(() =>
    this.s.stale().map(({ issue, idleMs }) => ({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
      detail: `${this.s.personName(issue.assigneeId)} · ${this.s.projectName(issue.projectId)}`,
      badge: `Idle ${formatSpan(idleMs)}`,
      tone: 'warn' as const,
    })),
  );

  // ── subtasks
  protected readonly subtaskRows = computed<BarRow[]>(() =>
    subtaskProgress(this.s.issues())
      .slice(0, SUBTASK_ROWS)
      .map(({ parent, done, total }) => ({
        key: parent.key,
        label: parent.title,
        value: Math.round((done / total) * 100),
        valueLabel: `${done}/${total}`,
        detail: `${parent.key} ${parent.title}: ${done} of ${total} subtasks done`,
        color: 'var(--status-shipped)',
      })),
  );

  protected formatAge(days: number): string {
    return formatDuration(days);
  }
  protected more(total: number): string | undefined {
    return total > SHOWN_ROWS ? `${total - SHOWN_ROWS} more not shown.` : undefined;
  }
  protected openTask(row: BarRow): void {
    if (row.key) void this.router.navigate(['/', this.s.slug(), 'tasks', row.key]);
  }
}

function formatEstimateLabel(value: number, scale: EstimateScale): string {
  const label = formatEstimate(value, scale);
  return /^[\d.]+$/.test(label) ? `${label} ${label === '1' ? 'point' : 'points'}` : label;
}
