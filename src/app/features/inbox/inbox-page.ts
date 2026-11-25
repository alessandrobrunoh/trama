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
import { HlmCalendar } from '@spartan-ng/helm/calendar';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { toast } from '@spartan-ng/brain/sonner';
import {
  ApiClient,
  ListStateStore,
  NotificationsStore,
  Notifier,
  TimeEntriesStore,
  TramaStore,
  UiStore,
  Viewport,
  resolveStatusEntry,
  shortDate,
  usePageShortcuts,
  type AttentionItem,
} from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { morningOf, snoozePresets } from '../attention/snooze';
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

type Scope = 'mine' | 'all';

/** Unread updates and the ones from the last 3 days stay visible; older read ones sit behind "Show older". */
const RECENT_MS = 3 * 86_400_000;
const UPDATES_VISIBLE = 8;

const newest = (a: InboxEntry, b: InboxEntry): number => b.at.localeCompare(a.at);

/** Enter on a focused control belongs to that control, not to the selected row. */
const onControl = (): boolean =>
  document.activeElement instanceof HTMLElement &&
  !!document.activeElement.closest('a[href], button, input, textarea, select, [role="menuitem"]');

/**
 * `/:workspace/inbox` (v3 "03 · Inbox"): everything that concerns you, as one list with a preview beside it.
 *
 *   tabs      All · Mentions (assignments, comments) · Records (your tasks moving or stale) ·
 *             Sync (reviews, failing checks, conflicts, triage) · Later (snoozed and dismissed, when any)
 *   list      480px; one 60px row per item, newest first, the selected one filled
 *   preview   what it is, what changed, what Trama will not do for you, and the actions with their keys
 *
 * `?tab=` opens a tab (older links such as `?tab=needs-you` still work). Phones show the list only and a tap opens
 * the item. Keyboard: J/K move, Enter opens, O opens the Delta thread, E dismisses (or marks read), H snoozes,
 * D marks a task done, R restores, ⇧R marks every update read.
 */
@Component({
  selector: 'app-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    HlmButtonImports,
    HlmCalendar,
    HlmDialogImports,
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
      @if (canSeeAll()) {
        <div class="flex items-center" role="group" aria-label="Whose actions">
          @for (s of scopes; track s.id) {
            <button
              type="button"
              class="border-border -ms-px h-[22px] border px-2.5 font-mono text-[11px] first:ms-0"
              [class.bg-secondary]="scope() === s.id"
              [class.text-foreground]="scope() === s.id"
              [class.text-muted-foreground]="scope() !== s.id"
              [attr.aria-pressed]="scope() === s.id"
              (click)="setScope(s.id)"
            >
              {{ s.label }}
            </button>
          }
        </div>
      }
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
          @if (scope() === 'all' && loadingAll()) {
            <p class="text-faint px-4 py-6 text-[12px]">Loading everyone's actions…</p>
          } @else {
            @for (e of list().entries; track e.id) {
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
            @if (list().hidden > 0) {
              <button
                type="button"
                class="text-faint hover:text-foreground w-full px-4 py-3 text-start font-mono text-[11px] outline-none focus-visible:underline"
                (click)="showOlder.set(true)"
              >
                Show {{ list().hidden }} older
              </button>
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
            [slug]="slug()"
            (open)="open(e)"
            (markDone)="markDone(e)"
            (markRead)="markRead(e)"
            (dismiss)="dismiss(e.attention!)"
            (snooze)="openSnooze(e.attention!)"
            (restore)="restore(e.attention!)"
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

    <!-- Snooze with a date -->
    <hlm-dialog [state]="snoozeFor() ? 'open' : 'closed'" (closed)="closeSnooze()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="sm:max-w-sm">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Snooze</h2>
          <p hlmDialogDescription class="line-clamp-2">{{ snoozeFor()?.title }}</p>
        </hlm-dialog-header>
        <div class="flex flex-col gap-0.5">
          @for (p of presets(); track p.id) {
            <button hlmBtn variant="ghost" class="justify-between" (click)="confirmSnooze(p.until)">
              {{ p.label }}
              <span class="text-muted-foreground text-xs font-normal">{{ p.hint }}</span>
            </button>
          }
        </div>
        <div class="border-border flex justify-center border">
          <hlm-calendar
            [date]="pickedDate()"
            [min]="minDate"
            [weekStartsOn]="store.weekStartsOn()"
            (dateChange)="pickedDate.set($event ?? null)"
          />
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose>Cancel</button>
          <button hlmBtn [disabled]="!pickedDate()" (click)="confirmPicked()">
            {{ pickedDate() ? 'Snooze until ' + label(pickedDate()!) : 'Pick a date' }}
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
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
  private readonly api = inject(ApiClient);
  private readonly time = inject(TimeEntriesStore);
  private readonly notifier = inject(Notifier);
  private readonly router = inject(Router);

  protected readonly inboxIcon = LucideInbox;
  protected readonly minDate = new Date();
  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');
  protected readonly scopes: readonly { id: Scope; label: string }[] = [
    { id: 'mine', label: 'Mine' },
    { id: 'all', label: 'Everyone' },
  ];

  // Scope and tab survive navigation inside the app (see ListStateStore).
  protected readonly scope = this.listState.remember<Scope>('attention.scope', 'mine');
  private readonly pickedTab = this.listState.remember<InboxTab>('inbox.tab', 'all');
  protected readonly canSeeAll = computed(() => this.store.can('admin'));
  protected readonly showOlder = signal(false);

  /** Re-read the clock once a minute so "stale" and the relative times do not go old on a long-open tab. */
  private readonly now = signal(Date.now());

  // "Everyone" scope: fetched separately (the snapshot only carries my items).
  private readonly allItems = signal<AttentionItem[] | null>(null);
  protected readonly loadingAll = computed(() => this.scope() === 'all' && this.allItems() === null);
  private readonly acted = signal<ReadonlyMap<string, Partial<AttentionItem>>>(new Map());

  private readonly attention = computed<readonly AttentionItem[]>(() => {
    if (this.scope() === 'mine') return this.store.attention();
    const all = this.allItems() ?? [];
    const mine = new Map(this.store.attention().map((a) => [a.id, a]));
    const acted = this.acted();
    return all.map((a) => mine.get(a.id) ?? (acted.has(a.id) ? { ...a, ...acted.get(a.id) } : a));
  });

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
      { attention: this.attention(), mine: this.mine(), notifications: this.notifications.items() },
      this.context(),
    ).flatMap((s) => s.entries),
  );

  private readonly inTab = (tab: InboxTab): InboxEntry[] => {
    const all = this.entries();
    // All: everything but what was set aside, newest first. Sync keeps the severity order of the queue.
    if (tab === 'all') return all.filter((e) => e.section !== 'later').sort(newest);
    return all.filter((e) => tabOf(e) === tab);
  };

  /** The tabs with their counts; Later only while something is snoozed or dismissed. */
  protected readonly tabs = computed(() =>
    INBOX_TABS.map((t) => ({ ...t, count: this.inTab(t.id).length })).filter(
      (t) => t.id !== 'later' || t.count > 0 || this.pickedTab() === 'later',
    ),
  );
  protected readonly tab = computed<InboxTab>(() => {
    const t = this.pickedTab();
    return this.tabs().some((x) => x.id === t) ? t : 'all';
  });
  protected readonly tabLabel = computed(() => INBOX_TABS.find((t) => t.id === this.tab())?.label ?? 'All');

  /** The rows of the open tab: read updates older than a few days wait behind "Show older". */
  protected readonly list = computed(() => {
    const entries = this.inTab(this.tab());
    if (this.showOlder()) return { entries, hidden: 0 };
    const cutoff = this.now() - RECENT_MS;
    let updates = 0;
    const shown = entries.filter(
      (e) => e.source !== 'update' || e.unread || updates++ < UPDATES_VISIBLE || Date.parse(e.at) >= cutoff,
    );
    return { entries: shown, hidden: entries.length - shown.length };
  });

  /** Nothing to act on, nothing moving, nothing unread: the empty state. */
  protected readonly allClear = computed(() => this.inTab('all').length === 0);

  /** The selected row: the keyboard-focused one, else the first. Its preview shows on the right. */
  protected readonly selected = computed<InboxEntry | undefined>(() => {
    const list = this.list().entries;
    const id = this.ui.focusedRowId();
    return list.find((e) => e.id === id) ?? list[0];
  });

  // snooze dialog
  protected readonly snoozeFor = signal<AttentionItem | null>(null);
  protected readonly pickedDate = signal<Date | null>(null);
  protected readonly presets = computed(() => (this.snoozeFor() ? snoozePresets() : []));

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
        keys: 'h',
        label: 'Snooze item…',
        when: () => !!this.selected()?.canSnooze,
        run: () => this.openSnooze(this.selected()!.attention!),
      },
      {
        keys: 's',
        label: 'Snooze item… (alias of H)',
        when: () => !!this.selected()?.canSnooze,
        run: () => this.openSnooze(this.selected()!.attention!),
      },
      {
        keys: 'd',
        label: 'Mark task done',
        when: () => this.selected()?.source === 'task',
        run: () => this.markDone(this.selected()!),
      },
      {
        keys: 'r',
        label: 'Restore item',
        when: () => this.selected()?.section === 'later',
        run: () => this.restore(this.selected()!.attention!),
      },
    ]);

    // Keep the "everyone" list fresh: load on switch, reload (debounced) when the snapshot refreshes.
    effect((onCleanup) => {
      if (this.scope() !== 'all') return;
      this.store.attention();
      const slug = this.slug();
      const t = setTimeout(() => void this.loadAll(slug), this.allItems() === null ? 0 : 600);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected selectTab(t: InboxTab): void {
    if (!isInboxTab(t)) return;
    this.pickedTab.set(t);
    this.ui.setFocusedRow(null);
  }

  private async loadAll(slug: string): Promise<void> {
    try {
      const list = await this.api.attention.list(slug, { scope: 'all' });
      untracked(() => {
        this.allItems.set(list);
        this.acted.set(new Map());
      });
    } catch {
      untracked(() => {
        this.scope.set('mine');
        this.allItems.set(null);
      });
      toast.error("Couldn't load everyone's actions");
    }
  }

  protected setScope(next: Scope): void {
    if (next === this.scope()) return;
    this.allItems.set(null);
    this.scope.set(next);
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
    const flat = this.list().entries;
    const i = flat.findIndex((e) => e.id === id);
    this.ui.setFocusedRow((flat[i + 1] ?? flat[i - 1])?.id ?? null);
  }

  private remember(id: string, patch: Partial<AttentionItem>): void {
    this.acted.update((m) => new Map(m).set(id, patch));
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
    this.remember(item.id, { state: 'dismissed' });
    void this.store.dismissAttention(item.id).then((ok) => {
      if (ok)
        toast('Dismissed', {
          description: item.title,
          action: { label: 'Undo', onClick: () => void this.store.restoreAttention(item.id) },
        });
    });
  }

  protected snooze(item: AttentionItem, until: string): void {
    this.advanceFocus(item.id);
    this.remember(item.id, { state: 'snoozed', snoozedUntil: until });
    void this.store.snoozeAttention(item.id, until).then((ok) => {
      if (ok)
        toast(`Snoozed until ${shortDate(until)}`, {
          description: item.title,
          action: { label: 'Undo', onClick: () => void this.store.restoreAttention(item.id) },
        });
    });
  }

  protected restore(item: AttentionItem): void {
    this.advanceFocus(item.id);
    this.remember(item.id, { state: 'open', snoozedUntil: undefined });
    void this.store.restoreAttention(item.id);
  }

  protected openSnooze(item: AttentionItem): void {
    this.pickedDate.set(null);
    this.snoozeFor.set(item);
  }

  protected closeSnooze(): void {
    this.snoozeFor.set(null);
  }

  protected confirmSnooze(until: string): void {
    const item = this.snoozeFor();
    this.snoozeFor.set(null);
    if (item) this.snooze(item, until);
  }

  protected confirmPicked(): void {
    const d = this.pickedDate();
    if (d) this.confirmSnooze(morningOf(d).toISOString());
  }

  protected label(d: Date): string {
    return shortDate(d.toISOString());
  }
}
