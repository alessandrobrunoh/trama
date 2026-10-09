import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ISSUE_KIND_META, TramaStore, PRIORITIES, PRIORITY_META, type EstimateScale, type IssueKind } from '../../core';
import { BarList, type BarRow } from './charts/bar-list';
import { ChartCard } from './charts/chart-card';
import { ColumnChart } from './charts/column-chart';
import { SERIES_COLORS } from './charts/chart-utils';
import { formatDuration, type Period } from './insights';
import { agingWip, throughput, type Lookup } from './perf';
import { PRIORITY_COLOR } from './stats-colors';
import type { WorkRec } from './work';

const AGING_ROWS = 12;

/** Issues scope additions that need start dates: aging work in progress, and throughput by kind or team. */
@Component({
  selector: 'app-issue-extras',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarList, ChartCard, ColumnChart],
  host: { class: 'grid gap-4 lg:grid-cols-3' },
  template: `
    <app-chart-card
      title="Aging work in progress"
      subtitle="In progress and in review, by days since work started"
      [empty]="aging().rows.length ? undefined : agingEmpty()"
      [note]="agingNote()"
    >
      <ul class="mb-2 flex flex-wrap gap-x-3 gap-y-1" aria-label="Priority colours">
        @for (p of priorities; track p.id) {
          <li class="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <span class="size-2 rounded-[2px]" [style.background]="p.color"></span>{{ p.label }}
          </li>
        }
      </ul>
      <app-bar-list [rows]="agingRows()" [interactive]="true" ariaLabel="Open work by days since it started" (rowClick)="open($event)" />
    </app-chart-card>

    <app-chart-card
      class="lg:col-span-2"
      title="Throughput"
      [subtitle]="'Issues completed per week, by ' + (by() === 'kind' ? 'type' : 'team')"
      [empty]="block().total ? undefined : 'Nothing completed in these weeks.'"
      note="Weeks are rolling 7-day windows ending today. The four largest groups get a colour; the rest are folded into Other."
    >
      <div class="mb-2 inline-flex rounded-md border p-0.5" role="group" aria-label="Group throughput by">
        @for (g of groups; track g.id) {
          <button
            type="button"
            class="h-6 rounded px-2.5 text-xs transition-colors"
            [class]="by() === g.id ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'"
            [attr.aria-pressed]="by() === g.id"
            (click)="by.set(g.id)"
          >
            {{ g.label }}
          </button>
        }
      </div>
      <app-column-chart [series]="block().series" [labels]="block().labels" [tooltipTitles]="block().titles" [stacked]="true" ariaLabel="Issues completed per week" />
    </app-chart-card>
  `,
})
export class IssueExtras {
  /** Already filtered by person and team. */
  readonly work = input.required<readonly WorkRec[]>();
  readonly period = input.required<Period>();
  readonly now = input.required<number>();
  readonly scale = input<EstimateScale>('fibonacci');

  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  protected readonly by = signal<'kind' | 'team'>('kind');
  protected readonly groups = [
    { id: 'kind', label: 'Type' },
    { id: 'team', label: 'Team' },
  ] as const;
  protected readonly priorities = PRIORITIES.map((id) => ({ id, label: PRIORITY_META[id].label, color: PRIORITY_COLOR[id] }));

  private readonly look: Lookup = {
    user: (id) => (id ? (this.store.getUser(id)?.name ?? 'Unknown') : 'Unassigned'),
    team: (id) => (id ? (this.store.getTeam(id)?.name ?? 'Unknown team') : 'No team'),
  };

  protected readonly aging = computed(() => agingWip(this.work(), this.now(), this.scale(), this.look));
  protected readonly agingRows = computed<BarRow[]>(() =>
    this.aging()
      .rows.slice(0, AGING_ROWS)
      .map((r) => ({
        key: r.id,
        label: r.title,
        hint: r.key,
        value: r.age,
        valueLabel: formatDuration(r.age),
        color: PRIORITY_COLOR[r.priority],
        detail: `${r.key} ${r.title}\n${PRIORITY_META[r.priority].label} priority · ${r.status.replace('_', ' ')} · ${r.estimateLabel} · ${r.assignee}`,
      })),
  );
  protected readonly agingEmpty = computed(() =>
    this.aging().noStart
      ? `Nothing in progress has a start date yet (${this.aging().noStart} issue${this.aging().noStart === 1 ? '' : 's'} predate start tracking).`
      : 'Nothing is in progress.',
  );
  protected readonly agingNote = computed(() => {
    const a = this.aging();
    const more = a.rows.length - AGING_ROWS;
    const parts = [more > 0 ? `${more} more not shown` : '', a.noStart ? `${a.noStart} in progress without a start date left out` : ''].filter(Boolean);
    return parts.length ? `${parts.join('. ')}.` : undefined;
  });

  protected readonly block = computed(() =>
    throughput(
      this.work(),
      this.period(),
      this.now(),
      this.by(),
      (k) => (this.by() === 'kind' ? (ISSUE_KIND_META[k as IssueKind]?.label ?? k) : this.look.team(k === 'none' ? undefined : k)),
      SERIES_COLORS.slice(0, 4),
      'var(--tone-neutral)',
    ),
  );

  protected open(row: BarRow): void {
    const key = row.hint;
    if (key) void this.router.navigate(['/', this.store.slug() ?? '', 'issues', key]);
  }
}
