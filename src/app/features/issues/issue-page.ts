// The Tasks page (/:ws/tasks) and the Board page (/:ws/board): the one task table, with the v3 header
// (Filter F · New task C) and a filter bar whose Status chip carries the old All / Active / Backlog /
// Done / Drafts tabs. The Board route sets `data.layout = 'board'`. My tasks (/:ws/my-tasks, route data
// `mine`) is the same table under a fixed "Assignee is me" scope, with its own list / board switch.
import { ChangeDetectionStrategy, Component, computed, inject, input, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, UiStore, usePageShortcuts, type ViewFilter } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { TramaLoader } from '../../shared/trama-loader';
import type { FilterPreset } from '../../shared/filter-bar/filter-bar';
import { IssueBoard } from './issue-board';
import { ISSUE_TABS, asViewTab, tabStatuses, type IssueLayout, type IssueViewTab } from './issue-model';
import { IssueCommandDialog } from './issue-prop';

const EMPTY: Record<IssueViewTab, { title: string; description: string }> = {
  all: {
    title: 'No tasks yet',
    description: 'Track bugs, requests and incidents from triage through completion.',
  },
  active: {
    title: 'No active tasks',
    description: 'Nothing is scheduled. Move tasks out of the backlog to start resolving them.',
  },
  backlog: {
    title: 'Backlog is clear',
    description: 'New tasks land here until someone triages them: set a priority or assign them.',
  },
  done: {
    title: 'Nothing done yet',
    description: 'Done and canceled tasks land here.',
  },
  draft: {
    title: 'No saved task drafts',
    description: 'Save a task to finish writing or triaging it later.',
  },
};

const MY_LAYOUTS: readonly IssueLayout[] = ['list', 'board'];

@Component({
  selector: 'app-issue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmTooltip,
    PageHeader,
    Kbd,
    TopBarActions,
    IssueBoard,
    IssueCommandDialog,
    TramaLoader,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      <button hlmBtn variant="outline" type="button" (click)="board()?.openFilter()">
        Filter <app-kbd keys="f" />
      </button>
      @if (store.allowed('createIssues')) {
        <button hlmBtn hlmTooltip="Report a bug, request or incident" (click)="create()">
          New task <app-kbd keys="c" />
        </button>
      }
    </ng-template>

    <app-page-header [title]="title()" />
    @if (awaitingTasks()) {
      <div class="flex min-h-0 flex-1 items-center justify-center">
        <app-trama-loader [size]="40" caption="Loading tasks…" />
      </div>
    } @else {
    <app-issue-board
      [issues]="store.issues()"
      [scope]="scope()"
      [status]="status()"
      [project]="project()"
      [layouts]="layouts()"
      [pageSwitch]="!isMine()"
      [syncUrl]="true"
      [urlFilters]="f()"
      [urlMatch]="match()"
      [baseFilters]="baseFilters()"
      [showBase]="isMine()"
      [stateKey]="isMine() ? 'my-tasks' : 'issues'"
      [storageKey]="isMine() ? 'trama.my-tasks.display.v1' : 'trama.issues.display.v1'"
      [createDefaults]="createDefaults()"
      [statusPresets]="presets()"
      [statusPreset]="tab()"
      (statusPresetChange)="pickTab($event)"
      [emptyTitle]="empty().title"
      [emptyDescription]="empty().description"
    />
    }
    <app-issue-command-dialog />
  `,
})
export class IssuePage {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  protected readonly board = viewChild(IssueBoard);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Query `?status=backlog` from attention and saved links. */
  readonly status = input<string>();
  /** Query `?project=<projectId>`: only tasks planned under that project. */
  readonly project = input<string>();
  /** Query `?view=active|backlog|done` (the Status chip's views; old tab links). */
  readonly view = input<string>();
  /** Route data: `board` on /:ws/board. */
  readonly layout = input<string>();
  /** Route data: true on /:ws/my-tasks. */
  readonly mine = input<boolean>();
  /** Query `?f=status:in:todo` (repeated): the filters of a link. */
  readonly f = input<string | readonly string[]>();
  /** Query `?match=any`. */
  readonly match = input<string>();

  protected readonly isBoard = computed(() => this.layout() === 'board');
  protected readonly isMine = computed(() => this.mine() === true);
  protected readonly layouts = computed<readonly IssueLayout[]>(() =>
    this.isMine() ? MY_LAYOUTS : this.isBoard() ? ['board'] : ['list'],
  );
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  /** The board has no Status chip (v3 · 04): it always shows every status as a column. */
  protected readonly tab = computed(() => (this.isBoard() ? 'all' : asViewTab(this.view())));
  protected readonly scope = computed(() => tabStatuses(this.tab()));
  /** The snapshot is still on its way and there is nothing to show yet: the loader replaces the empty state. */
  protected readonly awaitingTasks = computed(
    () => this.store.status() === 'loading' && this.store.issues().length === 0,
  );
  protected readonly empty = computed(() =>
    this.isMine() && this.tab() === 'all'
      ? { title: 'Nothing assigned to you', description: 'Tasks assigned to you show up here.' }
      : EMPTY[this.tab()],
  );
  protected readonly title = computed(() =>
    this.isMine() ? 'My tasks' : this.isBoard() ? 'Board' : 'All tasks',
  );
  /** The fixed scope of My tasks: assigned to me. */
  protected readonly baseFilters = computed<readonly ViewFilter[]>(() => {
    const me = this.store.me()?.id;
    return this.isMine() && me ? [{ field: 'assigneeId', op: 'in', value: [me] }] : [];
  });
  /** The tasks the page is about (everything, or mine). */
  private readonly pool = computed(() => {
    const me = this.store.me()?.id;
    return this.isMine() ? this.store.issues().filter((i) => i.assigneeId === me) : this.store.issues();
  });
  protected readonly createDefaults = computed<Record<string, unknown>>(() => {
    const me = this.store.me()?.id;
    return this.isMine() && me ? { assigneeId: me } : {};
  });
  protected readonly counts = computed(() => {
    const list = this.pool();
    const out = {} as Record<IssueViewTab, number>;
    for (const t of ISSUE_TABS)
      out[t.id] = t.statuses
        ? list.filter((i) => t.statuses!.includes(i.status)).length
        : list.length;
    return out;
  });
  protected readonly presets = computed<readonly FilterPreset[]>(() =>
    ISSUE_TABS.map((t) => ({ id: t.id, label: t.label, count: this.counts()[t.id] })),
  );

  private readonly _keys = usePageShortcuts([
    {
      keys: 'c',
      label: 'New task',
      group: 'Tasks',
      run: () => this.store.allowed('createIssues') && this.create(),
    },
  ]);

  /** A view of the Status chip: kept in the URL as `?view=` so it can be linked and survives reloads. */
  protected pickTab(id: string): void {
    void this.router.navigate([], {
      queryParams: { view: id === 'all' ? null : id },
      queryParamsHandling: 'merge',
    });
  }

  protected create(): void {
    const status = this.scope()?.[0];
    this.ui.openCreate('issue', {
      ...this.createDefaults(),
      ...(status && status !== 'done' ? { status } : {}),
    });
  }
}
