import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideBox,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideEllipsis,
  LucidePlus,
  LucideLink,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { PROJECT_KEY_MAX } from '../../core/contracts/domain';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  TramaStore,
  UiStore,
  usePageShortcuts,
  type DomainEvent,
  type Issue,
  type IssueStatus,
  type Priority,
  type Project,
  type ProjectStatus,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { Clipboard } from '../../core/notify/notifier';
import { EmptyState } from '../../shared/empty-state';
import { FullDatePipe, RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { StatusLabel } from '../../shared/status';
import { IssueRow } from '../issues/issue-items';
import { ProjectMilestones } from '../milestones/project-milestones';
import { EventLine } from '../../shared/event-line';
import { CommentThread } from '../../shared/comments';
import { EditableMarkdown, InlineText } from '../../shared/inline-edit';
import { Picker } from '../../shared/picker';
import { priorityOptions, userOptions } from '../../shared/picker-options';
import { DatePicker } from '../../shared/date-picker';
import { isoFromDate } from '../milestones/milestone-actions';
import { ProjectAiSummaryButton, ProjectIssueSuggestions, ProjectRisksCard } from './project-ai';
import { ProjectGlyphPicker } from './project-glyph';
import { ProjectLunagest } from './project-lunagest';
import { isOverdue, projectHealthOptions, projectStatusOptions } from './project-model';
import { ProjectStatsTab } from './project-stats-tab';
import { LabelPicker } from '../../shared/label-picker';

const TABS = ['overview', 'tasks', 'stats'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  tasks: 'Tasks',
  stats: 'Stats',
};

const ACTIVITY_CAP = 20;

@Component({
  selector: 'app-project-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    LabelPicker,
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    LucideDynamicIcon,
    TopBarActions,
    EmptyState,
    PropertyRow,
    FullDatePipe,
    RelativeTimePipe,
    CommentThread,
    EditableMarkdown,
    InlineText,
    Picker,
    DatePicker,
    EventLine,
    ProjectMilestones,
    HlmTabsImports,
    HlmTooltip,
    StatusLabel,
    IssueRow,
    ProjectAiSummaryButton,
    ProjectIssueSuggestions,
    ProjectRisksCard,
    ProjectGlyphPicker,
    ProjectLunagest,
    ProjectStatsTab,
  ],
  host: { class: 'flex min-h-full min-w-0 flex-col' },
  template: `
    @if (project(); as p) {
      <ng-template appTopBarActions>
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="more"
          aria-label="Project actions"
        >
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-48">
            <button hlmDropdownMenuItem (triggered)="copyLink()">
              <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy link
            </button>
            @if (canManage()) {
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete project
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <header class="px-4 pt-5 sm:px-6">
        <div class="flex min-w-0 items-center gap-2.5">
          <app-project-glyph-picker [project]="p" [canEdit]="canManage()" />
          <app-inline-text
            class="min-w-0 flex-1"
            label="project name"
            textClass="text-xl font-semibold tracking-tight"
            [value]="p.name"
            [canEdit]="canManage()"
            (save)="update({ name: $event })"
          />
          <app-inline-text
            class="w-14 shrink-0"
            label="project tag"
            textClass="text-muted-foreground bg-muted/60 rounded px-1.5 font-mono text-xs font-medium"
            [value]="p.key"
            [canEdit]="canManage()"
            [maxLength]="projectKeyMax"
            [mono]="true"
            hlmTooltip="Project tag; changing it updates this project's task keys"
            (save)="update({ key: $event })"
          />
        </div>
        <div class="mt-1 flex min-w-0 items-start gap-2">
          <app-inline-text
            class="min-w-0 flex-1"
            label="summary"
            placeholder="Add a short summary…"
            textClass="text-muted-foreground text-sm"
            [value]="p.summary ?? ''"
            [canEdit]="canManage()"
            [allowEmpty]="true"
            (save)="update({ summary: $event.trim() || null })"
          />
          @if (canManage()) {
            <app-project-ai-summary-button [project]="p" />
          }
        </div>

        <hlm-tabs [tab]="current()" (tabActivated)="setTab($event)" class="-mx-4 mt-3 sm:-mx-6">
          <div class="scrollbar-none overflow-x-auto px-4 sm:px-6">
            <hlm-tabs-list variant="line" class="h-9 w-max gap-1 p-0" aria-label="Project sections">
              @for (t of tabs; track t; let i = $index) {
                <button
                  [hlmTabsTrigger]="t"
                  class="h-9 flex-none px-2.5 after:bottom-0"
                  [hlmTooltip]="tabLabel[t] + ' (' + (i + 1) + ')'"
                  position="bottom"
                >
                  {{ tabLabel[t] }}
                  @if (counts()[t]) {
                    <span class="text-muted-foreground ml-1 text-xs tabular-nums">{{
                      counts()[t]
                    }}</span>
                  }
                </button>
              }
            </hlm-tabs-list>
          </div>
        </hlm-tabs>
      </header>

      @switch (current()) {
        @case ('tasks') {
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 px-4 py-2 sm:px-6">
              <span class="text-muted-foreground text-xs tabular-nums"
                >{{ issues().length }} {{ issues().length === 1 ? 'task' : 'tasks' }}</span
              >
              @if (canCreateIssue()) {
                <button
                  hlmBtn
                  variant="outline"
                  size="sm"
                  class="ml-auto gap-1"
                  (click)="newIssue()"
                >
                  <svg [lucideIcon]="plus" [size]="14"></svg>Add task
                </button>
              }
            </div>
            @if (issueGroups().length) {
              @for (g of issueGroups(); track g.status) {
                <section [attr.aria-label]="g.label">
                  <h2
                    class="mt-2 flex items-center gap-2 px-4 py-1.5 text-xs font-medium sm:px-6"
                  >
                    <app-status-label [status]="g.status" />
                    <span class="text-muted-foreground font-normal tabular-nums">{{
                      g.issues.length
                    }}</span>
                  </h2>
                  @for (i of g.issues; track i.id) {
                    <app-issue-row [issue]="i" />
                  }
                </section>
              }
            } @else {
              <app-empty-state
                [icon]="issueIcon"
                title="No tasks in this project"
                description="Tasks planned under this project show up here."
              >
                @if (canCreateIssue()) {
                  <button hlmBtn size="sm" (click)="newIssue()">
                    <svg [lucideIcon]="plus" [size]="14"></svg>Add task
                  </button>
                }
              </app-empty-state>
            }
          </div>
        }
        @case ('stats') {
          <div class="min-w-0 flex-1 px-4 py-5 sm:px-6">
            <app-project-stats-tab [project]="p" />
          </div>
        }
        @default {
          <div
            class="grid min-w-0 grid-cols-1 gap-x-10 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_17rem]"
          >
            <div class="flex min-w-0 flex-col gap-8">
              <section aria-label="Description">
                <app-editable-markdown
                  label="description"
                  placeholder="Describe the outcome, scope and why it matters…"
                  [value]="p.description ?? ''"
                  [canEdit]="canManage()"
                  [uploads]="true"
                  (save)="update({ description: $event.trim() || null })"
                />
              </section>

              <app-project-lunagest [projectId]="p.id" [canManage]="canManage()" />

              @if (canManage()) {
                <app-project-risks-card [project]="p" />
                <app-project-issue-suggestions [project]="p" />
              }

              <app-project-milestones [project]="p" />

              <section>
                <h2 class="mb-1 text-[13px] font-semibold">Activity</h2>
                @if (activity().length) {
                  <div class="flex flex-col">
                    @for (e of shownActivity(); track e.id) {
                      <app-event-line [event]="e" [slug]="slug()" />
                    }
                  </div>
                  @if (activity().length > activityCap && !allActivity()) {
                    <button
                      hlmBtn
                      variant="ghost"
                      size="sm"
                      class="text-muted-foreground mt-1"
                      (click)="allActivity.set(true)"
                    >
                      Show all {{ activity().length }}
                    </button>
                  }
                } @else {
                  <p class="text-muted-foreground text-[13px]">
                    Nothing has happened here in the recent history.
                  </p>
                }
              </section>

              <section>
                <h2 class="mb-2 text-[13px] font-semibold">Comments</h2>
                <app-comment-thread [subject]="{ type: 'project', id: p.id }" />
              </section>
            </div>

            <aside class="flex min-w-0 flex-col gap-0.5" aria-label="Properties">
              <app-property-row label="Status">
                <app-picker
                  variant="field"
                  label="Status"
                  [searchable]="false"
                  [disabled]="!canManage()"
                  [options]="statuses"
                  [value]="[p.status]"
                  (valueChange)="setStatus($event[0])"
                />
              </app-property-row>
              <app-property-row label="Health">
                <app-picker
                  variant="field"
                  label="Health"
                  placeholder="No health"
                  [searchable]="false"
                  [clearable]="true"
                  clearLabel="No health"
                  [disabled]="!canManage()"
                  [options]="healths()"
                  [value]="p.health ? [p.health] : []"
                  (valueChange)="update({ health: $any($event[0] ?? null) })"
                />
              </app-property-row>
              <app-property-row label="Priority">
                <app-picker
                  variant="field"
                  label="Priority"
                  [searchable]="false"
                  [disabled]="!canManage()"
                  [options]="priorities"
                  [value]="[p.priority]"
                  (valueChange)="setPriority($event[0])"
                />
              </app-property-row>
              <app-property-row label="Lead">
                <app-picker
                  variant="field"
                  label="Lead"
                  placeholder="No lead"
                  [clearable]="true"
                  clearLabel="Remove lead"
                  [disabled]="!canManage()"
                  [options]="users()"
                  [value]="p.leadId ? [p.leadId] : []"
                  (valueChange)="update({ leadId: $event[0] ?? null })"
                />
              </app-property-row>
              <app-property-row label="Labels">
                <app-label-picker
                  scope="project"
                  [disabled]="!canManage()"
                  [value]="p.labels"
                  (valueChange)="update({ labels: $event })"
                />
              </app-property-row>
              <app-property-row label="Repository">
                <input
                  hlmInput
                  class="h-8 w-full font-mono text-xs"
                  [value]="p.repository ?? ''"
                  [disabled]="!canManage()"
                  placeholder="owner/name or URL"
                  aria-label="Repository"
                  (change)="update({ repository: $any($event.target).value.trim() || null })"
                />
              </app-property-row>
              <app-property-row label="Start date">
                <app-date-picker
                  class="min-w-0 flex-1"
                  label="Start date"
                  triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm"
                  [disabled]="!canManage()"
                  [value]="p.startDate"
                  (dateChange)="update({ startDate: $event ? iso($event) : null })"
                >
                  @if (p.startDate) {
                    <span>{{ p.startDate | fullDate }}</span>
                  } @else {
                    <span class="text-muted-foreground">Not set</span>
                  }
                </app-date-picker>
              </app-property-row>
              <app-property-row label="Target date">
                <app-date-picker
                  class="min-w-0 flex-1"
                  label="Target date"
                  triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm"
                  [disabled]="!canManage()"
                  [value]="p.targetDate"
                  (dateChange)="update({ targetDate: $event ? iso($event) : null })"
                >
                  @if (p.targetDate) {
                    <span [class.text-status-blocked]="overdue()">{{
                      p.targetDate | fullDate
                    }}</span>
                    @if (overdue()) {
                      <span class="text-status-blocked ml-1.5 text-xs">overdue</span>
                    }
                  } @else {
                    <span class="text-muted-foreground">No date</span>
                  }
                </app-date-picker>
              </app-property-row>
              <app-property-row label="Created">
                <span class="text-muted-foreground px-1.5 text-xs">{{
                  p.createdAt | relativeTime
                }}</span>
              </app-property-row>
            </aside>
          </div>
        }
      }
    } @else {
      <app-empty-state
        [icon]="box"
        title="Project not found"
        description="It may have been deleted."
      >
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'projects']"
          >Back to projects</a
        >
      </app-empty-state>
    }
  `,
})
export class ProjectDetailPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();
  /** `?tab=` query param (bound by the router), default overview. */
  readonly tab = input<string>();

  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);

  protected readonly box = LucideBox;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly linkIcon = LucideLink;
  protected readonly plus = LucidePlus;
  protected readonly issueIcon = LucideCircleDot;
  protected readonly tabs = TABS;
  protected readonly tabLabel = TAB_LABEL;
  protected get statuses() {
    return projectStatusOptions(this.store.settings().statuses.project);
  }
  protected readonly priorities = priorityOptions();
  protected readonly healths = computed(() =>
    projectHealthOptions(this.store.settings().statuses.projectHealth),
  );
  protected readonly projectKeyMax = PROJECT_KEY_MAX;
  protected readonly activityCap = ACTIVITY_CAP;
  protected readonly allActivity = signal(false);
  protected readonly iso = isoFromDate;

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly project = computed(() => this.store.getProject(this.id()));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly overdue = computed(() => {
    const p = this.project();
    return !!p && isOverdue(p);
  });
  protected readonly canCreateIssue = computed(() => this.store.can('member'));
  protected readonly current = computed<Tab>(() => {
    const t = this.tab();
    return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'overview';
  });
  protected readonly issues = computed<readonly Issue[]>(() => {
    const id = this.project()?.id;
    return id ? (this.store.issuesByProject().get(id) ?? []) : [];
  });
  protected readonly issueGroups = computed(() => {
    const byStatus = new Map<IssueStatus, Issue[]>();
    for (const i of this.issues()) byStatus.set(i.status, [...(byStatus.get(i.status) ?? []), i]);
    return ISSUE_STATUSES.filter((s) => byStatus.has(s)).map((status) => ({
      status,
      label: ISSUE_STATUS_META[status].label,
      issues: byStatus.get(status) ?? [],
    }));
  });
  protected readonly counts = computed<Partial<Record<Tab, number>>>(() => ({
    tasks: this.issues().length,
  }));
  protected readonly activity = computed(() => {
    const id = this.project()?.id;
    if (!id) return [] as DomainEvent[];
    const own = this.store.eventsBySubject().get(`project:${id}`) ?? [];
    // milestone events carry the project in their data
    const milestones = this.store
      .events()
      .filter((e) => e.subject.type === 'milestone' && e.data?.['projectId'] === id);
    return [...own, ...milestones].sort((a, b) => (a.at < b.at ? 1 : -1));
  });
  protected readonly shownActivity = computed(() =>
    this.allActivity() ? this.activity() : this.activity().slice(0, ACTIVITY_CAP),
  );

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Projects', link: ['/', this.slug(), 'projects'] },
    { label: this.project()?.name ?? this.id() ?? '' },
  ]);

  private readonly _keys = usePageShortcuts(
    TABS.map((t, i) => ({
      keys: String(i + 1),
      label: `${TAB_LABEL[t]} tab`,
      run: () => this.setTab(t),
      when: () => !!this.project(),
    })),
  );

  protected setTab(t: string | null | undefined): void {
    if (!t) return;
    void this.router.navigate([], {
      queryParams: { tab: t === 'overview' ? null : t },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected newIssue(): void {
    const id = this.project()?.id;
    if (id) this.ui.openCreate('issue', { projectId: id });
  }

  protected update(patch: Parameters<TramaStore['updateProject']>[1]): void {
    const p = this.project();
    if (p) void this.store.updateProject(p.id, patch);
  }

  protected setStatus(v: string | undefined): void {
    if (v) this.update({ status: v as ProjectStatus });
  }

  protected setPriority(v: string | undefined): void {
    if (v) this.update({ priority: v as Priority });
  }

  protected remove(): void {
    const p = this.project();
    if (!p) return;
    this.ui.setConfirmDelete({
      title: `Delete ${p.name}?`,
      description: 'The project is removed.',
      onConfirm: async () => {
        const ok = await this.store.deleteProject(p.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'projects']);
      },
    });
  }

  protected copyLink(): void {
    void this.clipboard.copy(location.href, 'Link copied');
  }
}
