// The task inspector: the property column of the task page. Tabs: Details (property rows with icons, grouped),
// Subtasks (a collapsible tree) and Time (the timer).
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  LucideCircleDot,
  LucideCircleUserRound,
  LucideClock,
  LucideDynamicIcon,
  LucideExternalLink,
  LucideFlag,
  LucideFolder,
  LucideGauge,
  LucideListChecks,
  LucideMessageSquare,
  LucideShapes,
  LucideTag,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TimeEntriesStore, TramaStore, formatSpan } from '../../core';
import { EntityChip } from '../../shared/entity-chip';
import { InlineText } from '../../shared/inline-edit';
import { IssueKindLabel } from '../../shared/issue';
import { LabelPicker } from '../../shared/label-picker';
import { Picker } from '../../shared/picker';
import { projectOptions } from '../../shared/picker-options';
import { RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { IssueMilestoneProp } from '../milestones/milestone-chips';
import { IssueActions } from './issue-actions';
import { IssueExternalRef } from './issue-external-ref';
import { IssueLunagest } from './issue-lunagest';
import { SOURCE_LABEL, isClosedIssue, issueEstimateOptions, issueKindOptions } from './issue-model';
import { IssueProp } from './issue-prop';
import { IssueSection } from './issue-section';
import { IssueSubtasks } from './issue-subtasks';
import { IssueThreadLink } from './issue-thread-link';
import { TaskChildren } from './task-children';
import { TaskStatusWizard } from './task-status-wizard';
import { buildSubtree, percent } from './task-subtree-model';
import { TaskTime } from './task-time';
import { trackedOn } from './task-time-model';

export type InspectorTab = 'details' | 'subtasks' | 'time';

@Component({
  selector: 'app-task-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmTabsImports,
    HlmTooltip,
    LucideDynamicIcon,
    LabelPicker,
    Picker,
    InlineText,
    EntityChip,
    IssueKindLabel,
    PropertyRow,
    RelativeTimePipe,
    IssueMilestoneProp,
    IssueExternalRef,
    IssueLunagest,
    IssueProp,
    IssueSection,
    IssueSubtasks,
    IssueThreadLink,
    TaskStatusWizard,
    TaskTime,
  ],
  host: { class: 'block min-w-0' },
  template: `
    @if (issue(); as i) {
      <hlm-tabs [tab]="tab()" (tabActivated)="tab.set($any($event))" class="gap-0">
        <div class="border-border flex h-10 items-stretch border-b">
          <hlm-tabs-list variant="line" class="h-full w-auto justify-start gap-0.5 p-0 px-2" aria-label="Task inspector">
            <button hlmTabsTrigger="details" class="h-full flex-none px-2.5">Details</button>
            <button hlmTabsTrigger="subtasks" class="h-full flex-none px-2.5">
              Subtasks
              @if (subtasks().total > 0) {
                <span class="text-muted-foreground text-xs tabular-nums">{{ subtasks().total }}</span>
              }
            </button>
            <button hlmTabsTrigger="time" class="h-full flex-none px-2.5">
              Time
              @if (runningHere()) {
                <span class="bg-status-working size-1.5 rounded-full" aria-label="Timer running"></span>
              }
            </button>
          </hlm-tabs-list>
        </div>

        <div hlmTabsContent="details" class="flex flex-col gap-2 px-2 pt-2 pb-6">
          <!-- Where it stands -->
          <div class="flex flex-col">
            <app-property-row label="Status" [icon]="statusIcon" compact>
              <app-issue-prop [issue]="i" field="status" showLabel />
              @if (canEdit()) {
                <app-task-status-wizard class="ml-auto" variant="link" [issue]="i" />
              }
            </app-property-row>
            <app-property-row label="Priority" [icon]="priorityIcon" compact>
              <app-issue-prop [issue]="i" field="priority" showLabel />
            </app-property-row>
            <app-property-row label="Assignee" [icon]="assigneeIcon" compact>
              <app-issue-prop [issue]="i" field="assignee" showLabel />
              @if (canEdit() && store.me(); as me) {
                @if (i.assigneeId !== me.id) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs"
                    hlmTooltip="Assign to me · I"
                    (click)="actions.setAssignee([i.id], me.id)"
                  >
                    Me
                  </button>
                }
              }
            </app-property-row>
          </div>

          <!-- Planning -->
          <div class="border-border/60 flex flex-col border-t pt-2">
            <app-property-row label="Project" [icon]="projectIcon" compact>
              <app-picker
                variant="field"
                triggerClass="min-h-7 py-0.5"
                label="Project"
                placeholder="No project"
                [clearable]="true"
                clearLabel="Remove from project"
                [disabled]="!canEdit()"
                [options]="projects()"
                [value]="i.projectId ? [i.projectId] : []"
                (valueChange)="store.updateIssue(i.id, { projectId: $event[0] ?? null })"
              />
            </app-property-row>
            <app-issue-milestone-prop [issue]="i" />
            @if (showEstimate()) {
              <app-property-row label="Estimate" [icon]="estimateIcon" compact>
                <app-picker
                  variant="field"
                  triggerClass="min-h-7 py-0.5"
                  label="Estimate"
                  placeholder="No estimate"
                  [clearable]="true"
                  [clearAlways]="true"
                  clearLabel="No estimate"
                  [searchable]="false"
                  [disabled]="!canEdit()"
                  [options]="estimateOpts()"
                  [value]="i.estimate !== undefined && i.estimate !== null ? ['' + i.estimate] : []"
                  (valueChange)="setEstimate(i.id, $event[0])"
                />
              </app-property-row>
            }
            <app-property-row label="Labels" [icon]="labelIcon" compact>
              <app-label-picker
                scope="issue"
                triggerClass="min-h-7 py-0.5"
                [disabled]="!canEdit()"
                [value]="i.labels"
                (valueChange)="store.updateIssue(i.id, { labels: $event })"
              />
            </app-property-row>
          </div>

          <!-- How far along: tap a row to open its tab -->
          @if (subtasks().total > 0 || tracked().totalMs > 0 || runningHere()) {
            <div class="border-border/60 flex flex-col border-t pt-2">
              @if (subtasks().total > 0) {
                <app-property-row label="Subtasks" [icon]="subtasksIcon" compact>
                  <button
                    type="button"
                    class="hover:bg-hover focus-visible:ring-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[13px] outline-none focus-visible:ring-2"
                    aria-label="Open subtasks"
                    (click)="tab.set('subtasks')"
                  >
                    <span class="tabular-nums">{{ subtasks().done }}/{{ subtasks().total }}</span>
                    <span class="bg-foreground/10 h-1 min-w-6 flex-1 overflow-hidden rounded-full" aria-hidden="true">
                      <span class="bg-status-shipped block h-full rounded-full" [style.width.%]="subtasks().percent"></span>
                    </span>
                  </button>
                </app-property-row>
              }
              @if (tracked().totalMs > 0 || runningHere()) {
                <app-property-row label="Tracked" [icon]="trackedIcon" compact>
                  <button
                    type="button"
                    class="hover:bg-hover focus-visible:ring-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[13px] outline-none focus-visible:ring-2"
                    aria-label="Open time"
                    (click)="tab.set('time')"
                  >
                    <span class="tabular-nums">{{ tracked().totalMs ? span(tracked().totalMs) : '0m' }}</span>
                    @if (runningHere()) {
                      <span class="text-status-working flex items-center gap-1 text-xs">
                        <span class="bg-status-working size-1.5 rounded-full" aria-hidden="true"></span> running
                      </span>
                    } @else if (tracked().todayMs > 0) {
                      <span class="text-muted-foreground text-xs">{{ span(tracked().todayMs) }} today</span>
                    }
                  </button>
                </app-property-row>
              }
            </div>
          }

          <!-- Where the work happens -->
          <div class="border-border/60 flex flex-col border-t pt-2">
            <app-property-row label="Thread" [icon]="threadIcon" compact>
              <app-issue-thread-link class="min-w-0 flex-1" variant="row" [issue]="i" [canEdit]="canEdit()" />
              @if (!i.threadUrl && !canEdit()) {
                <span class="text-muted-foreground px-1.5 text-[13px]">—</span>
              }
            </app-property-row>
          </div>

          <!-- Everything else, out of the way -->
          <app-issue-section class="border-border/60 border-t pt-1.5" label="More" [summary]="'Updated ' + (i.updatedAt | relativeTime)">
            <app-property-row label="Type" [icon]="typeIcon" compact>
              <app-picker
                variant="bare"
                label="Type"
                [searchable]="false"
                [disabled]="!canEdit()"
                [options]="kindOpts"
                [value]="[i.kind]"
                triggerClass="h-7 px-1.5 text-[13px]"
                (valueChange)="actions.changeKind(i, $any($event[0]))"
              >
                <app-issue-kind [kind]="i.kind" showLabel />
              </app-picker>
            </app-property-row>
            <app-property-row label="Source" compact>
              <span class="px-1.5 text-[13px]">{{ sourceLabel() }}</span>
            </app-property-row>
            <app-property-row label="Reporter" compact>
              <app-inline-text
                class="min-w-0 flex-1"
                label="reporter"
                placeholder="Who reported it?"
                textClass="text-[13px]"
                [allowEmpty]="true"
                [value]="reporter()"
                [canEdit]="canEdit() && !i.reporterId"
                (save)="store.updateIssue(i.id, { reporterName: $event || null })"
              />
            </app-property-row>
            <app-property-row label="Link" compact>
              <app-inline-text
                class="min-w-0 flex-1"
                label="external link"
                placeholder="Paste a URL"
                textClass="text-[13px]"
                [allowEmpty]="true"
                [value]="i.externalUrl ?? ''"
                [canEdit]="canEdit()"
                (save)="saveUrl(i.id, $event)"
              />
              @if (i.externalUrl) {
                <a
                  [href]="i.externalUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label="Open external link"
                  hlmTooltip="Open link"
                >
                  <svg [lucideIcon]="openIcon" [size]="13"></svg>
                </a>
              }
            </app-property-row>
            <app-issue-external-ref [issue]="i" [canEdit]="canEdit()" />
            <app-property-row label="Duplicate" compact>
              @if (duplicate(); as dup) {
                <app-entity-chip type="issue" [ref]="dup.id" compact />
                @if (canEdit()) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground ml-auto"
                    aria-label="Clear duplicate"
                    hlmTooltip="Not a duplicate"
                    (click)="actions.clearDuplicate(i.id)"
                  >
                    <svg [lucideIcon]="xIcon" [size]="13"></svg>
                  </button>
                }
              } @else if (canEdit()) {
                <button
                  type="button"
                  class="text-muted-foreground hover:bg-hover hover:text-foreground h-7 min-w-0 truncate rounded-md px-1.5 text-left text-[13px] whitespace-nowrap"
                  (click)="actions.openPrompt('duplicate', [i.id])"
                >
                  Mark as duplicate…
                </button>
              } @else {
                <span class="text-muted-foreground px-1.5 text-[13px]">—</span>
              }
            </app-property-row>
            @if (duplicates().length) {
              <app-property-row label="Duplicates" compact>
                <span class="flex flex-wrap gap-1">
                  @for (d of duplicates(); track d.id) {
                    <app-entity-chip type="issue" [ref]="d.id" compact />
                  }
                </span>
              </app-property-row>
            }
          </app-issue-section>

          <app-issue-lunagest [issueId]="i.id" />
        </div>

        <div hlmTabsContent="subtasks" class="px-2 pt-2 pb-6">
          <app-issue-subtasks [issue]="i" />
          @if (subtasks().total === 0 && !store.allowed('createIssues')) {
            <p class="text-muted-foreground px-1 text-sm">No subtasks.</p>
          }
        </div>

        <div hlmTabsContent="time" class="px-3 pt-3 pb-6">
          <app-task-time [issue]="i" />
        </div>
      </hlm-tabs>
    }
  `,
})
export class TaskInspector {
  protected readonly store = inject(TramaStore);
  protected readonly actions = inject(IssueActions);
  private readonly time = inject(TimeEntriesStore);
  private readonly children = inject(TaskChildren);

  /** A task id or its key (`CORA-142`). */
  readonly idOrKey = input.required<string>();

  protected readonly tab = signal<InspectorTab>('details');

  protected readonly openIcon = LucideExternalLink;
  protected readonly xIcon = LucideX;
  protected readonly statusIcon = LucideCircleDot;
  protected readonly priorityIcon = LucideFlag;
  protected readonly assigneeIcon = LucideCircleUserRound;
  protected readonly projectIcon = LucideFolder;
  protected readonly estimateIcon = LucideGauge;
  protected readonly labelIcon = LucideTag;
  protected readonly subtasksIcon = LucideListChecks;
  protected readonly trackedIcon = LucideClock;
  protected readonly threadIcon = LucideMessageSquare;
  protected readonly typeIcon = LucideShapes;
  protected readonly kindOpts = issueKindOptions();

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly issue = computed(() => this.store.getIssue(this.idOrKey()));
  protected readonly canEdit = computed(() => this.store.can('member'));

  /** Everything below the task, at any depth: the count on the tab and the progress row. */
  protected readonly subtasks = computed(() => {
    const id = this.issue()?.id;
    if (!id) return { total: 0, done: 0, percent: 0 };
    const entries = this.store.settings().statuses.issue;
    const tree = buildSubtree(id, this.children.byParent(), (t) => isClosedIssue(t, entries));
    return { total: tree.total, done: tree.done, percent: percent(tree.done, tree.total) };
  });
  protected readonly tracked = computed(() => {
    const id = this.issue()?.id;
    return id ? trackedOn(this.time.entries(), id, Date.now()) : { todayMs: 0, totalMs: 0, runningMs: 0 };
  });
  protected readonly runningHere = computed(() => {
    const id = this.issue()?.id;
    return !!id && this.time.running()?.issueId === id;
  });
  protected readonly duplicate = computed(() => {
    const id = this.issue()?.duplicateOfId;
    return id ? this.store.issueById().get(id) : undefined;
  });
  /** Issues marked as duplicates of this one. */
  protected readonly duplicates = computed(() => {
    const id = this.issue()?.id;
    return id ? this.store.issues().filter((i) => i.duplicateOfId === id) : [];
  });
  protected readonly sourceLabel = computed(() => SOURCE_LABEL[this.issue()?.source ?? ''] ?? '');
  protected readonly reporter = computed(() => {
    const i = this.issue();
    if (!i) return '';
    return i.reporterId
      ? (this.store.getUser(i.reporterId)?.name ?? i.reporterName ?? '')
      : (i.reporterName ?? '');
  });
  protected readonly projects = computed(() => projectOptions(this.store, this.issue()?.projectId));
  /** Estimates are off in this workspace, but an issue that still has one keeps showing it. */
  protected readonly showEstimate = computed(
    () => this.store.estimateScale() !== 'none' || this.issue()?.estimate !== undefined,
  );
  protected readonly estimateOpts = computed(() =>
    issueEstimateOptions(this.issue()?.estimate, this.store.estimateScale()),
  );

  constructor() {
    void this.time.load();
  }

  protected span(ms: number): string {
    return formatSpan(ms);
  }

  protected setEstimate(id: string, value: string | undefined): void {
    this.actions.setEstimate([id], value === undefined ? null : Number(value));
  }

  protected saveUrl(id: string, value: string): void {
    const v = value.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      void this.store.updateIssue(id, { externalUrl: `https://${v}` });
      return;
    }
    void this.store.updateIssue(id, { externalUrl: v || null });
  }
}
