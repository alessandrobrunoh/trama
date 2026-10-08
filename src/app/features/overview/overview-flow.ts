import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { StatusIcon } from '../../shared/status';
import { BarList, type BarRow } from '../stats/charts/bar-list';
import { ChartCard } from '../stats/charts/chart-card';
import { StackBar } from '../stats/charts/stack-bar';
import { TimeChart } from '../stats/charts/time-chart';
import { OverviewModel } from './overview-model';

/** Demand flow (issues opened vs closed), outcome mix (workstreams by status) and open demand by team. */
@Component({
  selector: 'app-overview-flow',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ChartCard, TimeChart, StackBar, BarList, StatusIcon],
  host: { class: 'block' },
  template: `
    <div class="grid gap-3 md:grid-cols-2">
      <app-chart-card title="Opened vs closed" [subtitle]="flow().subtitle" [note]="flow().note" [empty]="flow().empty">
        <app-time-chart
          [series]="flow().series"
          [labels]="flow().labels"
          [tooltipTitles]="flow().titles"
          mode="line"
          [height]="170"
          ariaLabel="Issues opened and closed per day, last 30 days"
        />
      </app-chart-card>

      <app-chart-card
        title="Workstream status"
        [subtitle]="m.statusTotal() + ' workstreams, outcomes by where they are'"
        [empty]="m.statusTotal() === 0 ? 'No workstreams yet.' : undefined"
      >
        <app-stack-bar [slices]="m.statusSlices()" [thickness]="12" />
        <ul class="mt-4 grid gap-0.5">
          @for (s of m.statusSlices(); track s.key) {
            <li>
              <a
                [routerLink]="['/', m.slug(), s.link]"
                [queryParams]="s.query"
                class="hover:bg-hover -mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors"
              >
                <app-status-icon entity="workstream" [status]="s.status" [size]="12" />
                <span class="text-muted-foreground min-w-0 flex-1 truncate">{{ s.label }}</span>
                <span class="font-medium tabular-nums">{{ s.value }}</span>
                <span class="text-meta w-9 text-end tabular-nums">{{ pct(s.value) }}%</span>
              </a>
            </li>
          }
        </ul>
      </app-chart-card>

      @if (m.teamBars().length > 1) {
        <app-chart-card class="md:col-span-2" title="Open issues by team" subtitle="Demand waiting on each team">
          <app-bar-list [rows]="m.teamBars()" [interactive]="true" ariaLabel="Open issues by team" (rowClick)="openTeam($event)" />
        </app-chart-card>
      }
    </div>
  `,
})
export class OverviewFlow {
  protected readonly m = inject(OverviewModel);
  private readonly router = inject(Router);
  protected readonly flow = this.m.flowChart;

  protected pct(value: number): number {
    const t = this.m.statusTotal();
    return t ? Math.round((value / t) * 100) : 0;
  }

  protected openTeam(row: BarRow): void {
    if (row.key) void this.router.navigate(['/', this.m.slug(), 'issues'], { queryParams: { team: row.key } });
  }
}
