import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { LucideInbox } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { toast } from '@spartan-ng/brain/sonner';
import {
  ListStateStore,
  NotificationsStore,
  Notifier,
  TimeEntriesStore,
  TramaStore,
  UiStore,
  Viewport,
  resolveStatusEntry,
  usePageShortcuts,
  type AttentionItem,
} from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { DEFAULT_IDLE_DAYS, activityLookup } from '../stats/flow-stats';
import {
  INBOX_TABS,
  LEGACY_TABS,
  buildInbox,
  isInboxTab,
  tabOf,
  type InboxContext,
  type InboxEntry,
  type InboxTab,
} from './inbox-model';
import { InboxPreview } from './inbox-preview';
import { InboxRow } from './inbox-row';

const newest = (a: InboxEntry, b: InboxEntry): number => b.at.localeCompare(a.at);

/** Enter on a focused control belongs to that control, not to the selected row. */
const onControl = (): boolean =>
  document.activeElement instanceof HTMLElement &&
  !!document.activeElement.closest('a[href], button, input, textarea, select, [role="menuitem"]');

/**
 * `/:workspace/inbox` (v3 "03 · Inbox"): everything that concerns you, as one list with a preview beside it.
 *
 *   tabs      All · Mentions (assignments, comments) · Records (your tasks moving or stale) ·
 *             Sync (reviews, failing checks, conflicts, triage)
 *   list      480px; one 60px row per item, newest first, the selected one filled
 *   preview   what it is, what changed, what Trama will not do for you, and the actions with their keys
 *
 * `?tab=` opens a tab (older links such as `?tab=needs-you` still work). Phones show the list only and a tap opens
 * the item. Keyboard: J/K move, Enter opens, O opens the Delta thread, E marks read (dismisses an item),
 * D marks a task done, ⇧R marks every update read.
 */
@Component({
  selector: 'app-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    HlmButtonImports,
    EmptyState,
    Kbd,
    PageHeader,
    TopBarActions,
    InboxPreview,
    InboxRow,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Inbox" />

    <ng-template appTopBarActions>
      <button
        hlmBtn
        variant="outline"
        type="button"
        [disabled]="!notifications.unread()"
        (click)="notifications.markRead()"
      >
        Mark all read <app-kbd keys="shift+r" />
      </button>
    </ng-template>

    <div class="flex min-h-0 flex-1">
      <!-- list -->
      <div class="border-border flex min-h-0 w-full flex-col md:w-[480px] md:shrink-0 md:border-r">
        <div class="border-border flex shrink-0 items-center gap-4 overflow-x-auto border-b px-4 py-2.5" role="tablist">
          @for (t of tabs(); track t.id) {
            <button
              type="button"
              role="tab"
              class="flex shrink-0 items-baseline gap-1.5 font-mono outline-none focus-visible:underline"
              [attr.aria-selected]="tab() === t.id"
              (click)="selectTab(t.id)"
            >
              <span
                class="text-[11.5px] leading-[14px]"
                [class.text-foreground]="tab() === t.id"
                [class.text-muted-foreground]="tab() !== t.id"
                >{{ t.label }}</span
              >
              <span class="text-faint text-[10.5px] leading-[13px] tabular-nums">{{ t.count }}</span>
            </button>
          }
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Inbox">
          @for (e of list(); track e.id) {
            <app-inbox-row
              [entry]="e"
              [focused]="selected()?.id === e.id"
              [openOnClick]="viewport.isMobile()"
              (rowClicked)="ui.setFocusedRow(e.id)"
              (open)="open(e)"
            />
          } @empty {
            @if (!allClear()) {
              <p class="text-faint px-4 py-6 text-[12px]">Nothing in {{ tabLabel() }}.</p>
            }
          }
          @if (allClear() && viewport.isMobile()) {
            <ng-container *ngTemplateOutlet="empty" />
          }
        </div>
      </div>

      <!-- preview -->
      <div class="hidden min-h-0 min-w-0 flex-1 overflow-y-auto md:block">
        @if (selected(); as e) {
          <app-inbox-preview
            [entry]="e"
            (open)="open(e)"
            (markRead)="markRead(e)"
            (dismiss)="dismiss(e.attention!)"
            (toReview)="toReview(e)"
          />
        } @else if (allClear()) {
          <ng-container *ngTemplateOutlet="empty" />
        }
      </div>
    </div>

    <ng-template #empty>
      <app-empty-state
        [icon]="inboxIcon"
        title="Nothing needs you"
        description="No reviews, failing checks, stale tasks or unread updates. Anything that needs a human shows up here, with what to do next."
      >
        <div class="flex flex-wrap justify-center gap-2">
          <a hlmBtn variant="outline" [routerLink]="['/', slug(), 'tasks']">Browse tasks</a>
          @if (!store.agents().length) {
            <a hlmBtn variant="ghost" [routerLink]="['/', slug(), 'connect']">Connect your agent</a>
          }
        </div>
      </app-empty-state>
    </ng-template>

  `,
})
export class InboxPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** From `?tab=`: the tab to open (older links name a former section, see LEGACY_TABS). */
  readonly tabParam = input<string>(undefined, { alias: 'tab' });

  protected readonly store = inject(TramaStore);
  protected readonly notifications = inject(NotificationsStore);
  protected readonly ui = inject(UiStore);
  protected readonly viewport = inject(Viewport);
  private readonly listState = inject(ListStateStore);
  private readonly time = inject(TimeEntriesStore);
  private readonly notifier = inject(Notifier);
  private readonly router = inject(Router);

  protected readonly inboxIcon = LucideInbox;
  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');

  // The tab survives navigation inside the app (see ListStateStore).
  private readonly pickedTab = this.listState.remember<InboxTab>('inbox.tab', 'all');

  /** Re-read the clock once a minute so "stale" and the relative times do not go old on a long-open tab. */
  private readonly now = signal(Date.now());

  private readonly mine = computed(() => {
    const me = this.store.me()?.id;
    return me ? this.store.issues().filter((i) => i.assigneeId === me) : [];
  });

  private readonly context = computed<InboxContext>(() => ({
    now: this.now(),
    issueById: this.store.issueById(),
    artifactById: this.store.artifactById(),
    actorName: (ref) => this.store.actorName(ref),
    activityAt: activityLookup({
      events: this.store.eventsBySubject(),
      artifacts: this.store.artifactsByIssue(),
      entries: this.time.entries(),
      now: this.now(),
    }),
    idleDays: DEFAULT_IDLE_DAYS,
  }));

  private readonly entries = computed(() =>
    buildInbox(
      { attention: this.store.attention(), mine: this.mine(), notifications: this.notifications.items() },
      this.context(),
    ).flatMap((s) => s.entries),
  );

  private readonly inTab = (tab: InboxTab): InboxEntry[] => {
    const all = this.entries();
    // All: everything but what was set aside, newest first. Sync keeps the severity order of the queue.
    if (tab === 'all') return all.filter((e) => e.section !== 'later').sort(newest);
    return all.filter((e) => tabOf(e) === tab);
  };

  /** The tabs with their counts (All · Mentions · Records · Sync; the snoozed "Later" tab is not offered). */
  protected readonly tabs = computed(() =>
    INBOX_TABS.filter((t) => t.id !== 'later').map((t) => ({ ...t, count: this.inTab(t.id).length })),
  );
  protected readonly tab = computed<InboxTab>(() => {
    const t = this.pickedTab();
    return this.tabs().some((x) => x.id === t) ? t : 'all';
  });
  protected readonly tabLabel = computed(() => INBOX_TABS.find((t) => t.id === this.tab())?.label ?? 'All');

  /** The rows of the open tab. */
  protected readonly list = computed(() => this.inTab(this.tab()));

  /** Nothing to act on, nothing moving, nothing unread: the empty state. */
  protected readonly allClear = computed(() => this.inTab('all').length === 0);

  /** The selected row: the keyboard-focused one, else the first. Its preview shows on the right. */
  protected readonly selected = computed<InboxEntry | undefined>(() => {
    const list = this.list();
    const id = this.ui.focusedRowId();
    return list.find((e) => e.id === id) ?? list[0];
  });

  constructor() {
    this.ui.setFocusedRow(null);
    void this.time.load();
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));

    // The list always has a selection: keep the keyboard focus on it, so J moves on from the row on screen.
    effect(() => {
      const id = this.selected()?.id ?? null;
      if (id && untracked(() => this.ui.focusedRowId()) !== id) untracked(() => this.ui.setFocusedRow(id));
    });

    // `?tab=` opens that tab (once per value).
    let handled: string | undefined;
    effect(() => {
      const raw = this.tabParam() ?? '';
      const target = LEGACY_TABS[raw];
      if (!target || handled === raw) return;
      handled = raw;
      untracked(() => this.pickedTab.set(target));
    });

    usePageShortcuts([
      {
        keys: 'enter',
        label: 'Open the selected item',
        when: () => !!this.selected() && !onControl(),
        run: () => this.open(this.selected()!),
      },
      {
        keys: 'o',
        label: 'Open the task’s Delta thread',
        when: () => !!this.selected()?.issue?.threadUrl,
        run: () => window.open(this.selected()!.issue!.threadUrl, '_blank', 'noopener'),
      },
      {
        keys: 'shift+r',
        label: 'Mark all updates as read',
        when: () => this.notifications.unread() > 0,
        run: () => void this.notifications.markRead(),
      },
      {
        keys: 'e',
        label: 'Dismiss item or mark update as read',
        when: () => {
          const e = this.selected();
          return !!e && (e.canDismiss || e.canMarkRead);
        },
        run: () => {
          const e = this.selected()!;
          if (e.canDismiss) this.dismiss(e.attention!);
          else this.markRead(e);
        },
      },
      {
        keys: 'd',
        label: 'Mark task done',
        when: () => this.selected()?.source === 'task',
        run: () => this.markDone(this.selected()!),
      },
    ]);
  }

  protected selectTab(t: InboxTab): void {
    if (!isInboxTab(t)) return;
    this.pickedTab.set(t);
    this.ui.setFocusedRow(null);
  }

  // ───────── row actions ─────────

  /** A click on the row: open it. */
  protected open(e: InboxEntry): void {
    if (e.canMarkRead) this.markRead(e);
    void this.router.navigate(['/', this.slug(), ...e.route], { queryParams: e.query });
  }

  /** Move the keyboard focus to the neighbour before `id` disappears from the list. */
  private advanceFocus(id: string): void {
    if (this.selected()?.id !== id) return;
    const flat = this.list();
    const i = flat.findIndex((e) => e.id === id);
    this.ui.setFocusedRow((flat[i + 1] ?? flat[i - 1])?.id ?? null);
  }

  protected markRead(e: InboxEntry): void {
    if (e.notification && !e.notification.readAt) void this.notifications.markRead([e.notification.id]);
  }

  protected async markDone(e: InboxEntry): Promise<void> {
    const issue = e.issue;
    if (!issue) return;
    this.advanceFocus(e.id);
    const prev = issue.status;
    const name = resolveStatusEntry(this.store.settings().statuses.issue, 'done')?.name ?? 'Merged';
    if (await this.store.updateIssue(issue.id, { status: 'done' })) {
      this.notifier.success(`${issue.key} → ${name}`, {
        action: { label: 'Undo', run: () => void this.store.updateIssue(issue.id, { status: prev }) },
      });
    }
  }

  /** A task with an open PR, moved to In review by the person (Trama never does it on its own). */
  protected async toReview(e: InboxEntry): Promise<void> {
    const issue = e.issue;
    if (!issue) return;
    const prev = issue.status;
    const name = resolveStatusEntry(this.store.settings().statuses.issue, 'in_review')?.name ?? 'In Review / Waiting Input';
    if (await this.store.updateIssue(issue.id, { status: 'in_review' })) {
      this.notifier.success(`${issue.key} → ${name}`, {
        action: { label: 'Undo', run: () => void this.store.updateIssue(issue.id, { status: prev }) },
      });
    }
  }

  protected dismiss(item: AttentionItem): void {
    this.advanceFocus(item.id);
    void this.store.dismissAttention(item.id).then((ok) => {
      if (ok)
        toast('Dismissed', {
          description: item.title,
          action: { label: 'Undo', onClick: () => void this.store.restoreAttention(item.id) },
        });
    });
  }
}
