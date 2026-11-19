import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChevronRight, LucideDynamicIcon, LucideInbox, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { ListStateStore, TimeEntriesStore, TramaStore, UiStore } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { StatusIcon } from '../../shared/status';
import { DEFAULT_IDLE_DAYS, activityLookup, weekSummary } from '../stats/flow-stats';
import { formatDuration } from '../stats/insights';
import { MyTaskRow } from './my-task-row';
import { countOpen, groupMyTasks, isClosed } from './my-tasks';

type Scope = 'assigned' | 'created';

/**
 * The "My tasks" tab of the Inbox: what is on my plate, grouped by where it stands (in progress, idle, up next,
 * backlog), and what I reported. A one-line summary of the week sits on top.
 */
@Component({
  selector: 'app-my-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmSwitchImports,
    HlmToggleGroupImports,
    TopBarActions,
    EmptyState,
    Kbd,
    StatusIcon,
    MyTaskRow,
  ],
  host: { class: 'flex flex-1 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" variant="outline" (click)="newTask()">
          <svg [lucideIcon]="plusIcon" [size]="14"></svg>
          <span>New task</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <div class="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 sm:px-6">
      <p class="text-meta" aria-live="polite">{{ description() }}</p>
      <span class="flex-1"></span>
      <hlm-toggle-group
        type="single"
        variant="outline"
        size="sm"
        [value]="scope()"
        (valueChange)="setScope($event)"
        aria-label="Which tasks"
      >
        <button hlmToggleGroupItem value="assigned" class="max-sm:h-9">Assigned to me</button>
        <button hlmToggleGroupItem value="created" class="max-sm:h-9">Created by me</button>
      </hlm-toggle-group>
      <span class="text-muted-foreground flex items-center gap-2 text-xs">
        <hlm-switch [checked]="showClosed()" (checkedChange)="showClosed.set($event)" aria-labelledby="show-closed-label" />
        <span id="show-closed-label">Show closed</span>
      </span>
    </div>

    @if (scope() === 'assigned') {
      @if (week(); as w) {
        <p class="text-meta flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-1 sm:px-6">
          <span>
            This week
            <span class="text-foreground font-medium tabular-nums">{{ w.doneThis }}</span> completed
            <span class="tabular-nums">({{ w.doneThis >= w.doneLast ? '+' : '−' }}{{ abs(w.doneThis - w.doneLast) }} vs last week)</span>
          </span>
          @if (w.pointsThis) {
            <span><span class="text-foreground font-medium tabular-nums">{{ w.pointsThis }}</span> estimate points</span>
          }
          @if (w.medianCycle !== undefined) {
            <span>typically <span class="text-foreground font-medium tabular-nums">{{ days(w.medianCycle) }}</span> to finish</span>
          }
          <a class="hover:text-foreground ms-auto" [routerLink]="['/', slug(), 'stats']" [queryParams]="{ person: 'me' }">Your statistics</a>
        </p>
      }

      @for (g of groups(); track g.id) {
        <section [attr.aria-label]="g.label">
          <button
            type="button"
            class="hover:bg-hover mt-2 flex h-8 w-full items-center gap-2 px-4 text-left text-xs sm:px-6"
            [attr.aria-expanded]="!isFolded(g.id)"
            (click)="toggleFold(g.id)"
          >
            <span
              class="text-muted-foreground flex shrink-0 transition-transform"
              [class.rotate-90]="!isFolded(g.id)"
            >
              <svg [lucideIcon]="chevron" [size]="12"></svg>
            </span>
            <app-status-icon entity="issue" [status]="g.status" />
            <span class="font-medium">{{ g.label }}</span>
            <span class="text-muted-foreground tabular-nums">{{ g.items.length }}</span>
            <span class="text-meta ms-2 hidden truncate md:inline">{{ g.hint }}</span>
          </button>
          @if (!isFolded(g.id)) {
            @for (i of g.items; track i.id) {
              <app-my-task-row [issue]="i" [focused]="ui.focusedRowId() === i.id" [dim]="g.id === 'idle'" />
            }
          }
        </section>
      } @empty {
        <app-empty-state
          class="m-auto"
          [icon]="inboxIcon"
          title="No tasks assigned to you"
          description="Pick something up from the backlog, or report what you have noticed."
        >
          <div class="flex flex-wrap justify-center gap-2">
            <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'tasks']" [queryParams]="{ status: 'backlog' }">Browse backlog</a>
            @if (canEdit()) {
              <button hlmBtn size="sm" variant="ghost" (click)="newTask()">New task</button>
            }
          </div>
        </app-empty-state>
      }
    } @else {
      @for (i of created(); track i.id) {
        <app-my-task-row [issue]="i" [focused]="ui.focusedRowId() === i.id" />
      } @empty {
        <app-empty-state
          class="m-auto"
          [icon]="inboxIcon"
          title="You have not created any tasks yet"
          description="Tasks you report are collected here."
        />
      }
    }
  `,
})
export class MyTasks {
  /** Workspace slug from the route. */
  readonly workspaceSlug = input<string>();

  protected readonly store = inject(TramaStore);
  private readonly listState = inject(ListStateStore);
  protected readonly ui = inject(UiStore);
  private readonly time = inject(TimeEntriesStore);

  protected readonly plusIcon = LucidePlus;
  protected readonly inboxIcon = LucideInbox;
  protected readonly chevron = LucideChevronRight;
  protected readonly abs = Math.abs;
  protected readonly days = formatDuration;
  protected readonly idleDays = DEFAULT_IDLE_DAYS;

  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));

  // Scope and filter survive navigation inside the app (see ListStateStore).
  protected readonly scope = this.listState.remember<Scope>('inbox.tasks.scope', 'assigned');
  protected readonly showClosed = this.listState.remember('inbox.tasks.showClosed', false);
  private readonly folded = signal<ReadonlySet<string>>(new Set());
  /** Re-read the clock once a minute so "idle" does not go stale on a long-open tab. */
  private readonly now = signal(Date.now());

  constructor() {
    this.ui.setFocusedRow(null);
    void this.time.load();
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  private readonly meId = computed(() => this.store.me()?.id ?? '');
  private readonly mine = computed(() => {
    const me = this.meId();
    return me ? this.store.issues().filter((i) => i.assigneeId === me) : [];
  });
  private readonly activityAt = computed(() =>
    activityLookup({
      events: this.store.eventsBySubject(),
      artifacts: this.store.artifactsByIssue(),
      entries: this.time.entries(),
      now: this.now(),
    }),
  );

  protected readonly groups = computed(() =>
    groupMyTasks(this.mine(), {
      showClosed: this.showClosed(),
      now: this.now(),
      idleDays: this.idleDays,
      activityAt: this.activityAt(),
    }),
  );

  protected readonly created = computed(() => {
    const me = this.meId();
    if (!me) return [];
    const showClosed = this.showClosed();
    return this.store
      .issues()
      .filter((i) => i.reporterId === me && (showClosed || !isClosed(i)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  protected readonly description = computed(() => {
    if (this.scope() === 'created') {
      const n = this.created().length;
      return `${n} task${n === 1 ? '' : 's'} created by you`;
    }
    const open = countOpen(this.mine());
    const idle = this.groups().find((g) => g.id === 'idle')?.items.length ?? 0;
    return `${open} open task${open === 1 ? '' : 's'} assigned to you${idle ? ` · ${idle} idle` : ''}`;
  });

  /** Last 7 days against the 7 before, from real start and finish dates; hidden when there is nothing to say. */
  protected readonly week = computed(() => {
    const mine = this.mine();
    if (!mine.length) return null;
    const w = weekSummary(mine, this.now(), this.idleDays, this.activityAt());
    return w.doneThis || w.doneLast ? w : null;
  });

  protected isFolded(id: string): boolean {
    return this.folded().has(id);
  }

  protected toggleFold(id: string): void {
    this.folded.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected setScope(v: unknown): void {
    const next: Scope = v === 'created' ? 'created' : 'assigned';
    if (next === this.scope()) return;
    this.scope.set(next);
    this.ui.setFocusedRow(null);
  }

  protected newTask(): void {
    const me = this.meId();
    this.ui.openCreate('issue', me ? { assigneeId: me, status: 'todo' } : {});
  }
}
