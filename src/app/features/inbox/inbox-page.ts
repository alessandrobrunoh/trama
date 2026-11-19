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
import { Router, RouterLink } from '@angular/router';
import { LucideChevronRight, LucideDynamicIcon, LucideInbox } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCalendar } from '@spartan-ng/helm/calendar';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { toast } from '@spartan-ng/brain/sonner';
import {
  ApiClient,
  ListStateStore,
  NotificationsStore,
  Notifier,
  TimeEntriesStore,
  TramaStore,
  UiStore,
  resolveStatusEntry,
  shortDate,
  usePageShortcuts,
  type AttentionItem,
} from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { StatusBar } from '../../layout/status-bar';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { morningOf, snoozePresets } from '../attention/snooze';
import { useKeyboardPreview } from '../issues/list-preview';
import { OnboardingChecklist } from '../onboarding/onboarding-checklist';
import { DEFAULT_IDLE_DAYS, activityLookup } from '../stats/flow-stats';
import {
  LEGACY_TABS,
  buildInbox,
  type InboxContext,
  type InboxEntry,
  type InboxSectionId,
} from './inbox-model';
import { InboxRow } from './inbox-row';

type Scope = 'mine' | 'all';

/** Unread updates and the ones from the last 3 days stay visible; older read ones sit behind "Show older". */
const RECENT_MS = 3 * 86_400_000;
const UPDATES_VISIBLE = 8;

/**
 * `/:workspace/inbox`: everything that concerns you, in one list. Every row is one plain sentence that says why it is
 * here, what it is about and the one action that resolves it.
 *
 *   Needs your action       reviews, failing checks, conflicts and triage
 *   Your tasks in progress  what you are working on and that is moving
 *   Stale                   started, but quiet for a while
 *   Updates                 assignments and comments that concern you
 *   Snoozed and dismissed   set aside, collapsed, one click from coming back
 *
 * The old `?tab=needs-you|tasks|updates|later` links still work: they scroll to (and open) that section.
 * Keyboard: J/K move, Enter opens, E dismisses (or marks read), H snoozes, D marks a task done, R restores.
 */
@Component({
  selector: 'app-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmCalendar,
    HlmDialogImports,
    HlmToggleGroupImports,
    EmptyState,
    Kbd,
    PageHeader,
    StatusBar,
    OnboardingChecklist,
    InboxRow,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    <app-page-header title="Inbox" [description]="summary()" />

    <app-status-bar>
      <span aria-live="polite">{{ summary() }}</span>
      @if (hasRows()) {
        <span class="flex items-center gap-1"><app-kbd keys="j" /><app-kbd keys="k" /> move</span>
        <span class="flex items-center gap-1"><app-kbd keys="enter" /> open</span>
        <span class="flex items-center gap-1"><app-kbd keys="e" /> dismiss</span>
        <span class="flex items-center gap-1"><app-kbd keys="h" /> snooze</span>
      }
      @if (canSeeAll()) {
        <hlm-toggle-group
          end
          type="single"
          variant="outline"
          size="sm"
          [value]="scope()"
          (valueChange)="setScope($event)"
          aria-label="Whose actions"
        >
          <button hlmToggleGroupItem value="mine">Mine</button>
          <button hlmToggleGroupItem value="all">Everyone</button>
        </hlm-toggle-group>
      }
    </app-status-bar>

    <app-onboarding-checklist compact class="px-4 pt-3 sm:px-6" />

    @if (canSeeAll()) {
      <div class="flex justify-end px-4 pt-2 sm:hidden">
        <hlm-toggle-group
          type="single"
          variant="outline"
          size="sm"
          [value]="scope()"
          (valueChange)="setScope($event)"
          aria-label="Whose actions"
        >
          <button hlmToggleGroupItem value="mine" class="h-9">Mine</button>
          <button hlmToggleGroupItem value="all" class="h-9">Everyone</button>
        </hlm-toggle-group>
      </div>
    }

    @if (scope() === 'all' && loadingAll()) {
      <p class="text-meta px-4 py-6 sm:px-6">Loading everyone's actions…</p>
    } @else {
      @if (allClear()) {
        <app-empty-state
          [icon]="inboxIcon"
          title="Nothing needs you"
          description="No reviews, failing checks, stale tasks or unread updates. Anything that needs a human shows up here, with what to do next."
        >
          <div class="flex flex-wrap justify-center gap-2">
            <a hlmBtn variant="outline" size="sm" [routerLink]="['/', slug(), 'tasks']">Browse tasks</a>
            @if (!store.agents().length) {
              <a hlmBtn variant="ghost" size="sm" [routerLink]="['/', slug(), 'connect']">Connect your agent</a>
            }
          </div>
        </app-empty-state>
      }

      @for (s of visible(); track s.id) {
        @if (s.id !== 'later') {
          @if (!(s.id === 'action' && allClear())) {
            <section [attr.aria-label]="s.title" [attr.id]="'inbox-' + s.id" class="scroll-mt-2">
              <header class="text-muted-foreground mt-2 flex h-8 items-center gap-2 px-4 text-[13px] sm:px-5">
                <h2 class="font-normal">{{ s.title }}</h2>
                <span class="tabular-nums">{{ s.total }}</span>
                <span class="text-meta ms-2 hidden truncate md:inline">{{ s.hint }}</span>
                @if (s.id === 'updates' && notifications.unread()) {
                  <button
                    type="button"
                    hlmBtn
                    variant="ghost"
                    size="sm"
                    class="text-muted-foreground ms-auto h-6 px-2 text-xs"
                    (click)="notifications.markRead()"
                  >
                    Mark all as read
                  </button>
                }
              </header>
              @for (e of s.entries; track e.id) {
                <app-inbox-row
                  [entry]="e"
                  [slug]="slug()"
                  [focused]="ui.focusedRowId() === e.id"
                  (rowClicked)="ui.setFocusedRow(e.id)"
                  (preview)="preview(e)"
                  (open)="open(e)"
                  (primary)="primary(e)"
                  (snooze)="snooze(e.attention!, $event)"
                  (pickDate)="openSnooze(e.attention!)"
                  (dismiss)="dismiss(e.attention!)"
                  (markDone)="markDone(e)"
                  (markRead)="markRead(e)"
                />
              } @empty {
                <p class="text-meta px-4 py-2 ps-[2.875rem] sm:pe-5">Nothing needs you right now.</p>
              }
              @if (s.id === 'updates' && s.hidden > 0) {
                <button
                  type="button"
                  class="text-meta hover:text-foreground px-4 py-2 ps-[2.875rem] text-start outline-none focus-visible:underline sm:pe-5"
                  (click)="showOlder.set(true)"
                >
                  Show {{ s.hidden }} older
                </button>
              }
            </section>
          }
        } @else {
          <section aria-label="Snoozed and dismissed" id="inbox-later" class="scroll-mt-2">
            <button
              type="button"
              class="text-muted-foreground hover:bg-hover mt-2 flex h-8 w-full items-center gap-2 px-4 text-start text-[13px] outline-none focus-visible:underline sm:px-5"
              [attr.aria-expanded]="laterOpen()"
              (click)="laterOpen.set(!laterOpen())"
            >
              <span class="flex shrink-0 transition-transform" [class.rotate-90]="laterOpen()">
                <svg [lucideIcon]="chevron" [size]="12"></svg>
              </span>
              <span>{{ s.title }}</span>
              <span class="tabular-nums">{{ s.total }}</span>
              <span class="text-meta ms-2 hidden truncate md:inline">{{ s.hint }}</span>
            </button>
            @if (laterOpen()) {
              @for (e of s.entries; track e.id) {
                <app-inbox-row
                  [entry]="e"
                  [slug]="slug()"
                  [focused]="ui.focusedRowId() === e.id"
                  (rowClicked)="ui.setFocusedRow(e.id)"
                  (preview)="preview(e)"
                  (open)="open(e)"
                  (primary)="primary(e)"
                />
              }
            }
          </section>
        }
      }
    }

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
        <div class="flex justify-center rounded-md border">
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
  /** From `?tab=`: an old link to one of the former tabs. It scrolls to that section. */
  readonly tab = input<string>();

  protected readonly store = inject(TramaStore);
  protected readonly notifications = inject(NotificationsStore);
  protected readonly ui = inject(UiStore);
  private readonly listState = inject(ListStateStore);
  private readonly api = inject(ApiClient);
  private readonly time = inject(TimeEntriesStore);
  private readonly notifier = inject(Notifier);
  private readonly router = inject(Router);
  private readonly pane = inject(RightPaneStore);

  protected readonly inboxIcon = LucideInbox;
  protected readonly chevron = LucideChevronRight;
  protected readonly minDate = new Date();
  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');

  // Scope survives navigation inside the app (see ListStateStore).
  protected readonly scope = this.listState.remember<Scope>('attention.scope', 'mine');
  protected readonly canSeeAll = computed(() => this.store.can('admin'));
  protected readonly laterOpen = signal(false);
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

  private readonly model = computed(() =>
    buildInbox(
      { attention: this.attention(), mine: this.mine(), notifications: this.notifications.items() },
      this.context(),
    ),
  );

  /** The sections as shown: Updates cut to the recent ones unless "Show older" was pressed. */
  protected readonly visible = computed(() => {
    const older = this.showOlder();
    const cutoff = this.now() - RECENT_MS;
    return this.model().map((s) => {
      if (s.id !== 'updates' || older) return { ...s, total: s.entries.length, hidden: 0 };
      const shown = s.entries.filter((e, i) => e.unread || i < UPDATES_VISIBLE || Date.parse(e.at) >= cutoff);
      return { ...s, entries: shown, total: s.entries.length, hidden: s.entries.length - shown.length };
    });
  });

  /** Rows in on-screen order (drives focus movement after an action). */
  private readonly flat = computed(() =>
    this.visible().flatMap((s) => (s.id === 'later' && !this.laterOpen() ? [] : s.entries)),
  );
  private readonly count = (id: InboxSectionId): number =>
    this.model().find((s) => s.id === id)?.entries.length ?? 0;

  protected readonly hasRows = computed(() => this.flat().length > 0);
  /** Nothing to act on, nothing moving, nothing unread: the empty state. */
  protected readonly allClear = computed(
    () =>
      this.count('action') === 0 &&
      this.count('progress') === 0 &&
      this.count('stale') === 0 &&
      this.count('updates') === 0,
  );

  protected readonly summary = computed(() => {
    const parts: string[] = [];
    const n = this.count('action');
    if (n) parts.push(`${n} ${n === 1 ? 'needs' : 'need'} your action`);
    const s = this.count('stale');
    if (s) parts.push(`${s} stale`);
    const u = this.notifications.updatesUnread();
    if (u) parts.push(`${u} unread`);
    return parts.join(' · ') || 'All clear';
  });

  private readonly focusedEntry = computed(() => {
    const id = this.ui.focusedRowId();
    return id ? this.flat().find((e) => e.id === id) : undefined;
  });

  // snooze dialog
  protected readonly snoozeFor = signal<AttentionItem | null>(null);
  protected readonly pickedDate = signal<Date | null>(null);
  protected readonly presets = computed(() => (this.snoozeFor() ? snoozePresets() : []));

  /** Arrow keys and j/k show the focused row's task in the right pane. */
  private readonly _preview = useKeyboardPreview((id) => {
    const key = this.flat().find((e) => e.id === id)?.issueKey;
    if (key) this.pane.show({ kind: 'task', idOrKey: key });
  });

  constructor() {
    this.ui.setFocusedRow(null);
    void this.time.load();
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));

    // An old `?tab=` link points at one section: open it and scroll there once its rows exist.
    let handled: string | undefined;
    effect(() => {
      const target = LEGACY_TABS[this.tab() ?? ''];
      const ready = !!target && this.model().some((s) => s.id === target && s.entries.length > 0);
      if (!target || !ready || handled === this.tab()) return;
      handled = this.tab();
      untracked(() => {
        if (target === 'later') this.laterOpen.set(true);
        if (target !== 'action')
          setTimeout(() => document.getElementById(`inbox-${target}`)?.scrollIntoView({ block: 'start' }), 100);
      });
    });

    usePageShortcuts([
      {
        keys: 'e',
        label: 'Dismiss item or mark update as read',
        when: () => {
          const e = this.focusedEntry();
          return !!e && (e.canDismiss || e.canMarkRead);
        },
        run: () => {
          const e = this.focusedEntry()!;
          if (e.canDismiss) this.dismiss(e.attention!);
          else this.markRead(e);
        },
      },
      {
        keys: 'h',
        label: 'Snooze item…',
        when: () => !!this.focusedEntry()?.canSnooze,
        run: () => this.openSnooze(this.focusedEntry()!.attention!),
      },
      {
        keys: 's',
        label: 'Snooze item… (alias of H)',
        when: () => !!this.focusedEntry()?.canSnooze,
        run: () => this.openSnooze(this.focusedEntry()!.attention!),
      },
      {
        keys: 'd',
        label: 'Mark task done',
        when: () => this.focusedEntry()?.source === 'task',
        run: () => this.markDone(this.focusedEntry()!),
      },
      {
        keys: 'r',
        label: 'Restore item',
        when: () => this.focusedEntry()?.section === 'later',
        run: () => this.restore(this.focusedEntry()!.attention!),
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

  protected setScope(v: unknown): void {
    const next: Scope = v === 'all' ? 'all' : 'mine';
    if (next === this.scope()) return;
    this.allItems.set(null);
    this.scope.set(next);
  }

  // ───────── row actions ─────────

  /** A single click: show the task in the right pane; an update the person looked at counts as read. */
  protected preview(e: InboxEntry): void {
    this.ui.setFocusedRow(e.id);
    if (e.canMarkRead) this.markRead(e);
    if (e.issueKey) this.pane.show({ kind: 'task', idOrKey: e.issueKey });
  }

  /** Double click: open in full. */
  protected open(e: InboxEntry): void {
    if (e.canMarkRead) this.markRead(e);
    void this.router.navigate(['/', this.slug(), ...e.route], { queryParams: e.query });
  }

  /** The primary button. "Open" links navigate on their own; here only what they leave behind happens. */
  protected primary(e: InboxEntry): void {
    switch (e.primary.type) {
      case 'open':
        if (e.canMarkRead) this.markRead(e);
        break;
      case 'done':
        void this.markDone(e);
        break;
      case 'restore':
        this.restore(e.attention!);
        break;
      case 'external':
        break;
    }
  }

  /** Move the keyboard focus to the neighbour before `id` disappears from the list. */
  private advanceFocus(id: string): void {
    if (this.ui.focusedRowId() !== id) return;
    const flat = this.flat();
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
    const name = resolveStatusEntry(this.store.settings().statuses.issue, 'done')?.name ?? 'Done';
    if (await this.store.updateIssue(issue.id, { status: 'done' })) {
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
