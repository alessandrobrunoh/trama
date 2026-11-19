// The task inspector: the contextual right pane of a task. Tabs: Details (compact property rows), Subtasks and
// Time. `page` is the right pane of the task page; `preview` is what a list shows when a row is selected and
// adds the key, title, status and description on top plus an "Open" action.
import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideExternalLink, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore } from '../../core';
import { RightPaneTabs } from '../../layout/page-chrome';
import { EntityChip } from '../../shared/entity-chip';
import { InlineText } from '../../shared/inline-edit';
import { IssueKindLabel } from '../../shared/issue';
import { LabelPicker } from '../../shared/label-picker';
import { Markdown } from '../../shared/markdown';
import { Picker } from '../../shared/picker';
import { projectOptions } from '../../shared/picker-options';
import { RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { IssueMilestoneProp } from '../milestones/milestone-chips';
import { IssueActions } from './issue-actions';
import { IssueExternalRef } from './issue-external-ref';
import { IssueLunagest } from './issue-lunagest';
import { SOURCE_LABEL, issueEstimateOptions, issueKindOptions } from './issue-model';
import { IssueProp } from './issue-prop';
import { IssueSection } from './issue-section';
import { IssueTimeCard } from './issue-sidebar';
import { IssueSubtasks } from './issue-subtasks';
import { IssueThreadLink } from './issue-thread-link';

export type InspectorTab = 'details' | 'subtasks' | 'time';

/** The task the task page is showing right now (set by the page, read by the inspector in the right pane). */
@Injectable({ providedIn: 'root' })
export class TaskPageContext {
  readonly taskId = signal<string | null>(null);
}

@Component({
  selector: 'app-task-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmTabsImports,
    HlmTooltip,
    LucideDynamicIcon,
    RightPaneTabs,
    LabelPicker,
    Picker,
    InlineText,
    Markdown,
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
    IssueTimeCard,
  ],
  host: {
    class: 'block min-w-0',
    '[attr.data-mode]': 'effectiveMode()',
  },
  template: `
    @if (issue(); as i) {
      @if (effectiveMode() === 'preview') {
        <div class="px-4 pt-4">
          <div class="text-muted-foreground flex items-center gap-1.5 text-xs">
            <app-issue-kind [kind]="i.kind" [size]="13" />
            <span class="font-mono">{{ i.key }}</span>
            <a
              hlmBtn
              variant="ghost"
              size="sm"
              class="ml-auto"
              [routerLink]="['/', slug(), 'tasks', i.key]"
              [attr.aria-label]="'Open ' + i.key"
            >
              Open <svg [lucideIcon]="openIcon" [size]="13" aria-hidden="true"></svg>
            </a>
          </div>
          <h2 class="mt-1 text-base leading-snug break-words">{{ i.title }}</h2>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <app-issue-prop [issue]="i" field="status" showLabel />
            <app-issue-prop [issue]="i" field="priority" showLabel />
          </div>
          @if (i.body?.trim()) {
            <div class="mt-3 max-h-72 overflow-y-auto">
              <app-markdown [source]="i.body" />
            </div>
          }
        </div>
      }

      <hlm-tabs [tab]="tab()" (tabActivated)="tab.set($any($event))" class="gap-0">
        <!-- The tab strip lives in the right pane's header row (the shell shows this template there). -->
        <ng-template appRightPaneTabs>
          <hlm-tabs-list variant="line" class="h-full w-auto justify-start gap-0.5 p-0 px-2" aria-label="Task inspector">
            <button hlmTabsTrigger="details" class="h-full flex-none px-2.5">Details</button>
            <button hlmTabsTrigger="subtasks" class="h-full flex-none px-2.5">
              Subtasks
              @if (childCount() > 0) {
                <span class="text-muted-foreground text-xs tabular-nums">{{ childCount() }}</span>
              }
            </button>
            <button hlmTabsTrigger="time" class="h-full flex-none px-2.5">Time</button>
          </hlm-tabs-list>
        </ng-template>

        <div hlmTabsContent="details" class="px-2 pt-2 pb-6">
          <app-property-row label="Status" compact>
            <app-issue-prop [issue]="i" field="status" showLabel />
          </app-property-row>
          <app-property-row label="Priority" compact>
            <app-issue-prop [issue]="i" field="priority" showLabel />
          </app-property-row>
          <app-property-row label="Assignee" compact>
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
          <app-property-row label="Project" compact>
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
          @if (showEstimate()) {
            <app-property-row label="Estimate" compact>
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
          <app-issue-milestone-prop [issue]="i" />
          <app-property-row label="Labels" compact>
            <app-label-picker
              scope="issue"
              triggerClass="min-h-7 py-0.5"
              [disabled]="!canEdit()"
              [value]="i.labels"
              (valueChange)="store.updateIssue(i.id, { labels: $event })"
            />
          </app-property-row>
          <app-property-row label="Type" compact>
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
          <app-property-row label="Thread" compact>
            <app-issue-thread-link class="min-w-0 flex-1" variant="row" [issue]="i" [canEdit]="canEdit()" />
            @if (!i.threadUrl && !canEdit()) {
              <span class="text-muted-foreground px-1.5 text-[13px]">—</span>
            }
          </app-property-row>

          <app-issue-section class="mt-1" label="Details" [summary]="'Updated ' + (i.updatedAt | relativeTime)">
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
          @if (childCount() === 0 && !store.allowed('createIssues')) {
            <p class="text-muted-foreground px-1 text-sm">No subtasks.</p>
          }
        </div>

        <div hlmTabsContent="time" class="px-2 pt-2 pb-6">
          <app-issue-time-card [issue]="i" />
        </div>
      </hlm-tabs>
    }
  `,
})
export class TaskInspector {
  protected readonly store = inject(TramaStore);
  protected readonly actions = inject(IssueActions);

  /** A task id or its key (`CORA-142`). */
  readonly idOrKey = input.required<string>();
  readonly mode = input<'preview' | 'page'>('page');

  private readonly pageTask = inject(TaskPageContext);
  /**
   * The shell always renders the pane as a preview; when that pane shows the task the page itself is on, the
   * page already has the key, title and description, so it is the page-mode inspector.
   */
  protected readonly effectiveMode = computed(() =>
    this.mode() === 'preview' && this.pageTask.taskId() !== this.issue()?.id ? 'preview' : 'page',
  );

  protected readonly tab = signal<InspectorTab>('details');

  protected readonly openIcon = LucideExternalLink;
  protected readonly xIcon = LucideX;
  protected readonly kindOpts = issueKindOptions();

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly issue = computed(() => this.store.getIssue(this.idOrKey()));
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly childCount = computed(() => {
    const id = this.issue()?.id;
    return id ? this.store.issues().filter((i) => i.parentId === id).length : 0;
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
