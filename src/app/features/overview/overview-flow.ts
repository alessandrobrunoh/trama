import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { BarList, type BarRow } from '../stats/charts/bar-list';
import { ChartCard } from '../stats/charts/chart-card';
import { TimeChart } from '../stats/charts/time-chart';
import { OverviewModel } from './overview-model';

/** Issue flow and open issue demand by team. */
@Component({
  selector: 'app-overview-flow',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCard, TimeChart, BarList],
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

      @if (m.teamBars().length > 1) {
        <app-chart-card title="Open issues by team" subtitle="Demand waiting on each team">
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

  protected openTeam(row: BarRow): void {
    if (row.key) void this.router.navigate(['/', this.m.slug(), 'issues'], { queryParams: { team: row.key } });
  }
}
