import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NablaStore } from '../../core';
import { PageHeader } from '../../shared/page-header';
import { StatsBoard } from './stats-board';
import { workspaceStats } from './stats-model';

/** Workspace-wide counts: workstreams, issues, artifacts, decisions. */
@Component({
  selector: 'app-stats-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, StatsBoard],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header
      title="Statistics"
      description="Demand, delivery, and how long work really takes. History-based charts use the activity currently loaded."
    />
    <div class="mx-auto w-full max-w-[1320px] px-4 py-4 sm:px-6">
      <app-stats-board [model]="model()" [syncUrl]="true" />
    </div>
  `,
})
export class StatsPage {
  private readonly store = inject(NablaStore);
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  protected readonly model = computed(() => workspaceStats(this.store));
}
