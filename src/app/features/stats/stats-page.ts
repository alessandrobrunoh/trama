import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideChartBar } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { usePageShortcuts } from '../../core';
import { AppSelect } from '../../shared/app-select';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { V3Segmented, type V3SegmentOption } from '../../shared/v3';
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
    HlmTooltip,
    PageHeader,
    EmptyState,
    AppSelect,
    V3Segmented,
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
    <div class="mx-auto w-full max-w-[1100px] px-4 pt-7 pb-10 sm:px-10">
      @if (!hasTasks()) {
        <app-empty-state
          [icon]="chartIcon"
          title="Nothing to chart yet"
          description="Statistics appear once the workspace has tasks."
        />
      } @else {
        <header class="mb-5 flex flex-col gap-1.5">
          <p class="text-faint font-mono text-[10.5px] leading-[14px]">WORKSPACE · {{ s.range().label.toUpperCase() }}</p>
          <h1 class="font-title text-foreground text-[34px] leading-[38px] tracking-[-0.5px]">Statistics</h1>
          <p class="text-muted-foreground max-w-[720px] text-[13.5px] leading-[21px]">
            What gets finished, what is open, where your time goes and how projects are doing.
          </p>
        </header>

        <div class="bg-background sticky top-0 z-10 -mx-4 mb-6 px-4 sm:-mx-10 sm:px-10">
          <div class="border-border scrollbar-none -mb-px flex gap-[22px] overflow-x-auto border-b" role="tablist" aria-label="Statistics sections">
            @for (t of tabs; track t; let i = $index) {
              <button
                type="button"
                role="tab"
                class="-mb-px flex flex-none items-start gap-1.5 border-b-2 pt-3 pb-2.5 text-[13px] leading-4 whitespace-nowrap outline-none focus-visible:underline"
                [class]="s.tab() === t ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent'"
                [attr.aria-selected]="s.tab() === t"
                [title]="hint[t] + ' (' + (i + 1) + ')'"
                (click)="s.setTab(t)"
              >
                {{ label[t] }}
              </button>
            }
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <v3-segmented aria-label="Period" [options]="periodOptions" [value]="s.periodId()" (valueChange)="s.setPeriod($event)" />
            @if (s.range().custom) {
              <div class="flex items-center gap-2 font-mono text-[11px]">
                <app-stats-date-field label="From" [value]="s.fromKey()" [max]="today()" (valueChange)="s.setRange($event, s.toKey())" />
                <span class="text-faint" aria-hidden="true">to</span>
                <app-stats-date-field label="To" [value]="s.toKey()" [max]="today()" (valueChange)="s.setRange(s.fromKey(), $event)" />
              </div>
            }
            <label class="text-faint flex items-center gap-2 font-mono text-[10.5px]">
              PROJECT
              <app-select size="sm" class="w-44" label="Project" [options]="s.projectOptions()" [value]="s.projectId() ?? 'all'" (valueChange)="s.setProject($event)" />
            </label>
            <label class="text-faint flex items-center gap-2 font-mono text-[10.5px]" hlmTooltip="A task in progress with no activity for this long is stale and is left out of every average">
              STALE AFTER
              <app-select size="sm" class="w-28" label="Stale after" [options]="s.idleOptions" [value]="'' + s.idleDays()" (valueChange)="s.setIdle($event)" />
            </label>
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
  protected readonly periodOptions: V3SegmentOption[] = PERIOD_CHOICES.map((p) => ({ value: p.id, label: p.label }));
  protected readonly hasTasks = computed(() => this.s.allIssues().length > 0);
  protected readonly today = computed(() => new Date(this.s.now()));

  private readonly _keys = usePageShortcuts(
    TABS.map((t, i) => ({ keys: String(i + 1), label: `${TAB_LABEL[t]} statistics`, run: () => this.s.setTab(t) })),
  );
}
