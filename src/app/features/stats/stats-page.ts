import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideChartBar } from '@lucide/angular';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { usePageShortcuts } from '../../core';
import { AppSelect } from '../../shared/app-select';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { StatsDateField } from './date-field';
import { PERIOD_CHOICES } from './stats-range';
import { StatsScope, TABS, TAB_HINT, TAB_LABEL } from './stats-scope';
import { FlowTab } from './tabs/flow-tab';
import { PeopleTab } from './tabs/people-tab';
import { ProjectsTab } from './tabs/projects-tab';
import { TimeTab } from './tabs/time-tab';
import { WorkTab } from './tabs/work-tab';

/**
 * Workspace statistics in five tabs, each with its own link (`?tab=`): Flow, Work, Time, Projects and People.
 * One period, project and "stale after" choice applies to all of them. Every number comes from the pure functions in
 * `stats-*.ts`, and every chart repeats in plain words what it counts and what it leaves out.
 */
@Component({
  selector: 'app-stats-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [StatsScope],
  imports: [
    HlmTabsImports,
    HlmToggleGroupImports,
    HlmTooltip,
    PageHeader,
    EmptyState,
    AppSelect,
    StatsDateField,
    FlowTab,
    WorkTab,
    TimeTab,
    ProjectsTab,
    PeopleTab,
  ],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header
      title="Statistics"
      description="What gets finished, what is open, where your time goes and how projects are doing."
    />
    <div class="mx-auto w-full max-w-[1100px] px-4 pb-10 sm:px-6">
      @if (!hasTasks()) {
        <app-empty-state
          [icon]="chartIcon"
          title="Nothing to chart yet"
          description="Statistics appear once the workspace has tasks."
        />
      } @else {
        <div class="bg-background/90 sm:sticky sm:top-0 z-10 -mx-4 mb-6 px-4 backdrop-blur sm:-mx-6 sm:px-6">
          <hlm-tabs [tab]="s.tab()" (tabActivated)="s.setTab($event)">
            <div class="scrollbar-none overflow-x-auto">
              <hlm-tabs-list variant="line" class="h-9 w-max gap-1 p-0" aria-label="Statistics sections">
                @for (t of tabs; track t; let i = $index) {
                  <button [hlmTabsTrigger]="t" class="h-9 flex-none px-2.5 after:bottom-0" [hlmTooltip]="hint[t] + ' (' + (i + 1) + ')'" position="bottom">
                    {{ label[t] }}
                  </button>
                }
              </hlm-tabs-list>
            </div>
          </hlm-tabs>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
            <hlm-toggle-group type="single" variant="outline" size="sm" [value]="s.periodId()" (valueChange)="s.setPeriod($event)" aria-label="Period">
              @for (p of periods; track p.id) {
                <button hlmToggleGroupItem [value]="p.id" class="max-sm:h-9" [hlmTooltip]="p.long" position="bottom">{{ p.label }}</button>
              }
            </hlm-toggle-group>
            @if (s.range().custom) {
              <div class="flex items-center gap-2 text-xs">
                <app-stats-date-field label="From" [value]="s.fromKey()" [max]="today()" (valueChange)="s.setRange($event, s.toKey())" />
                <span class="text-muted-foreground" aria-hidden="true">to</span>
                <app-stats-date-field label="To" [value]="s.toKey()" [max]="today()" (valueChange)="s.setRange(s.fromKey(), $event)" />
              </div>
            }
            <label class="text-muted-foreground flex items-center gap-2 text-xs">
              Project
              <app-select size="sm" class="w-44" label="Project" [options]="s.projectOptions()" [value]="s.projectId() ?? 'all'" (valueChange)="s.setProject($event)" />
            </label>
            <label class="text-muted-foreground flex items-center gap-2 text-xs" hlmTooltip="A task in progress with no activity for this long is stale and is left out of every average">
              Stale after
              <app-select size="sm" class="w-28" label="Stale after" [options]="s.idleOptions" [value]="'' + s.idleDays()" (valueChange)="s.setIdle($event)" />
            </label>
            <span class="text-meta ms-auto text-xs">{{ s.range().label }}</span>
          </div>
        </div>

        <div role="tabpanel" [attr.aria-label]="label[s.tab()]">
          @switch (s.tab()) {
            @case ('flow') {
              <app-stats-flow-tab />
            }
            @case ('work') {
              <app-stats-work-tab />
            }
            @case ('time') {
              <app-stats-time-tab />
            }
            @case ('projects') {
              <app-stats-projects-tab />
            }
            @case ('people') {
              <app-stats-people-tab />
            }
          }
        </div>
      }
    </div>
  `,
})
export class StatsPage {
  protected readonly s = inject(StatsScope);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  protected readonly chartIcon = LucideChartBar;
  protected readonly tabs = TABS;
  protected readonly label = TAB_LABEL;
  protected readonly hint = TAB_HINT;
  protected readonly periods = PERIOD_CHOICES;
  protected readonly hasTasks = computed(() => this.s.allIssues().length > 0);
  protected readonly today = computed(() => new Date(this.s.now()));

  private readonly _keys = usePageShortcuts(
    TABS.map((t, i) => ({ keys: String(i + 1), label: `${TAB_LABEL[t]} statistics`, run: () => this.s.setTab(t) })),
  );
}
