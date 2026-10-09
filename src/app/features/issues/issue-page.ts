import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, UiStore, usePageShortcuts } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { StatsBoard } from '../stats/stats-board';
import { issuesStrip } from '../stats/stats-model';
import { IssueBoard } from './issue-board';
import { ISSUE_TABS, asViewTab, tabStatuses, type IssueViewTab } from './issue-model';
import { IssueCommandDialog } from './issue-prop';

const EMPTY: Record<IssueViewTab, { title: string; description: string }> = {
  all: {
    title: 'No issues yet',
    description:
      'Issues are demand: the bugs, requests and incidents people report. When you decide to act, add them to a workstream: the outcome that resolves them.',
  },
  active: {
    title: 'No active issues',
    description:
      'Nothing is scheduled. Move issues out of the backlog, or add them to a workstream to start resolving them.',
  },
  backlog: {
    title: 'Backlog is clear',
    description:
      'New demand lands here until someone triages it: set a priority, assign it, or add it to a workstream.',
  },
  done: {
    title: 'Nothing done yet',
    description:
      'Done and canceled issues land here. Workstreams track whether the outcome actually shipped.',
  },
  draft: {
    title: 'No saved issue drafts',
    description: 'Save an issue to finish writing or triaging it later.',
  },
};

@Component({
  selector: 'app-issue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmTooltip,
    LucideDynamicIcon,
    RouterLink,
    PageHeader,
    Kbd,
    TopBarActions,
    IssueBoard,
    StatsBoard,
    IssueCommandDialog,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (store.allowed('createIssues')) {
        <button hlmBtn size="sm" hlmTooltip="Report a bug, request or incident" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New issue</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header [title]="title()" [description]="description()">
      <nav
        leading
        class="scrollbar-none -mx-1 flex items-center gap-0.5 overflow-x-auto"
        aria-label="Issue views"
      >
        @for (t of tabs; track t.id) {
          <a
            [routerLink]="[]"
            [queryParams]="{ view: t.id === 'all' ? null : t.id }"
            queryParamsHandling="merge"
            class="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors"
            [class]="
              tab() === t.id
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
            "
            [attr.aria-current]="tab() === t.id ? 'page' : null"
            [hlmTooltip]="t.hint"
          >
            {{ t.label }}
            <span class="text-muted-foreground text-xs tabular-nums">{{ counts()[t.id] }}</span>
          </a>
        }
      </nav>
    </app-page-header>
    <app-stats-board variant="strip" [model]="stats()" [moreLink]="['/', slug(), 'stats']" />
    @if (customerRef(); as c) {
      <p class="text-muted-foreground border-b px-4 py-2 text-xs sm:px-6">
        Showing issues linked to <a class="text-foreground font-medium" [routerLink]="['/', slug(), 'customers', c.id]">{{ c.name }}</a>.
        <a class="hover:text-foreground underline" [routerLink]="[]" [queryParams]="{ customer: null }" queryParamsHandling="merge">Clear</a>
      </p>
    }
    <app-issue-board
      [issues]="visibleIssues()"
      [scope]="scope()"
      [status]="status()"
      [team]="teamRef()?.id ?? team()"
      [project]="project()"
      [emptyTitle]="empty().title"
      [emptyDescription]="empty().description"
    />
    <app-issue-command-dialog />
  `,
})
export class IssuePage {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Query `?status=backlog` from attention and saved links. */
  readonly status = input<string>();
  /** Query `?team=<teamId>` (sidebar team links). */
  readonly team = input<string>();
  /** Query `?project=<projectId>`: only issues of that project (own or through its workstreams). */
  readonly project = input<string>();
  /** Query `?view=active|backlog|done` (view tabs). */
  readonly view = input<string>();
  /** Query `?customer=<customerId>`: only issues linked to that customer. */
  readonly customer = input<string>();

  protected readonly plus = LucidePlus;
  protected readonly tabs = ISSUE_TABS;
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly stats = computed(() => issuesStrip(this.store));
  protected readonly tab = computed(() => asViewTab(this.view()));
  protected readonly scope = computed(() => tabStatuses(this.tab()));
  protected readonly empty = computed(() => EMPTY[this.tab()]);
  protected readonly teamRef = computed(() => this.store.getTeam(this.team()));
  protected readonly customerRef = computed(() => this.store.getCustomer(this.customer()));
  protected readonly visibleIssues = computed(() => {
    const id = this.customerRef()?.id;
    if (!this.customer()) return this.store.issues();
    if (!id) return [];
    const ids = new Set(this.store.customerRequests().filter((r) => r.customerId === id && r.issueId).map((r) => r.issueId));
    return this.store.issues().filter((i) => ids.has(i.id));
  });
  protected readonly title = computed(() =>
    this.teamRef() ? `${this.teamRef()!.name} issues` : 'Issues',
  );
  protected readonly description = computed(() =>
    this.teamRef()
      ? `Demand reported to ${this.teamRef()!.name}. Group related issues into a workstream to drive an outcome.`
      : 'Demand: bugs, requests and incidents. Group related issues into a workstream to drive an outcome.',
  );
  /** Issue count per tab (within the team, when scoped to one). */
  protected readonly counts = computed(() => {
    const teamId = this.teamRef()?.id;
    const list = teamId
      ? this.store.issues().filter((i) => i.teamId === teamId)
      : this.store.issues();
    const out = {} as Record<IssueViewTab, number>;
    for (const t of ISSUE_TABS)
      out[t.id] = t.statuses
        ? list.filter((i) => t.statuses!.includes(i.status)).length
        : list.length;
    return out;
  });

  private readonly _keys = usePageShortcuts([
    {
      keys: 'c',
      label: 'New issue',
      group: 'Issues',
      run: () => this.store.allowed('createIssues') && this.create(),
    },
  ]);

  protected create(): void {
    const teamId = this.teamRef()?.id;
    const status = this.scope()?.[0];
    this.ui.openCreate('issue', {
      ...(teamId ? { teamId } : {}),
      ...(status && status !== 'done' ? { status } : {}),
    });
  }
}
