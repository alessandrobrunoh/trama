import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NablaStore, type Workstream } from '../../core';
import { StatsBoard } from './stats-board';
import { workstreamStats } from './stats-model';

@Component({
  selector: 'app-ws-stats-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatsBoard],
  host: { class: 'block' },
  template: `
    <div class="px-4 py-5 sm:px-6">
      <app-stats-board [model]="model()" [scopes]="['issues', 'estimates']" />
    </div>
  `,
})
export class WsStatsTab {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  protected readonly model = computed(() => workstreamStats(this.store, this.ws().id));
}
