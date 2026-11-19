// A project page: the content (overview, milestones, tasks, stats). The project's properties
// (status, priority, lead, dates…) live in the right pane while the page is open: the page registers
// itself as the pane's content with `RightPaneStore.setPage`.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideBox,
  LucideDynamicIcon,
  LucideEllipsis,
  LucidePanelRight,
  LucidePlus,
  LucideLink,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { PROJECT_KEY_MAX } from '../../core/contracts/domain';
import {
  TramaStore,
  UiStore,
  usePageShortcuts,
  type ActorRef,
  type DomainEvent,
  type Issue,
} from '../../core';
import { RightPaneStore, type RightPaneContent } from '../../core/stores/right-pane.store';
import { Viewport } from '../../core/viewport';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { Clipboard } from '../../core/notify/notifier';
import { EmptyState } from '../../shared/empty-state';
import { StatusBar } from '../../layout/status-bar';
import { PageHeader } from '../../shared/page-header';
import { isClosedIssue } from '../issues/issue-model';
import { ProjectTasksTab } from '../issues/project-tasks-tab';
import { ProjectMilestones } from '../milestones/project-milestones';
import { EventLine } from '../../shared/event-line';
import { CommentThread } from '../../shared/comments';
import { EditableMarkdown, InlineText } from '../../shared/inline-edit';
import { ProjectAiSummaryButton, ProjectIssueSuggestions, ProjectRisksCard } from './project-ai';
import { ProjectGlyphPicker } from './project-glyph';
import { ProjectLunagest } from './project-lunagest';
import { ProjectStatsTab } from './project-stats-tab';

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
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TopBarActions,
    EmptyState,
    CommentThread,
    EditableMarkdown,
    InlineText,
    EventLine,
    ProjectMilestones,
    HlmTabsImports,
    HlmTooltip,
    PageHeader,
    StatusBar,
    ProjectAiSummaryButton,
    ProjectIssueSuggestions,
    ProjectRisksCard,
    ProjectGlyphPicker,
    ProjectLunagest,
    ProjectStatsTab,
    ProjectTasksTab,
  ],
  host: { class: 'flex min-h-full min-w-0 flex-col' },
  template: `
    @if (project(); as p) {
      <app-page-header [title]="p.name" [actors]="members()" />

      @if (current() !== 'tasks') {
        <app-status-bar>
          <span class="tabular-nums">{{ issues().length }} {{ issues().length === 1 ? 'task' : 'tasks' }} · {{ openCount() }} open</span>
          @if (milestoneCount()) {
            <span class="tabular-nums">{{ milestoneCount() }} {{ milestoneCount() === 1 ? 'milestone' : 'milestones' }}</span>
          }
          @if (p.repository) {
            <span class="truncate font-mono">{{ p.repository }}</span>
          }
        </app-status-bar>
      }

      <ng-template appTopBarActions>
        @if (showDetailsButton()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground gap-1.5" (click)="pane.toggle()">
            <svg [lucideIcon]="detailsIcon" [size]="14"></svg>Details
          </button>
        }
        @if (canCreateIssue()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground gap-1.5" (click)="newIssue()">
            <svg [lucideIcon]="plus" [size]="14"></svg>Add task
          </button>
        }
        <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground gap-1.5" (click)="copyLink()">
          <svg [lucideIcon]="linkIcon" [size]="14"></svg>Copy link
        </button>
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
            @if (canManage()) {
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete project
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <header class="px-4 pt-4 sm:px-5">
        <div class="flex min-w-0 items-center gap-2.5">
          <app-project-glyph-picker [project]="p" [canEdit]="canManage()" />
          <app-inline-text
            class="min-w-0 flex-1"
            label="project name"
            textClass="text-xl tracking-tight"
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

        <hlm-tabs [tab]="current()" (tabActivated)="setTab($event)" class="-mx-4 mt-3 sm:-mx-5">
          <div class="scrollbar-none overflow-x-auto px-4 sm:px-5">
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
          <app-project-tasks-tab [projectId]="p.id" />
        }
        @case ('stats') {
          <div class="min-w-0 flex-1 px-4 py-5 sm:px-5">
            <app-project-stats-tab [project]="p" />
          </div>
        }
        @default {
          <div class="flex min-w-0 max-w-4xl flex-col gap-8 px-4 py-5 sm:px-5">
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
              <h2 class="text-muted-foreground mb-1 text-[13px] font-normal">Activity</h2>
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
              <h2 class="text-muted-foreground mb-2 text-[13px] font-normal">Comments</h2>
              <app-comment-thread [subject]="{ type: 'project', id: p.id }" />
            </section>
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
  protected readonly pane = inject(RightPaneStore);
  private readonly viewport = inject(Viewport);

  protected readonly box = LucideBox;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly linkIcon = LucideLink;
  protected readonly plus = LucidePlus;
  protected readonly detailsIcon = LucidePanelRight;
  protected readonly tabs = TABS;
  protected readonly tabLabel = TAB_LABEL;
  protected readonly projectKeyMax = PROJECT_KEY_MAX;
  protected readonly activityCap = ACTIVITY_CAP;
  protected readonly allActivity = signal(false);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly project = computed(() => this.store.getProject(this.id()));
  protected readonly canCreateIssue = computed(() => this.store.can('member'));
  /** The properties are in the right pane: phones, and a closed pane, get a button to bring it back. */
  protected readonly showDetailsButton = computed(() => this.viewport.isMobile() || !this.pane.open());
  protected readonly current = computed<Tab>(() => {
    const t = this.tab();
    return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'overview';
  });
  protected readonly issues = computed<readonly Issue[]>(() => {
    const id = this.project()?.id;
    return id ? (this.store.issuesByProject().get(id) ?? []) : [];
  });
  protected readonly counts = computed<Partial<Record<Tab, number>>>(() => ({
    tasks: this.issues().length,
  }));
  protected readonly openCount = computed(
    () => this.issues().filter((i) => !isClosedIssue(i, this.store.settings().statuses.issue)).length,
  );
  protected readonly milestoneCount = computed(
    () => this.store.milestonesByProject().get(this.id() ?? '')?.length ?? 0,
  );
  /** People working on the project: its lead, then the assignees of its open tasks. */
  protected readonly members = computed<ActorRef[]>(() => {
    const ids = new Set<string>();
    const lead = this.project()?.leadId;
    if (lead) ids.add(lead);
    for (const i of this.issues())
      if (i.assigneeId && !isClosedIssue(i, this.store.settings().statuses.issue)) ids.add(i.assigneeId);
    return [...ids].map((id) => ({ type: 'user', id }));
  });
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

  /** The right pane shows this project's properties while the page is open. */
  private readonly _pane = (() => {
    const projectId = computed(() => this.project()?.id);
    let mine: RightPaneContent | null = null;
    effect(() => {
      const id = projectId();
      this.pane.setPage((mine = id ? { kind: 'project', id } : null));
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.pane.pageContent() === mine) this.pane.setPage(null);
    });
  })();

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
