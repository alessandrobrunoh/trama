// A project page (v3 "08 · Project", "33 · Project · Progress"): the kicker, the serif title and summary, the
// health badge and the tabs; the roadmap and the milestones beside the rail (about, thread coverage, recent
// records and the editable properties). The Progress tab adds the burn-up and a sparkline per milestone.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideArrowRightLeft,
  LucideBox,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideLink,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { PROJECT_KEY_MAX, resolveStatusEntry } from '../../core/contracts/domain';
import {
  ListStateStore,
  TramaStore,
  UiStore,
  usePageShortcuts,
  type ActorRef,
  type DomainEvent,
  type Issue,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { Clipboard } from '../../core/notify/notifier';
import { EmptyState } from '../../shared/empty-state';
import { StatusBar } from '../../layout/status-bar';
import { PageHeader } from '../../shared/page-header';
import { Kbd } from '../../shared/kbd';
import { V3SectionTitle } from '../../shared/v3';
import { isClosedIssue } from '../issues/issue-model';
import { ProjectTasksTab } from '../issues/project-tasks-tab';
import { dayOf, todayDay, usesPoints } from '../milestones/milestone-model';
import { EventLine } from '../../shared/event-line';
import { CommentThread } from '../../shared/comments';
import { EditableMarkdown, InlineText } from '../../shared/inline-edit';
import { ProjectAiSummaryButton, ProjectIssueSuggestions, ProjectRisksCard } from './project-ai';
import { ProjectBurnup } from './project-burnup';
import { buildBurnView, burnBadge, projectTargetDay, type BurnTone } from './project-burnup-model';
import { ProjectGlyphPicker } from './project-glyph';
import { ProjectMilestoneCards } from './project-milestone-cards';
import { ProjectMilestoneRows } from './project-milestone-rows';
import { ProjectProperties } from './project-properties';
import { ProjectTransferDialog } from './project-transfer-dialog';
import { ProjectRoadmap } from './project-roadmap';
import { ProjectShareDialog } from './project-share-dialog';
import { applyTasksPrefilter, prefilterOf, tasksQuery } from './project-tasks-link';
import { ProjectSourcesStore } from './sources/project-sources.store';
import { ProjectSourcesTab } from './sources/project-sources-tab';

const TABS = ['overview', 'progress', 'tasks', 'sources'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  progress: 'Progress',
  tasks: 'Tasks',
  sources: 'Sources',
};

const ACTIVITY_CAP = 20;

/** Health colours for a badge derived from the burn-up (a health set by hand uses its catalog colour). */
const TONE_COLOR: Record<BurnTone, string> = {
  ok: 'var(--status-done)',
  warn: 'var(--status-in-progress)',
  late: 'var(--red)',
  idle: 'var(--muted-foreground)',
};

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
    Kbd,
    PageHeader,
    StatusBar,
    V3SectionTitle,
    ProjectAiSummaryButton,
    ProjectBurnup,
    ProjectIssueSuggestions,
    ProjectRisksCard,
    ProjectGlyphPicker,
    ProjectMilestoneCards,
    ProjectMilestoneRows,
    ProjectRoadmap,
    ProjectShareDialog,
    ProjectTasksTab,
    ProjectSourcesTab,
    ProjectProperties,
    ProjectTransferDialog,
  ],
  host: { class: 'flex min-h-full min-w-0 flex-col' },
  template: `
    @if (project(); as p) {
      <app-page-header [title]="p.name" [actors]="members()" />

      @if (current() !== 'tasks') {
        <app-status-bar>
          <span class="tabular-nums">
            <a class="hover:text-foreground underline-offset-2 hover:underline" [routerLink]="projectLink()" [queryParams]="allTasks">{{ issues().length }} {{ issues().length === 1 ? 'task' : 'tasks' }}</a>
            ·
            <a class="hover:text-foreground underline-offset-2 hover:underline" [routerLink]="projectLink()" [queryParams]="openTasks">{{ openCount() }} open</a>
          </span>
          @if (milestoneCount()) {
            <span class="tabular-nums">{{ milestoneCount() }} {{ milestoneCount() === 1 ? 'milestone' : 'milestones' }}</span>
          }
          @if (p.repository) {
            <span class="truncate font-mono">{{ p.repository }}</span>
          }
        </app-status-bar>
      }

      <ng-template appTopBarActions>
        @if (canShare()) {
          <button hlmBtn variant="outline" (click)="sharing.set(true)">Share</button>
        }
        <button hlmBtn variant="outline" (click)="openSettings()">
          Project settings <app-kbd keys="shift+p" />
        </button>
        <button
          hlmBtn
          variant="outline"
          size="icon"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="more"
          aria-label="Project actions"
        >
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        @if (canCreateIssue()) {
          <button hlmBtn (click)="newIssue()">New task <app-kbd keys="c" /></button>
        }
        <ng-template #more>
          <hlm-dropdown-menu class="w-48">
            <button hlmDropdownMenuItem (triggered)="copyLink()">
              <svg [lucideIcon]="linkIcon" [size]="14" class="text-muted-foreground"></svg> Copy link
            </button>
            @if (canTransfer()) {
              <button hlmDropdownMenuItem (triggered)="transferOpen.set(true)">
                <svg [lucideIcon]="transferIcon" [size]="14" class="text-muted-foreground"></svg> Transfer to workspace…
              </button>
            }
            @if (canManage()) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete project
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      @if (canShare()) {
        <app-project-share-dialog [project]="p" [(open)]="sharing" />
      }

      <header class="flex flex-col gap-4 px-4 pt-6 sm:px-10">
        <div class="flex items-end gap-5">
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <div class="flex min-w-0 items-center gap-2 font-mono text-[10.5px] leading-[normal] uppercase">
              <app-project-glyph-picker class="-mx-2.5 -my-[11px]" [project]="p" [canEdit]="canManage()" [size]="12" />
              <span class="text-faint">Project ·</span>
              <app-inline-text
                class="-mx-1.5 -my-1 w-14 shrink-0"
                label="project tag"
                textClass="text-faint font-mono text-[10.5px] leading-[normal]"
                [value]="p.key"
                [canEdit]="canManage()"
                [maxLength]="projectKeyMax"
                [mono]="true"
                title="Project tag; changing it updates this project's task keys"
                (save)="update({ key: $event })"
              />
              @if (p.repository) {
                <span class="text-faint min-w-0 truncate normal-case">· {{ p.repository }}</span>
              }
            </div>
            <app-inline-text
              class="-mx-1.5 -my-1 min-w-0"
              label="project name"
              textClass="font-title text-foreground text-[36px] leading-[normal] tracking-[-0.5px]"
              [value]="p.name"
              [canEdit]="canManage()"
              (save)="update({ name: $event })"
            />
            <div class="flex min-w-0 items-center gap-2">
              <app-inline-text
                class="-mx-1.5 -my-1 min-w-0 flex-1"
                label="summary"
                placeholder="Add a short summary…"
                textClass="text-muted-foreground text-sm leading-[18px]"
                [value]="p.summary ?? ''"
                [canEdit]="canManage()"
                [allowEmpty]="true"
                (save)="update({ summary: $event.trim() || null })"
              />
              @if (canManage()) {
                <app-project-ai-summary-button class="-my-2.5 shrink-0" [project]="p" />
              }
            </div>
          </div>
          @if (health(); as h) {
            <span
              class="text-foreground inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] leading-[14px]"
              [style.border-color]="'color-mix(in srgb, ' + h.color + ' 40%, transparent)'"
            >
              <span class="size-[7px] shrink-0" [style.background]="h.color" aria-hidden="true"></span>{{ h.label }}
            </span>
          }
        </div>

        <div class="border-border -mb-px flex gap-[22px] border-b" role="tablist" aria-label="Project sections">
          @for (t of tabs; track t; let i = $index) {
            <button
              type="button"
              role="tab"
              class="-mb-px flex flex-none items-start gap-1.5 border-b-2 pb-2 text-[13px] leading-4 whitespace-nowrap outline-none focus-visible:underline"
              [class]="current() === t ? 'border-red text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent'"
              [attr.aria-selected]="current() === t"
              [title]="tabLabel[t] + ' (' + (i + 1) + ')'"
              (click)="setTab(t)"
            >
              {{ tabLabel[t] }}
              @if (counts()[t]) {
                <span class="text-faint font-mono text-[10.5px] leading-4 tabular-nums">{{ counts()[t] }}</span>
              }
            </button>
          }
        </div>
      </header>

      @switch (current()) {
        @case ('tasks') {
          <app-project-tasks-tab [projectId]="p.id" />
        }
        @case ('sources') {
          <app-project-sources-tab [projectId]="p.id" />
        }
        @default {
          <div class="flex min-w-0 flex-1 max-lg:flex-col">
            <div class="flex min-w-0 flex-1 flex-col gap-[22px] px-4 py-[22px] sm:px-10">
              <app-project-roadmap [project]="p" />

              @if (current() === 'progress') {
                <app-project-burnup [project]="p" />
                <app-project-milestone-rows [project]="p" />
              } @else {
                <app-project-milestone-cards [project]="p" />

                <section class="flex flex-col gap-2.5" aria-label="Description">
                  <v3-section-title title="Description" />
                  <app-editable-markdown
                    label="description"
                    placeholder="Describe the outcome, scope and why it matters…"
                    [value]="p.description ?? ''"
                    [canEdit]="canManage()"
                    [uploads]="true"
                    (save)="update({ description: $event.trim() || null })"
                  />
                </section>

                @if (canManage()) {
                  <app-project-risks-card [project]="p" />
                  <app-project-issue-suggestions [project]="p" />
                }

                <section class="flex flex-col gap-2.5">
                  <v3-section-title title="Activity" />
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
                        class="text-muted-foreground self-start"
                        (click)="allActivity.set(true)"
                      >
                        Show all {{ activity().length }}
                      </button>
                    }
                  } @else {
                    <p class="text-faint font-mono text-[11px]">Nothing has happened here in the recent history.</p>
                  }
                </section>

                <section class="flex flex-col gap-2.5">
                  <v3-section-title title="Comments" />
                  <app-comment-thread [subject]="{ type: 'project', id: p.id }" />
                </section>
              }
            </div>
            <aside class="bg-card border-border shrink-0 max-lg:border-t lg:w-[300px] lg:border-l" aria-label="Project properties">
              <app-project-properties [id]="p.id" />
            </aside>
          </div>
        }
      }
      @if (canTransfer()) {
        <app-project-transfer-dialog [project]="p" [(open)]="transferOpen" />
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
  /** `?status=` / `?milestone=` from a link into the Tasks tab (see `project-tasks-link`). */
  readonly status = input<string>();
  readonly milestone = input<string>();

  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);
  private readonly listState = inject(ListStateStore);
  private readonly sources = inject(ProjectSourcesStore);

  protected readonly box = LucideBox;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly linkIcon = LucideLink;
  protected readonly transferIcon = LucideArrowRightLeft;
  protected readonly transferOpen = signal(false);
  /** Owners and admins of the open workspace; the target workspace is checked by the server. */
  protected readonly canTransfer = computed(() => this.store.can('admin'));
  protected readonly tabs = TABS;
  protected readonly tabLabel = TAB_LABEL;
  protected readonly allTasks = tasksQuery();
  protected readonly openTasks = tasksQuery({ status: ['open'] });
  protected readonly projectKeyMax = PROJECT_KEY_MAX;
  protected readonly activityCap = ACTIVITY_CAP;
  protected readonly allActivity = signal(false);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly projectLink = computed(() => ['/', this.slug(), 'projects', this.id() ?? '']);
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  /** Sharing a project with guests: the "Share projects" capability (owner, admin, organizer by default). */
  protected readonly canShare = computed(() => this.store.allowed('inviteToProject'));
  protected readonly sharing = signal(false);
  protected readonly project = computed(() => this.store.getProject(this.id()));
  protected readonly canCreateIssue = computed(() => this.store.can('member'));
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
    sources: this.sources.count(),
  }));
  protected readonly openCount = computed(
    () => this.issues().filter((i) => !isClosedIssue(i, this.store.settings().statuses.issue)).length,
  );
  protected readonly milestoneCount = computed(
    () => this.store.milestonesByProject().get(this.id() ?? '')?.length ?? 0,
  );

  /** The health set by hand; else what the burn-up says (once the project has tasks). */
  protected readonly health = computed<{ label: string; color: string } | null>(() => {
    const p = this.project();
    if (!p) return null;
    if (p.health) {
      const entry = resolveStatusEntry(this.store.settings().statuses.projectHealth, p.health);
      return { label: entry?.name ?? p.health, color: entry?.color ?? 'var(--muted-foreground)' };
    }
    const issues = this.issues();
    if (!issues.some((i) => i.status !== 'canceled')) return null;
    const target = projectTargetDay(p, this.store.milestonesByProject().get(p.id) ?? []);
    const view = buildBurnView({
      issues,
      points: usesPoints(issues, this.store.estimateScale()),
      startDay: dayOf(p.startDate ?? p.createdAt),
      targetDay: target,
      today: todayDay(),
      endHint: target,
      pad: 14,
    });
    const badge = burnBadge(view.model);
    return { label: badge.label, color: TONE_COLOR[badge.tone] };
  });

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

  /** The Sources tab counts the project's rules; the tab itself loads them when it is open. */
  private readonly _sources = effect(() => {
    const id = this.project()?.id;
    if (!id || this.current() === 'sources') return;
    untracked(() => void this.sources.load(id));
  });

  /** A link into the Tasks tab brings its filters in the params: apply them once, then drop them. */
  private readonly _prefilter = effect(() => {
    const p = this.project();
    const status = this.status();
    const milestone = this.milestone();
    if (!p || this.current() !== 'tasks' || (!status && !milestone)) return;
    untracked(() => {
      const entries = this.store.settings().statuses.issue;
      applyTasksPrefilter(this.listState, p.id, prefilterOf(p.id, entries, status, milestone));
      void this.router.navigate([], {
        queryParams: { status: null, milestone: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
  });

  private readonly _keys = usePageShortcuts([
    ...TABS.map((t, i) => ({
      keys: String(i + 1),
      label: `${TAB_LABEL[t]} tab`,
      run: () => this.setTab(t),
      when: () => !!this.project(),
    })),
    {
      keys: 'shift+p',
      label: 'Project settings',
      run: () => this.openSettings(),
      when: () => !!this.project(),
    },
  ]);

  protected setTab(t: string | null | undefined): void {
    if (!t) return;
    void this.router.navigate([], {
      queryParams: { tab: t === 'overview' ? null : t },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** The properties live in the rail: bring them into view and focus the first one. */
  protected openSettings(): void {
    const c = this.current();
    if (c === 'tasks' || c === 'sources') this.setTab('overview');
    setTimeout(() => {
      const el = document.getElementById('project-properties');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
    }, 80);
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
