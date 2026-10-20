import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideActivity,
  LucideBox,
  LucideChevronDown,
  LucideChevronUp,
  LucideCopy,
  LucideDynamicIcon,
  LucideCircleDot,
  LucideEllipsis,
  LucideExternalLink,
  LucideFlag,
  LucideGauge,
  LucideGitBranch,
  LucideLink,
  LucideLink2,
  LucideMegaphone,
  LucideRadio,
  LucideSparkles,
  LucideTag,
  LucideTrash2,
  LucideUserRound,
  LucideUsers,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, fullDate, isTypingTarget, usePageShortcuts } from '../../core';
import { ApiClient } from '../../core/api/api-client';
import type { IssueContext } from '../../core/contracts/domain';
import { UiStore } from '../../core/stores/ui.store';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { EntityChip } from '../../shared/entity-chip';
import { IssueKindLabel } from '../../shared/issue';
import { Kbd } from '../../shared/kbd';
import { RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { IssueMilestoneProp } from '../milestones/milestone-chips';
import { IssueReleaseProp } from '../releases/issue-release-prop';
import { issueFacts } from '../stats/stats-model';
import { InlineText } from '../../shared/inline-edit';
import { Picker } from '../../shared/picker';
import { projectOptions, teamOptions } from '../../shared/picker-options';
import { IssueActions, type IssuePromptField } from './issue-actions';
import { IssueExternalRef } from './issue-external-ref';
import { IssueArtifacts } from './issue-artifacts';
import { IssueActivity, IssueDescription, IssueTitle } from './issue-detail-parts';
import { IssueGoal } from './issue-goal';
import { IssueHumanInput } from './issue-human-input';
import { SOURCE_LABEL, issueEstimateOptions, issueKindOptions } from './issue-model';
import { AiActions } from '../ai-actions/ai-actions.service';
import { AiIssueSection } from '../ai-actions/ai-issue-cards';
import { issueWorkState } from '../customers/customer-model';
import { CustomerRequests } from '../customers/customer-requests';
import { DemandSummary } from '../customers/demand-summary';
import { IssueTimeCard } from './issue-sidebar';
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
    IssueReleaseProp,
    IssueExternalRef,
    Picker,
    InlineText,
    IssueProp,
    IssueTitle,
    IssueDescription,
    IssueGoal,
    IssueHumanInput,
    IssueArtifacts,
    IssueActivity,
    IssueCommandDialog,
    CustomerRequests,
    DemandSummary,
    IssueTimeCard,
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
            aria-label="Previous issue"
            hlmTooltip="Previous issue · K"
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
            aria-label="Next issue"
            hlmTooltip="Next issue · J"
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
          aria-label="Issue actions"
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
                  <svg [lucideIcon]="trash" [size]="14"></svg> Delete issue…
                  <hlm-dropdown-menu-shortcut
                    ><app-kbd keys="mod+backspace"
                  /></hlm-dropdown-menu-shortcut>
                </button>
              }
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <div class="grid min-h-full flex-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
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
              </div>
              @if (duplicate(); as dup) {
                <div
                  class="bg-muted/50 border-border mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[13px]"
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

            <app-issue-goal [issue]="i" [canEdit]="canEdit()" />
            @if (parentIssue() || subIssues().length || store.allowed('createIssues')) {
              <section
                aria-labelledby="issue-sub-issues-heading"
                class="border-border min-w-0 rounded-lg border px-4 py-3"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <h2 id="issue-sub-issues-heading" class="text-sm font-semibold">Sub-issues</h2>
                  @if (store.allowed('createIssues')) {
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      size="sm"
                      class="shrink-0"
                      [attr.aria-label]="'Create sub-issue of ' + i.key"
                      (click)="ui.openCreate('issue', { parentId: i.id })"
                    >
                      Add sub-issue
                    </button>
                  }
                </div>
                @if (parentIssue(); as parent) {
                  <div class="mt-3 min-w-0">
                    <h3 class="text-muted-foreground mb-1 text-xs font-medium">Parent issue</h3>
                    <app-entity-chip class="max-w-full" type="issue" [ref]="parent.id" />
                  </div>
                }
                <div class="mt-3 min-w-0">
                  <h3 class="text-muted-foreground mb-1 text-xs font-medium">Direct sub-issues</h3>
                  @if (subIssues().length) {
                    <ul role="list" class="flex min-w-0 flex-col gap-1">
                      @for (child of subIssues(); track child.id) {
                        <li class="min-w-0">
                          <app-entity-chip class="max-w-full" type="issue" [ref]="child.id" />
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="text-muted-foreground text-xs">No direct sub-issues.</p>
                  }
                </div>
              </section>
            }
            @if (planSummary(); as plan) {
              <section
                aria-labelledby="issue-plan-heading"
                class="border-border rounded-lg border px-4 py-3"
              >
                <h2 id="issue-plan-heading" class="mb-2 text-sm font-semibold">Plan summary</h2>
                @if (plan.artifactCount) {
                  <p class="text-muted-foreground text-xs">
                    {{ plan.artifactCount }} Plan artifact{{ plan.artifactCount === 1 ? '' : 's' }}
                  </p>
                }
                @if (plan.latestArtifact; as artifact) {
                  <div class="mt-2">
                    @if (artifact.documentId) {
                      <a
                        class="inline-flex items-center gap-1 text-sm underline underline-offset-2"
                        [routerLink]="['/', slug(), 'documents', artifact.documentId]"
                      >
                        {{ artifact.title }}
                      </a>
                    } @else if (artifact.url) {
                      <a
                        class="inline-flex items-center gap-1 text-sm underline underline-offset-2"
                        [href]="artifact.url"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {{ artifact.title }}
                        <svg [lucideIcon]="extIcon" [size]="12" aria-hidden="true"></svg>
                      </a>
                    } @else {
                      <span class="text-sm">{{ artifact.title }}</span>
                    }
                  </div>
                }
                @if (plan.decisions.length) {
                  <ul class="mt-2 flex flex-col gap-1">
                    @for (decision of plan.decisions; track decision.id) {
                      <li>
                        <a
                          class="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
                          [routerLink]="['/', slug(), 'decisions', decision.key]"
                        >
                          {{ decision.key }} · {{ decision.title }}
                        </a>
                      </li>
                    }
                  </ul>
                }
              </section>
            }
            <app-issue-human-input [issue]="i" [disabled]="!canEdit() || !!i.duplicateOfId" />

            <app-demand-summary [demand]="store.demand().get(i.id)" [state]="workState(i.status)" />
            <app-customer-requests [issueId]="i.id" [readonly]="!!i.duplicateOfId" />

            <app-issue-artifacts [issue]="i" />

            <div class="border-t pt-6">
              <app-issue-activity [issue]="i" />
            </div>
          </div>
        </main>

        <!-- Properties -->
        <aside
          class="bg-sidebar/40 border-border flex flex-col gap-4 border-t px-4 py-5 lg:border-t-0 lg:border-l"
          aria-label="Properties"
        >
          <app-ai-issue-section [issue]="i" />

          <section class="bg-card border-border rounded-lg border">
            <h3 class="text-muted-foreground px-3 pt-2.5 pb-1 text-xs font-medium">Properties</h3>
            <div class="flex flex-col px-2.5 pb-2">
              <app-property-row label="Status" [icon]="statusGlyph">
                <app-issue-prop [issue]="i" field="status" showLabel />
              </app-property-row>
              <app-property-row label="Priority" [icon]="flagGlyph">
                <app-issue-prop [issue]="i" field="priority" showLabel />
              </app-property-row>
              <app-property-row label="Assignee" [icon]="userGlyph">
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
              <app-property-row label="Team" [icon]="teamGlyph">
                <app-picker
                  variant="field"
                  label="Team"
                  placeholder="No team"
                  [clearable]="true"
                  clearLabel="No team"
                  [disabled]="!canEdit()"
                  [options]="teams()"
                  [value]="i.teamId ? [i.teamId] : []"
                  (valueChange)="store.updateIssue(i.id, { teamId: $event[0] ?? null })"
                />
              </app-property-row>
              <app-property-row label="Project" [icon]="projectGlyph">
                <app-picker
                  variant="field"
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
                <app-property-row label="Estimate" [icon]="gaugeGlyph">
                  <app-picker
                    variant="field"
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
              <app-issue-release-prop [issue]="i" />
              <app-property-row label="Labels" [icon]="tagGlyph">
                <app-label-picker
                  #labelPicker
                  scope="issue"
                  [disabled]="!canEdit()"
                  [value]="i.labels"
                  (valueChange)="store.updateIssue(i.id, { labels: $event })"
                />
              </app-property-row>
              <app-property-row label="Type" [icon]="tagGlyph">
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

          <app-issue-time-card [issue]="i" />

          <section class="bg-card border-border rounded-lg border">
            <h3 class="text-muted-foreground px-3 pt-2.5 pb-1 text-xs font-medium">Details</h3>
            <div class="flex flex-col px-2.5 pb-2">
              <app-property-row label="Source" [icon]="sourceGlyph">
                <span class="px-1.5 text-[13px]">{{ sourceLabel() }}</span>
              </app-property-row>
              <app-property-row label="Reporter" [icon]="reporterGlyph">
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
              <app-property-row label="External link" [icon]="linkGlyph">
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
              <app-property-row label="Duplicate of" [icon]="copyIcon">
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
                <app-property-row label="Duplicates" [icon]="copyIcon">
                  <span class="flex flex-wrap gap-1">
                    @for (d of duplicates(); track d.id) {
                      <app-entity-chip type="issue" [ref]="d.id" compact />
                    }
                  </span>
                </app-property-row>
              }
            </div>
          </section>

          <section class="px-0.5">
            <h3 class="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              <svg [lucideIcon]="activityGlyph" [size]="13" [strokeWidth]="1.75"></svg> Activity
            </h3>
            <dl class="text-muted-foreground flex flex-col gap-1.5 text-xs">
              <div class="flex justify-between gap-3">
                <dt>Updated</dt>
                <dd class="text-foreground" [hlmTooltip]="full(i.updatedAt)">
                  {{ i.updatedAt | relativeTime }}
                </dd>
              </div>
              @for (f of facts(); track f.label) {
                @if (f.label !== 'Last update') {
                  <div class="flex justify-between gap-3">
                    <dt>{{ f.label }}</dt>
                    <dd class="text-foreground tabular-nums">{{ f.value }}</dd>
                  </div>
                }
              }
            </dl>
          </section>
        </aside>
      </div>

      <app-issue-command-dialog />
    } @else if (store.ready()) {
      <app-empty-state
        title="Issue not found"
        [description]="
          'There is no issue ' + (key() ?? '') + '. It may have been deleted, or the link is wrong.'
        "
      >
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'issues']"
          >Back to issues</a
        >
      </app-empty-state>
    }
  `,
})
export class IssueDetailPage {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly api = inject(ApiClient);
  protected readonly store = inject(TramaStore);
  protected readonly ui = inject(UiStore);
  protected readonly workState = issueWorkState;
  protected readonly actions = inject(IssueActions);
  protected readonly ai = inject(AiActions);
  protected readonly planSummary = signal<IssueContext['planSummary']>(undefined);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Route param: issue key (`BUG-142`) or id. */
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
  protected readonly subIssues = computed(() => {
    const issueId = this.issue()?.id;
    return issueId ? this.store.issues().filter((issue) => issue.parentId === issueId) : [];
  });
  protected readonly facts = computed(() => {
    const issue = this.issue();
    return issue ? issueFacts(this.store, issue.id) : [];
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
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly projects = computed(() => projectOptions(this.store, this.issue()?.projectId));
  protected readonly kindOpts = issueKindOptions();
  /** Estimates are off in this workspace, but an issue that still has one keeps showing it. */
  protected readonly showEstimate = computed(
    () => this.store.estimateScale() !== 'none' || this.issue()?.estimate !== undefined,
  );
  protected readonly estimateOpts = computed(() =>
    issueEstimateOptions(this.issue()?.estimate, this.store.estimateScale()),
  );

  private readonly _context = effect((onCleanup) => {
    const issue = this.issue();
    const slug = this.slug();
    let current = true;
    onCleanup(() => {
      current = false;
    });
    this.planSummary.set(undefined);
    if (!issue || !slug) return;
    void this.api.issues
      .context(slug, issue.key)
      .then((context) => {
        if (!current) return;
        this.planSummary.set(context.planSummary);
      })
      .catch(() => {
        if (current) this.planSummary.set(undefined);
      });
  });

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
  protected readonly statusGlyph = LucideCircleDot;
  protected readonly flagGlyph = LucideFlag;
  protected readonly userGlyph = LucideUserRound;
  protected readonly teamGlyph = LucideUsers;
  protected readonly projectGlyph = LucideBox;
  protected readonly gaugeGlyph = LucideGauge;
  protected readonly tagGlyph = LucideTag;
  protected readonly sourceGlyph = LucideRadio;
  protected readonly reporterGlyph = LucideMegaphone;
  protected readonly linkGlyph = LucideLink2;
  protected readonly activityGlyph = LucideActivity;
  protected readonly upIcon = LucideChevronUp;
  protected readonly downIcon = LucideChevronDown;

  /** The key in the URL may be an old key (alias), an id or a different case: show the current key. */
  private readonly _canonicalUrl = effect(() => {
    const issue = this.issue();
    const ref = this.key();
    if (!issue || !ref || ref === issue.key || ref === issue.id) return;
    void this.router.navigate(['/', this.slug(), 'issues', issue.key], { replaceUrl: true });
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Issues', link: ['/', this.slug(), 'issues'] },
    { label: this.issue()?.key ?? this.key() ?? '', mono: true },
  ]);

  private readonly _keys = usePageShortcuts([
    {
      keys: 's',
      label: 'Change status',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.prompt('status'),
    },
    {
      keys: 'p',
      label: 'Set priority',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.prompt('priority'),
    },
    {
      keys: 'shift+p',
      label: 'Move to project…',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.prompt('project'),
    },
    {
      keys: 'a',
      label: 'Assign to…',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.prompt('assignee'),
    },
    {
      keys: 'i',
      label: 'Assign to me',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.ids().length && this.actions.toggleAssignMe(this.ids()),
    },
    {
      keys: 'l',
      label: 'Add labels',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.labelPicker()?.open(),
    },
    {
      keys: 'shift+d',
      label: 'Mark as duplicate',
      group: 'Issue',
      when: () => this.editable() && !this.issue()?.duplicateOfId,
      run: () => this.prompt('duplicate'),
    },
    {
      keys: 'r',
      label: 'Rename',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.titleEditor()?.start(),
    },
    {
      keys: 'e',
      label: 'Edit description',
      group: 'Issue',
      when: () => this.editable(),
      run: () => this.descEditor()?.start(),
    },
    {
      keys: 'mod+.',
      label: 'Copy issue key',
      group: 'Issue',
      run: () => this.actions.copyKeys(this.ids()),
    },
    {
      keys: 'mod+shift+l',
      label: 'Copy issue link',
      group: 'Issue',
      run: () => this.actions.copyLinks(this.ids()),
    },
    {
      keys: 'mod+shift+g',
      label: 'Copy git branch name',
      group: 'Issue',
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+shift+.',
      label: 'Copy git branch name',
      group: 'Issue',
      hidden: true,
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+shift+>',
      label: 'Copy git branch name',
      group: 'Issue',
      hidden: true,
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+backspace',
      label: 'Delete issue',
      group: 'Issue',
      when: () => this.editable() && !this.typing(),
      run: () => this.remove(),
    },
    {
      keys: 'j',
      label: 'Next issue',
      group: 'Issue',
      when: () => !!this.nav().next,
      run: () => this.go(this.nav().next),
    },
    {
      keys: 'k',
      label: 'Previous issue',
      group: 'Issue',
      when: () => !!this.nav().prev,
      run: () => this.go(this.nav().prev),
    },
    {
      keys: 'alt+down',
      label: 'Next issue',
      group: 'Issue',
      when: () => !!this.nav().next,
      run: () => this.go(this.nav().next),
    },
    {
      keys: 'alt+up',
      label: 'Previous issue',
      group: 'Issue',
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
    if (key) void this.router.navigate(['/', this.slug(), 'issues', key]);
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
    this.actions.remove([issue.id], () => void this.router.navigate(['/', this.slug(), 'issues']));
  }
}
