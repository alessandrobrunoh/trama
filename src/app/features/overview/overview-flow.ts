import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartCard } from '../stats/charts/chart-card';
import { TimeChart } from '../stats/charts/time-chart';
import { OverviewModel } from './overview-model';

/** Issues opened and closed over the last 30 days. */
@Component({
  selector: 'app-overview-flow',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCard, TimeChart],
  host: { class: 'block' },
  template: `
    <app-chart-card title="Opened vs closed" [subtitle]="flow().subtitle" [note]="flow().note" [empty]="flow().empty">
      <app-time-chart
        [series]="flow().series"
        [labels]="flow().labels"
        [tooltipTitles]="flow().titles"
        mode="line"
        [height]="170"
        ariaLabel="Tasks opened and closed per day, last 30 days"
      />
    </app-chart-card>
  `,
})
export class OverviewFlow {
  private readonly m = inject(OverviewModel);
  protected readonly flow = this.m.flowChart;
}
