import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideChevronDown,
  LucideChevronUp,
  LucideCopy,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideExternalLink,
  LucideGitBranch,
  LucideLink,
  LucideSparkles,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, fullDate, isTypingTarget, usePageShortcuts } from '../../core';
import { UiStore } from '../../core/stores/ui.store';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { EntityChip } from '../../shared/entity-chip';
import { IssueKindLabel } from '../../shared/issue';
import { Kbd } from '../../shared/kbd';
import { RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { IssueMilestoneProp } from '../milestones/milestone-chips';
import { InlineText } from '../../shared/inline-edit';
import { Picker } from '../../shared/picker';
import { projectOptions } from '../../shared/picker-options';
import { IssueActions, type IssuePromptField } from './issue-actions';
import { IssueExternalRef } from './issue-external-ref';
import { IssueActivity, IssueDescription, IssueTitle } from './issue-detail-parts';
import { SOURCE_LABEL, issueEstimateOptions, issueKindOptions } from './issue-model';
import { AiActions } from '../ai-actions/ai-actions.service';
import { AiIssueSection } from '../ai-actions/ai-issue-cards';
import { IssueLunagest } from './issue-lunagest';
import { IssueSection } from './issue-section';
import { IssueTimeCard } from './issue-sidebar';
import { IssueSubtasks } from './issue-subtasks';
import { IssueThreadLink } from './issue-thread-link';
import { IssueCommandDialog, IssueProp } from './issue-prop';
import { LabelPicker } from '../../shared/label-picker';

@Component({
  selector: 'app-issue-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    LabelPicker,
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    TopBarActions,
    EmptyState,
    EntityChip,
    IssueKindLabel,
    Kbd,
    RelativeTimePipe,
    PropertyRow,
    IssueMilestoneProp,
    IssueExternalRef,
    Picker,
    InlineText,
    IssueProp,
    IssueTitle,
    IssueDescription,
    IssueActivity,
    IssueCommandDialog,
    IssueTimeCard,
    IssueLunagest,
    IssueSection,
    IssueSubtasks,
    IssueThreadLink,
    AiIssueSection,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (issue(); as i) {
      <ng-template appTopBarActions>
        @if (nav().total > 1) {
          <span class="text-muted-foreground mr-1 text-xs tabular-nums max-sm:hidden"
            >{{ nav().index + 1 }} / {{ nav().total }}</span
          >
          <button
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            aria-label="Previous task"
            hlmTooltip="Previous task · K"
            [disabled]="!nav().prev"
            (click)="go(nav().prev)"
          >
            <svg [lucideIcon]="upIcon" [size]="15"></svg>
          </button>
          <button
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            aria-label="Next task"
            hlmTooltip="Next task · J"
            [disabled]="!nav().next"
            (click)="go(nav().next)"
          >
            <svg [lucideIcon]="downIcon" [size]="15"></svg>
          </button>
        }
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          aria-label="Copy link"
          hlmTooltip="Copy link · ⌘⇧L"
          (click)="actions.copyLinks([i.id])"
        >
          <svg [lucideIcon]="linkIcon" [size]="15"></svg>
        </button>
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="more"
          aria-label="Task actions"
          hlmTooltip="More actions"
        >
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-60">
            <hlm-dropdown-menu-group>
              <button hlmDropdownMenuItem (triggered)="actions.copyKeys([i.id])">
                <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy key
                <hlm-dropdown-menu-shortcut><app-kbd keys="mod+." /></hlm-dropdown-menu-shortcut>
              </button>
              <button hlmDropdownMenuItem (triggered)="actions.copyLinks([i.id])">
                <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy link
                <hlm-dropdown-menu-shortcut
                  ><app-kbd keys="mod+shift+l"
                /></hlm-dropdown-menu-shortcut>
              </button>
              <button hlmDropdownMenuItem (triggered)="actions.copyTitle(i.id)">
                <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy key and title
              </button>
              <button hlmDropdownMenuItem (triggered)="actions.copyBranch(i.id)">
                <svg [lucideIcon]="branchIcon" [size]="14"></svg> Copy git branch name
                <hlm-dropdown-menu-shortcut
                  ><app-kbd keys="mod+shift+g"
                /></hlm-dropdown-menu-shortcut>
              </button>
            </hlm-dropdown-menu-group>
            @if (ai.available()) {
              <hlm-dropdown-menu-separator />
              <hlm-dropdown-menu-group>
                <button hlmDropdownMenuItem (triggered)="ai.request('summarize', i.id)">
                  <svg [lucideIcon]="sparkles" [size]="14" class="text-primary"></svg>
                  Summarize with AI
                </button>
                @if (canEdit()) {
                  <button hlmDropdownMenuItem (triggered)="ai.request('triage', i.id)">
                    <svg [lucideIcon]="sparkles" [size]="14" class="text-primary"></svg>
                    Suggest properties with AI
                  </button>
                  <button hlmDropdownMenuItem (triggered)="ai.request('improve', i.id)">
                    <svg [lucideIcon]="sparkles" [size]="14" class="text-primary"></svg>
                    Improve description with AI
                  </button>
                }
              </hlm-dropdown-menu-group>
            }
            @if (canEdit()) {
              <hlm-dropdown-menu-separator />
              <hlm-dropdown-menu-group>
                @if (i.duplicateOfId) {
                  <button hlmDropdownMenuItem (triggered)="actions.clearDuplicate(i.id)">
                    <svg [lucideIcon]="xIcon" [size]="14"></svg> Not a duplicate
                  </button>
                } @else {
                  <button hlmDropdownMenuItem (triggered)="actions.openPrompt('duplicate', [i.id])">
                    <svg [lucideIcon]="copyIcon" [size]="14"></svg> Mark as duplicate…
                    <hlm-dropdown-menu-shortcut
                      ><app-kbd keys="shift+d"
                    /></hlm-dropdown-menu-shortcut>
                  </button>
                }
              </hlm-dropdown-menu-group>
              @if (store.allowed('deleteIssues')) {
                <hlm-dropdown-menu-separator />
                <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                  <svg [lucideIcon]="trash" [size]="14"></svg> Delete task…
                  <hlm-dropdown-menu-shortcut
                    ><app-kbd keys="mod+backspace"
                  /></hlm-dropdown-menu-shortcut>
                </button>
              }
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <div class="grid min-h-full flex-1 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <!-- Main column -->
        <main class="min-w-0 px-4 py-6 sm:px-8 lg:px-12">
          <div class="mx-auto flex max-w-3xl flex-col gap-8">
            <div>
              <div class="text-muted-foreground mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span class="inline-flex items-center gap-1.5"
                  ><app-issue-kind [kind]="i.kind" showLabel
                /></span>
                <span aria-hidden="true">·</span>
                <span class="font-mono">{{ i.key }}</span>
                @if (i.source !== 'manual') {
                  <span aria-hidden="true">·</span>
                  <span>via {{ sourceLabel() }}</span>
                }
                @if (parentIssue(); as parent) {
                  <span aria-hidden="true">·</span>
                  <span>Subtask of</span>
                  <app-entity-chip type="issue" [ref]="parent.id" compact />
                }
              </div>
              @if (duplicate(); as dup) {
                <div
                  class="bg-muted mb-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]"
                >
                  <span class="text-muted-foreground">Duplicate of</span>
                  <app-entity-chip type="issue" [ref]="dup.id" />
                  @if (canEdit()) {
                    <button
                      hlmBtn
                      variant="ghost"
                      size="sm"
                      class="text-muted-foreground ml-auto h-6 px-2 text-xs"
                      (click)="actions.clearDuplicate(i.id)"
                    >
                      Not a duplicate
                    </button>
                  }
                </div>
              }
              <app-issue-title
                #title
                [value]="i.title"
                [canEdit]="canEdit()"
                (save)="store.updateIssue(i.id, { title: $event })"
              />
              <app-issue-thread-link [issue]="i" [canEdit]="canEdit()" />
              <div class="mt-3">
                <app-issue-description
                  #desc
                  [value]="i.body ?? ''"
                  [canEdit]="canEdit()"
                  (save)="store.updateIssue(i.id, { body: $event || null })"
                />
              </div>
              <!-- Phones: the properties panel sits below the activity; the three that matter most are one tap away here. -->
              <div
                class="prop-chips mt-4 flex flex-wrap gap-2 lg:hidden"
                role="group"
                aria-label="Properties"
              >
                <app-issue-prop [issue]="i" field="status" showLabel />
                <app-issue-prop [issue]="i" field="priority" showLabel />
                <app-issue-prop [issue]="i" field="assignee" showLabel />
              </div>
            </div>

            <app-ai-issue-section [issue]="i" [showActions]="false" />
            <app-issue-subtasks [issue]="i" />
            <div class="pt-2">
              <app-issue-activity [issue]="i" />
            </div>
          </div>
        </main>

        <!-- Properties -->
        <aside class="bg-sidebar/50 flex min-w-0 flex-col gap-1 px-2 py-3" aria-label="Properties">
          <section class="flex flex-col">
            <div class="flex flex-col">
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
                    [value]="
                      i.estimate !== undefined && i.estimate !== null ? ['' + i.estimate] : []
                    "
                    (valueChange)="setEstimate(i.id, $event[0])"
                  />
                </app-property-row>
              }
              <app-issue-milestone-prop [issue]="i" />
              <app-property-row label="Labels" compact>
                <app-label-picker
                  #labelPicker
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
            </div>
          </section>

          <app-issue-section label="Details" [summary]="'Updated ' + (i.updatedAt | relativeTime)">
            <div class="flex flex-col">
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
                    <svg [lucideIcon]="extIcon" [size]="13"></svg>
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
            </div>
          </app-issue-section>

          <app-issue-time-card [issue]="i" />

          <app-issue-lunagest [issueId]="i.id" />
        </aside>
      </div>

      <app-issue-command-dialog />
    } @else if (store.ready()) {
      <app-empty-state
        title="Task not found"
        [description]="
          'There is no task ' + (key() ?? '') + '. It may have been deleted, or the link is wrong.'
        "
      >
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'tasks']">Back to tasks</a>
      </app-empty-state>
    }
  `,
})
export class IssueDetailPage {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  protected readonly store = inject(TramaStore);
  protected readonly ui = inject(UiStore);
  protected readonly actions = inject(IssueActions);
  protected readonly ai = inject(AiActions);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Route param: project-based issue key (`CORA-142`) or id. */
  readonly key = input<string>();

  private readonly titleEditor = viewChild<IssueTitle>('title');
  private readonly descEditor = viewChild<IssueDescription>('desc');
  private readonly labelPicker = viewChild<LabelPicker>('labelPicker');

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly issue = computed(() => this.store.getIssue(this.key()));
  protected readonly parentIssue = computed(() => {
    const parentId = this.issue()?.parentId;
    return parentId ? this.store.issueById().get(parentId) : undefined;
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
  protected readonly kindOpts = issueKindOptions();
  /** Estimates are off in this workspace, but an issue that still has one keeps showing it. */
  protected readonly showEstimate = computed(
    () => this.store.estimateScale() !== 'none' || this.issue()?.estimate !== undefined,
  );
  protected readonly estimateOpts = computed(() =>
    issueEstimateOptions(this.issue()?.estimate, this.store.estimateScale()),
  );

  /** Prev / next in the order the issue list last showed (falls back to most recently updated). */
  protected readonly nav = computed(() => {
    const id = this.issue()?.id;
    let order = this.actions.navOrder().filter((x) => this.store.issueById().has(x));
    if (!id || !order.includes(id)) {
      order = [...this.store.issues()]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((i) => i.id);
    }
    const index = id ? order.indexOf(id) : -1;
    const keyOf = (n: number) =>
      n >= 0 && n < order.length ? this.store.issueById().get(order[n])?.key : undefined;
    return { index, total: order.length, prev: keyOf(index - 1), next: keyOf(index + 1) };
  });

  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly copyIcon = LucideCopy;
  protected readonly linkIcon = LucideLink;
  protected readonly sparkles = LucideSparkles;
  protected readonly xIcon = LucideX;
  protected readonly extIcon = LucideExternalLink;
  protected readonly branchIcon = LucideGitBranch;
  protected readonly upIcon = LucideChevronUp;
  protected readonly downIcon = LucideChevronDown;

  /** The key in the URL may be an old key (alias), an id or a different case: show the current key. */
  private readonly _canonicalUrl = effect(() => {
    const issue = this.issue();
    const ref = this.key();
    if (!issue || !ref || ref === issue.key || ref === issue.id) return;
    void this.router.navigate(['/', this.slug(), 'tasks', issue.key], { replaceUrl: true });
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Tasks', link: ['/', this.slug(), 'tasks'] },
    { label: this.issue()?.key ?? this.key() ?? '', mono: true },
  ]);

  private readonly _keys = usePageShortcuts([
    {
      keys: 's',
      label: 'Change status',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('status'),
    },
    {
      keys: 'p',
      label: 'Set priority',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('priority'),
    },
    {
      keys: 'shift+p',
      label: 'Move to project…',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('project'),
    },
    {
      keys: 'a',
      label: 'Assign to…',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('assignee'),
    },
    {
      keys: 'i',
      label: 'Assign to me',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.ids().length && this.actions.toggleAssignMe(this.ids()),
    },
    {
      keys: 'l',
      label: 'Add labels',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.labelPicker()?.open(),
    },
    {
      keys: 'shift+d',
      label: 'Mark as duplicate',
      group: 'Task',
      when: () => this.editable() && !this.issue()?.duplicateOfId,
      run: () => this.prompt('duplicate'),
    },
    {
      keys: 'r',
      label: 'Rename',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.titleEditor()?.start(),
    },
    {
      keys: 'e',
      label: 'Edit description',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.descEditor()?.start(),
    },
    {
      keys: 'mod+.',
      label: 'Copy task key',
      group: 'Task',
      run: () => this.actions.copyKeys(this.ids()),
    },
    {
      keys: 'mod+shift+l',
      label: 'Copy task link',
      group: 'Task',
      run: () => this.actions.copyLinks(this.ids()),
    },
    {
      keys: 'mod+shift+g',
      label: 'Copy git branch name',
      group: 'Task',
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+shift+.',
      label: 'Copy git branch name',
      group: 'Task',
      hidden: true,
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+shift+>',
      label: 'Copy git branch name',
      group: 'Task',
      hidden: true,
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+backspace',
      label: 'Delete task',
      group: 'Task',
      when: () => this.editable() && !this.typing(),
      run: () => this.remove(),
    },
    {
      keys: 'j',
      label: 'Next task',
      group: 'Task',
      when: () => !!this.nav().next,
      run: () => this.go(this.nav().next),
    },
    {
      keys: 'k',
      label: 'Previous task',
      group: 'Task',
      when: () => !!this.nav().prev,
      run: () => this.go(this.nav().prev),
    },
    {
      keys: 'alt+down',
      label: 'Next task',
      group: 'Task',
      when: () => !!this.nav().next,
      run: () => this.go(this.nav().next),
    },
    {
      keys: 'alt+up',
      label: 'Previous task',
      group: 'Task',
      when: () => !!this.nav().prev,
      run: () => this.go(this.nav().prev),
    },
  ]);

  private copyBranch(): void {
    const id = this.issue()?.id;
    if (id) this.actions.copyBranch(id);
  }

  private ids(): string[] {
    const id = this.issue()?.id;
    return id ? [id] : [];
  }

  private editable(): boolean {
    return this.canEdit() && !!this.issue();
  }

  private typing(): boolean {
    return isTypingTarget(this.document.activeElement);
  }

  private prompt(field: IssuePromptField): void {
    this.actions.openPrompt(field, this.ids());
  }

  protected go(key: string | undefined): void {
    if (key) void this.router.navigate(['/', this.slug(), 'tasks', key]);
  }

  protected setEstimate(id: string, value: string | undefined): void {
    this.actions.setEstimate([id], value === undefined ? null : Number(value));
  }

  protected full(iso: string): string {
    return fullDate(iso);
  }

  protected saveUrl(id: string, value: string): void {
    const v = value.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      void this.store.updateIssue(id, { externalUrl: `https://${v}` });
      return;
    }
    void this.store.updateIssue(id, { externalUrl: v || null });
  }

  protected remove(): void {
    const issue = this.issue();
    if (!issue) return;
    this.actions.remove([issue.id], () => void this.router.navigate(['/', this.slug(), 'tasks']));
  }
}
