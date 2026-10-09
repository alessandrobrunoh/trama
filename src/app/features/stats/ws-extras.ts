import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { format } from 'date-fns';
import { TramaStore } from '../../core';
import { ChartCard } from './charts/chart-card';
import { ProgressChart } from '../milestones/progress-chart';
import { milestoneRows, type MilestoneRow, type MilestoneState } from './perf';
import type { WorkData } from './work';

const STATE_META: Record<MilestoneState, { label: string; cls: string; order: number }> = {
  overdue: { label: 'Overdue', cls: 'bg-tone-red/15 text-tone-red', order: 0 },
  at_risk: { label: 'At risk', cls: 'bg-tone-amber/15 text-tone-amber', order: 1 },
  on_track: { label: 'On track', cls: 'bg-tone-green/15 text-tone-green', order: 2 },
  no_date: { label: 'No target date', cls: 'bg-muted text-muted-foreground', order: 3 },
  empty: { label: 'No issues', cls: 'bg-muted text-muted-foreground', order: 4 },
  done: { label: 'Done', cls: 'bg-tone-green/15 text-tone-green', order: 5 },
};

/** Workstreams scope additions: a per-workstream burn-up (the milestones feature's chart) and the milestone completion table. */
@Component({
  selector: 'app-ws-extras',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ChartCard, ProgressChart],
  host: { class: 'flex flex-col gap-4' },
  template: `
    <app-chart-card
      title="Burn-up"
      [subtitle]="selected() ? selected()!.key + ' · scope, started and completed' : 'Pick a workstream'"
      [empty]="options().length ? undefined : 'No workstreams match the current filters.'"
    >
      <div class="mb-3">
        <label class="text-muted-foreground me-2 text-xs" for="burnup-ws">Workstream</label>
        <select
          id="burnup-ws"
          class="border-input bg-background h-7 max-w-full rounded-md border px-1.5 text-xs"
          (change)="pick.set($any($event.target).value)"
        >
          @for (w of options(); track w.id) {
            <option [value]="w.id" [selected]="w.id === selected()?.id">{{ w.key }} · {{ w.title }}</option>
          }
        </select>
      </div>

      @if (selectedWs(); as ws) {
        <app-progress-chart [ws]="ws" [height]="240" />
        <p class="text-meta mt-3 text-[11px]">Scope, started and completed are rebuilt from issue dates; issues without an estimate count as 1 point.</p>
      }
    </app-chart-card>

    <app-chart-card
      title="Milestones"
      subtitle="Completion and whether the target date is realistic"
      [empty]="rows().length ? undefined : 'No milestones on these workstreams. Add milestones to a workstream to see completion and projections.'"
      note="At risk: at the workstream's pace over the last 28 days the open issues finish after the target date (or nothing has been completed recently). Progress counts points when every issue is estimated, otherwise issues."
    >
      <div class="-mx-2 overflow-x-auto">
        <table class="w-full min-w-[640px] text-xs">
          <thead>
            <tr class="text-muted-foreground">
              <th class="px-2 py-1.5 text-start font-medium">Milestone</th>
              <th class="px-2 py-1.5 text-start font-medium">Project</th>
              <th class="px-2 py-1.5 text-start font-medium">Target</th>
              <th class="px-2 py-1.5 text-start font-medium">Progress</th>
              <th class="px-2 py-1.5 text-start font-medium">Projected</th>
              <th class="px-2 py-1.5 text-start font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            @for (m of rows(); track m.id) {
              <tr class="hover:bg-hover border-border/60 border-t" [attr.title]="m.detail">
                <td class="max-w-48 truncate px-2 py-1.5 font-medium">{{ m.name }}</td>
                <td class="px-2 py-1.5">
                  <a class="text-muted-foreground hover:text-foreground font-mono text-[11px] hover:underline" [routerLink]="['/', slug(), 'projects', m.projectId]">{{ m.projectName }}</a>
                </td>
                <td class="px-2 py-1.5 tabular-nums">{{ m.target ? fmt(m.target) : '—' }}</td>
                <td class="px-2 py-1.5">
                  <div class="flex items-center gap-2">
                    <span class="bg-muted relative h-1.5 w-24 overflow-hidden rounded-full" role="img" [attr.aria-label]="m.pct + '% done'">
                      <span class="absolute inset-y-0 start-0 rounded-full" [style.width.%]="m.pct" [style.background]="m.state === 'done' ? 'var(--status-shipped)' : 'var(--chart-1)'"></span>
                    </span>
                    <span class="tabular-nums">{{ m.pct }}%</span>
                    <span class="text-meta tabular-nums">{{ m.basis === 'points' ? m.done + '/' + m.total + ' pts' : m.done + '/' + m.total }}</span>
                  </div>
                </td>
                <td class="text-muted-foreground px-2 py-1.5 tabular-nums">{{ m.projected ? fmt(m.projected) : '—' }}</td>
                <td class="px-2 py-1.5">
                  <span class="inline-flex rounded px-1.5 py-0.5 font-medium" [class]="meta[m.state].cls">{{ meta[m.state].label }}</span>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </app-chart-card>
  `,
})
export class WsExtras {
  readonly data = input.required<WorkData>();
  /** Workstreams that pass the person/team filter; null = all. */
  readonly wsIds = input<ReadonlySet<string> | null>(null);
  readonly now = input.required<number>();

  private readonly store = inject(TramaStore);
  protected readonly meta = STATE_META;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly pick = signal<string | null>(null);

  protected readonly options = computed(() => {
    const ids = this.wsIds();
    return this.data()
      .workstreams.filter((w) => !ids || ids.has(w.id))
      .sort((a, b) => a.key.localeCompare(b.key));
  });
  protected readonly selected = computed<WorkData['workstreams'][number] | undefined>(() => {
    const opts = this.options();
    return opts.find((w) => w.id === this.pick()) ?? opts[0];
  });
  protected readonly selectedWs = computed(() => {
    const s = this.selected();
    return s ? this.store.workstreamById().get(s.id) : undefined;
  });

  protected readonly rows = computed<MilestoneRow[]>(() => {
    const ids = this.wsIds();
    return milestoneRows(this.data(), this.now())
      .filter((m) => !ids || m.workstreamIds.some((w) => ids.has(w)))
      .sort((a, b) => STATE_META[a.state].order - STATE_META[b.state].order || (a.target ?? Infinity) - (b.target ?? Infinity));
  });

  protected fmt(t: number): string {
    return format(t, 'MMM d, yyyy');
  }
}
