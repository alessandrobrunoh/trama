// Side panel of the timeline: a workstream's key properties, dates, progress chart and milestones
// without leaving the roadmap.
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowUpRight, LucideDynamicIcon, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, type Workstream } from '../../core';
import { FullDatePipe } from '../../shared/pipes';
import { KeyChip } from '../../shared/key-chip';
import { PropertyRow } from '../../shared/property-row';
import { ProviderIcon } from '../../shared/provider-icon';
import { StatusIcon } from '../../shared/status';
import { isoFromDate } from '../milestones/milestone-actions';
import { ProgressChart } from '../milestones/progress-chart';
import { WsProjectMilestones } from '../milestones/ws-project-milestones';
import { Picker } from '../workstreams/picker';
import { WsActions } from '../workstreams/ws-actions';
import { issueCounts, statusOptions, userOptions } from '../workstreams/ws-model';
import { IssueProgress, WsDatePicker } from '../workstreams/ws-parts';

@Component({
  selector: 'app-timeline-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmTooltip,
    LucideDynamicIcon,
    FullDatePipe,
    KeyChip,
    PropertyRow,
    ProviderIcon,
    StatusIcon,
    Picker,
    IssueProgress,
    WsDatePicker,
    ProgressChart,
    WsProjectMilestones,
  ],
  host: { class: 'flex min-h-0 flex-col' },
  template: `
    @let w = ws();
    <header class="flex items-start gap-2 border-b px-4 py-3">
      <app-status-icon entity="workstream" [status]="w.status" [size]="16" class="mt-0.5" />
      <div class="min-w-0 flex-1">
        <app-key-chip [value]="w.key" />
        <a [routerLink]="['/', slug(), 'workstreams', w.key]" class="mt-0.5 block text-[15px] leading-snug font-semibold outline-none hover:underline focus-visible:underline">{{ w.title }}</a>
      </div>
      <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground -mr-1.5" aria-label="Close panel" (click)="closed.emit()">
        <svg [lucideIcon]="x" [size]="15"></svg>
      </button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex flex-col gap-0.5 px-4 py-3">
        <app-property-row label="Status">
          <app-picker variant="field" label="Status" [searchable]="false" [clearable]="!!w.statusOverride" clearLabel="Automatic (derived)" [disabled]="!canEdit()" [options]="statuses" [value]="[w.status]" (valueChange)="actions.setStatus([w], $any($event[0]) ?? null)" />
        </app-property-row>
        <app-property-row label="Accountable">
          <app-picker variant="field" label="Accountable" placeholder="Unassigned" [clearable]="true" clearLabel="Unassign" [disabled]="!canEdit()" [options]="users()" [value]="w.accountableUserId ? [w.accountableUserId] : []" (valueChange)="actions.setAccountable([w], $event[0] ?? null)" />
        </app-property-row>
        <app-property-row label="Start date">
          <app-ws-date-picker class="min-w-0 flex-1" label="Start date" triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm" [disabled]="!canEdit()" [value]="w.startDate" (dateChange)="setStart($event)">
            @if (w.startDate) { <span>{{ w.startDate | fullDate }}</span> } @else { <span class="text-muted-foreground">Not set · {{ w.createdAt | fullDate }}</span> }
          </app-ws-date-picker>
        </app-property-row>
        <app-property-row label="Target date">
          <app-ws-date-picker class="min-w-0 flex-1" label="Target date" triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm" [disabled]="!canEdit()" [value]="w.targetDate" (dateChange)="actions.setTargetDate([w], $event)">
            @if (w.targetDate) { <span>{{ w.targetDate | fullDate }}</span> } @else { <span class="text-muted-foreground">No date</span> }
          </app-ws-date-picker>
        </app-property-row>
        <app-property-row label="Issues">
          <span class="px-1.5"><app-issue-progress [done]="counts().issuesDone" [active]="counts().issuesActive" [total]="counts().issuesTotal" /></span>
        </app-property-row>
        @if (w.deltaThreadUrl && deltaEnabled()) {
          <app-property-row label="Delta thread">
            <a [href]="w.deltaThreadUrl" target="_blank" rel="noopener noreferrer" class="hover:bg-accent inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px]" hlmTooltip="Open Delta thread" position="bottom">
              <app-provider-icon provider="delta" [size]="14" />Open thread<svg [lucideIcon]="ext" [size]="12" class="text-muted-foreground"></svg>
            </a>
          </app-property-row>
        }
      </div>
      <div class="flex flex-col gap-5 border-t px-4 py-4">
        <section>
          <h3 class="mb-2 text-sm font-semibold">Progress</h3>
          <app-progress-chart [ws]="w" [height]="170" />
        </section>
        <app-ws-project-milestones [ws]="w" />
      </div>
    </div>
    <footer class="border-t px-4 py-2.5">
      <a hlmBtn size="sm" variant="outline" class="w-full" [routerLink]="['/', slug(), 'workstreams', w.key]">Open workstream</a>
    </footer>
  `,
})
export class TimelinePanel {
  private readonly store = inject(NablaStore);
  protected readonly deltaEnabled = computed(() => this.store.deltaThreads());
  protected readonly actions = inject(WsActions);
  readonly ws = input.required<Workstream>();
  readonly closed = output<void>();

  protected readonly x = LucideX;
  protected readonly ext = LucideArrowUpRight;
  protected readonly statuses = statusOptions();
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.canEditTeamWork(this.ws().ownerTeamId));
  protected readonly counts = computed(() => issueCounts(this.store.issuesByWorkstream().get(this.ws().id) ?? []));

  protected setStart(d: Date | null): void {
    void this.store.updateWorkstream(this.ws().id, { startDate: d ? isoFromDate(d) : null });
  }
}
