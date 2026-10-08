import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { KpiTile } from '../stats/charts/kpi-tile';
import { OverviewModel } from './overview-model';

/** Five KPI tiles, 30-day window. Every tile links to the page that explains it. */
@Component({
  selector: 'app-overview-kpis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, KpiTile],
  host: { class: 'block' },
  template: `
    <ul class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Key numbers, last 30 days">
      @for (k of m.kpis(); track k.key; let last = $last) {
        <li class="flex min-w-0" [class.max-md:col-span-2]="last">
          <a
            [routerLink]="['/', m.slug(), ...k.link]"
            [queryParams]="k.query"
            class="focus-visible:ring-ring/50 flex min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-2 [&:hover>app-kpi-tile]:border-border-strong [&>app-kpi-tile]:flex-1 [&>app-kpi-tile]:transition-colors"
          >
            <app-kpi-tile [label]="k.label" [value]="k.value" [delta]="k.delta" [hint]="k.hint" [spark]="k.spark" [sparkColor]="k.sparkColor" />
          </a>
        </li>
      }
    </ul>
  `,
})
export class OverviewKpis {
  protected readonly m = inject(OverviewModel);
}
