import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TramaStore, UiStore, usePageShortcuts } from '../../core';
import { PageHeader } from '../../shared/page-header';
import { OnboardingChecklist } from '../onboarding/onboarding-checklist';
import { OverviewFlow } from './overview-flow';
import { OverviewGreeting } from './overview-greeting';
import { OverviewHealth } from './overview-health';
import { OverviewKpis } from './overview-kpis';
import { OverviewModel } from './overview-model';
import { OverviewNeedsYou } from './overview-needs-you';
import { OverviewRail } from './overview-rail';
import { OverviewUpcoming } from './overview-upcoming';

/**
 * Workspace at a glance. Top to bottom: greeting, 30-day KPIs, then a main column (what needs me,
 * what is at risk or due, workstream health, flow charts) beside a quiet rail (triage, shipped,
 * decisions, activity). Issues are demand; workstreams are outcomes; the page keeps them apart.
 */
@Component({
  selector: 'app-overview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, OnboardingChecklist, OverviewGreeting, OverviewKpis, OverviewNeedsYou, OverviewUpcoming, OverviewHealth, OverviewFlow, OverviewRail],
  providers: [OverviewModel],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header title="Overview" [description]="subtitle()" />

    <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-7 px-4 py-6 sm:px-8">
      @if (!store.ready()) {
        <div class="flex flex-col gap-6" aria-busy="true" aria-label="Loading overview">
          <div class="bg-foreground/[0.06] h-12 w-72 animate-pulse rounded-md"></div>
          <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
            @for (n of skeleton; track n) {
              <div class="bg-foreground/[0.05] h-28 animate-pulse rounded-lg"></div>
            }
          </div>
          <div class="bg-foreground/[0.04] h-64 animate-pulse rounded-lg"></div>
        </div>
      } @else {
        <app-overview-greeting />
        <app-onboarding-checklist />
        <app-overview-kpis />

        <div class="grid items-start gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div class="flex min-w-0 flex-col gap-10">
            <app-overview-needs-you />
            <app-overview-upcoming />
            <app-overview-health />
            <app-overview-flow />
          </div>
          <app-overview-rail />
        </div>
      }
    </div>
  `,
})
export class OverviewPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly model = inject(OverviewModel);
  protected readonly skeleton = [1, 2, 3, 4, 5];
  protected readonly subtitle = computed(() => this.model.subtitle());

  private readonly _keys = usePageShortcuts([
    { keys: 'c', label: 'New issue', group: 'Overview', run: () => this.store.allowed('createIssues') && this.ui.openCreate('issue') },
  ]);
}
