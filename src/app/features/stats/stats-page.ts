import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TramaStore } from '../../core';
import { PageHeader } from '../../shared/page-header';
import { StatsBoard } from './stats-board';
import { workspaceStats } from './stats-model';

/** Workspace statistics focused on issue demand, workspace health, contributors, and delivery context. */
@Component({
  selector: 'app-stats-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, StatsBoard],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header
      title="Statistics"
      description="Issue demand, workspace health, and contributor activity. Health signals are computed from the complete activity log."
    />
    <div class="mx-auto w-full max-w-[1320px] px-4 py-4 sm:px-6">
      <app-stats-board [model]="model()" [syncUrl]="true" [insights]="true" />
    </div>
  `,
})
export class StatsPage {
  private readonly store = inject(TramaStore);
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  protected readonly model = computed(() => workspaceStats(this.store));
}
