// The Tasks page (/:ws/tasks) and the Board page (/:ws/board): the one task table, with the v3 header
// (Filter F · New task C) and a filter bar whose Status chip carries the old All / Active / Backlog /
// Done / Drafts tabs. The Board route sets `data.layout = 'board'`.
import { ChangeDetectionStrategy, Component, computed, inject, input, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, UiStore, usePageShortcuts } from '../../core';
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

/** Chips of the Tasks page; the board's columns are the statuses, so it only keeps Thread. */
const LIST_CHIPS = ['status', 'assigneeId', 'projectId', 'thread', 'source'] as const;
const BOARD_CHIPS = ['thread'] as const;

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
      <button hlmBtn variant="outline" type="button" (click)="board()?.openSearch()">
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
      [pageSwitch]="true"
      [chipFields]="chips()"
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

  protected readonly isBoard = computed(() => this.layout() === 'board');
  protected readonly layouts = computed<readonly IssueLayout[]>(() =>
    this.isBoard() ? ['board'] : ['list', 'flow'],
  );
  protected readonly chips = computed<readonly string[]>(() =>
    this.isBoard() ? BOARD_CHIPS : LIST_CHIPS,
  );
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly tab = computed(() => asViewTab(this.view()));
  protected readonly scope = computed(() => tabStatuses(this.tab()));
  protected readonly empty = computed(() => EMPTY[this.tab()]);
  /** The snapshot is still on its way and there is nothing to show yet: the loader replaces the empty state. */
  protected readonly awaitingTasks = computed(
    () => this.store.status() === 'loading' && this.store.issues().length === 0,
  );
  protected readonly title = computed(() => (this.isBoard() ? 'Board' : 'All tasks'));
  protected readonly counts = computed(() => {
    const list = this.store.issues();
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
      ...(status && status !== 'done' ? { status } : {}),
    });
  }
}
