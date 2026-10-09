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
import { RouterLink } from '@angular/router';
import { LucideCheckCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCalendar } from '@spartan-ng/helm/calendar';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { toast } from '@spartan-ng/brain/sonner';
import {
  ApiClient,
  ListStateStore,
  NablaStore,
  UiStore,
  SEVERITY_ORDER,
  shortDate,
  usePageShortcuts,
  type AttentionItem,
} from '../../core';
import { EmptyState, Kbd } from '../../shared';
import { ATTENTION_SECTIONS } from './attention-kinds';
import { AttentionRow } from './attention-row';
import { morningOf, snoozePresets } from './snooze';

type Scope = 'mine' | 'all';
type Tab = 'open' | 'archived';

/**
 * The attention queue inside the Inbox ("Needs you" and "Snoozed & dismissed" tabs): "where is my attention
 * actually required?" Grouped by kind in a fixed order,
 * severity-sorted, with inline actions. Keyboard: J/K move, Enter open, E dismiss, H snooze, A answer,
 * Shift+E dismiss the question itself (input requests).
 */
@Component({
  selector: 'app-attention-page',
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
    AttentionRow,
  ],
  host: { class: 'flex flex-1 flex-col' },
  template: `
    <div class="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 sm:px-6">
      <p class="text-meta" aria-live="polite">{{ description() }}</p>
      <span class="flex-1"></span>
      @if (canSeeAll()) {
        <hlm-toggle-group
          type="single"
          variant="outline"
          size="sm"
          [value]="scope()"
          (valueChange)="setScope($event)"
          aria-label="Whose attention"
        >
          <button hlmToggleGroupItem value="mine" class="max-sm:h-9">Mine</button>
          <button hlmToggleGroupItem value="all" class="max-sm:h-9">Everyone</button>
        </hlm-toggle-group>
      }
    </div>

    @if (scope() === 'all' && loadingAll()) {
      <p class="text-meta px-4 py-6 sm:px-6">Loading everyone's attention…</p>
    } @else if (tab() === 'open') {
      @for (s of sections(); track s.sec.id) {
        <section [attr.aria-label]="s.sec.title">
          <header class="bg-muted/40 flex h-8 items-center gap-2 border-b px-4 sm:px-6">
            <svg [lucideIcon]="s.sec.icon" [size]="13" class="text-muted-foreground"></svg>
            <h2 class="text-xs font-medium">{{ s.sec.title }}</h2>
            <span class="text-muted-foreground text-xs tabular-nums">{{ s.items.length }}</span>
            <span class="text-meta ms-2 hidden truncate md:inline">{{ s.sec.hint }}</span>
          </header>
          @for (it of s.items; track it.id) {
            <app-attention-row
              [item]="it"
              [slug]="slug()"
              [focused]="ui.focusedRowId() === it.id"
              [answering]="answeringId() === it.id"
              (answeringChange)="answeringId.set($event ? it.id : null)"
              (rowClicked)="ui.setFocusedRow(it.id)"
              (dismiss)="dismiss(it)"
              (snooze)="snooze(it, $event)"
              (pickDate)="openSnooze(it)"
            />
          }
        </section>
      } @empty {
        <app-empty-state
          class="m-auto"
          [icon]="checkIcon"
          title="Nothing needs you"
          description="No questions, reviews, blockers or deadlines are waiting on you. Agents keep working, and anything that needs a human will show up here."
        >
          <div class="flex flex-wrap justify-center gap-2">
            <a hlmBtn variant="outline" size="sm" [routerLink]="['/', slug(), 'workstreams']">Workstreams</a>
            <a hlmBtn variant="ghost" size="sm" [routerLink]="['/', slug(), 'issues']">Issues</a>
            @if (!store.agents().length) {
              <a hlmBtn variant="ghost" size="sm" [routerLink]="['/', slug(), 'connect']">Connect your agent</a>
            }
          </div>
        </app-empty-state>
      }
      @if (sections().length) {
        <p class="text-meta hidden flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:flex sm:px-6">
          <span class="flex items-center gap-1"><app-kbd keys="j" /><app-kbd keys="k" /> move</span>
          <span class="flex items-center gap-1"><app-kbd keys="enter" /> open</span>
          <span class="flex items-center gap-1"><app-kbd keys="a" /> answer</span>
          <span class="flex items-center gap-1"><app-kbd keys="e" /> dismiss</span>
          <span class="flex items-center gap-1"><app-kbd keys="h" /> snooze</span>
          <span class="flex items-center gap-1"><app-kbd keys="shift+e" /> dismiss question</span>
        </p>
      }
    } @else {
      @for (it of archived(); track it.id) {
        <app-attention-row
          mode="archived"
          [item]="it"
          [slug]="slug()"
          [focused]="ui.focusedRowId() === it.id"
          (rowClicked)="ui.setFocusedRow(it.id)"
          (restore)="restore(it)"
        />
      } @empty {
        <app-empty-state
          class="m-auto"
          [icon]="checkIcon"
          title="Nothing snoozed or dismissed"
          description="Items you snooze or dismiss land here, so you can bring them back."
        />
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
            [min]="minDate()"
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
export class AttentionPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Which list the Inbox shows: what is open, or what was snoozed or dismissed. */
  readonly tab = input<Tab>('open');

  protected readonly store = inject(NablaStore);
  private readonly listState = inject(ListStateStore);
  protected readonly ui = inject(UiStore);
  private readonly api = inject(ApiClient);

  protected readonly checkIcon = LucideCheckCheck;
  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');

  // Scope survives navigation inside the app (see ListStateStore).
  protected readonly scope = this.listState.remember<Scope>('attention.scope', 'mine');
  protected readonly canSeeAll = computed(() => this.store.can('admin'));
  protected readonly answeringId = signal<string | null>(null);

  // "Everyone" scope: fetched separately (the snapshot only carries my items).
  private readonly allItems = signal<AttentionItem[] | null>(null);
  protected readonly loadingAll = computed(() => this.scope() === 'all' && this.allItems() === null);
  private readonly acted = signal<ReadonlyMap<string, Partial<AttentionItem>>>(new Map());

  protected readonly items = computed<readonly AttentionItem[]>(() => {
    if (this.scope() === 'mine') return this.store.attention();
    const all = this.allItems() ?? [];
    const mine = new Map(this.store.attention().map((a) => [a.id, a]));
    const acted = this.acted();
    return all.map((a) => mine.get(a.id) ?? (acted.has(a.id) ? { ...a, ...acted.get(a.id) } : a));
  });

  protected readonly open = computed(() => this.items().filter((a) => a.state === 'open'));
  protected readonly archived = computed(() =>
    this.items()
      .filter((a) => a.state !== 'open')
      .sort((a, b) => (a.state === b.state ? b.since.localeCompare(a.since) : a.state === 'snoozed' ? -1 : 1)),
  );

  protected readonly sections = computed(() => {
    const open = this.open();
    return ATTENTION_SECTIONS.map((sec) => ({
      sec,
      items: open
        .filter((a) => sec.kinds.includes(a.kind))
        .sort(
          (a, b) =>
            SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
            sec.kinds.indexOf(a.kind) - sec.kinds.indexOf(b.kind) ||
            a.since.localeCompare(b.since),
        ),
    })).filter((s) => s.items.length > 0);
  });
  /** Rows in on-screen order (drives focus movement after an action). */
  private readonly flat = computed(() =>
    this.tab() === 'open' ? this.sections().flatMap((s) => s.items) : this.archived(),
  );
  private readonly focusedItem = computed(() => {
    const id = this.ui.focusedRowId();
    return id ? this.flat().find((a) => a.id === id) : undefined;
  });

  private readonly focusedQuestion = computed(() => {
    const it = this.focusedItem();
    const id = it?.kind === 'input_requested' ? it.inputRequestId : undefined;
    const r = id ? this.store.inputRequestById().get(id) : undefined;
    return r?.state === 'open' ? r : undefined;
  });

  protected readonly description = computed(() => {
    const open = this.open();
    if (!open.length) return this.scope() === 'all' ? 'Nothing open across the workspace' : 'All clear';
    const high = open.filter((a) => a.severity === 'high').length;
    return `${open.length} open${high ? ` · ${high} high priority` : ''}${this.scope() === 'all' ? ' · everyone' : ''}`;
  });

  // snooze dialog
  protected readonly snoozeFor = signal<AttentionItem | null>(null);
  protected readonly pickedDate = signal<Date | null>(null);
  protected readonly presets = computed(() => (this.snoozeFor() ? snoozePresets() : []));
  protected readonly minDate = computed(() => (this.snoozeFor() ? new Date() : new Date()));

  constructor() {
    this.ui.setFocusedRow(null);
    // Switching tab starts with no row focused and no answer box open.
    effect(() => {
      this.tab();
      untracked(() => {
        this.ui.setFocusedRow(null);
        this.answeringId.set(null);
      });
    });
    usePageShortcuts([
      {
        keys: 'e',
        label: 'Dismiss item',
        when: () => this.tab() === 'open' && !!this.focusedItem(),
        run: () => this.dismiss(this.focusedItem()!),
      },
      {
        keys: 'h',
        label: 'Snooze item…',
        when: () => this.tab() === 'open' && !!this.focusedItem(),
        run: () => this.openSnooze(this.focusedItem()!),
      },
      {
        keys: 's',
        label: 'Snooze item… (alias of H)',
        when: () => this.tab() === 'open' && !!this.focusedItem(),
        run: () => this.openSnooze(this.focusedItem()!),
      },
      {
        keys: 'shift+e',
        label: 'Dismiss the question for everyone',
        when: () => this.tab() === 'open' && !!this.focusedQuestion(),
        run: () => this.dismissQuestion(this.focusedItem()!),
      },
      {
        keys: 'a',
        label: 'Answer input request',
        when: () => this.tab() === 'open' && this.focusedItem()?.kind === 'input_requested',
        run: () => this.answeringId.set(this.focusedItem()!.id),
      },
      {
        keys: 'r',
        label: 'Restore item',
        when: () => this.tab() === 'archived' && !!this.focusedItem(),
        run: () => this.restore(this.focusedItem()!),
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
      toast.error("Couldn't load everyone's attention");
    }
  }

  protected setScope(v: unknown): void {
    const next: Scope = v === 'all' ? 'all' : 'mine';
    if (next === this.scope()) return;
    this.allItems.set(null);
    this.scope.set(next);
  }

  /** Move keyboard focus to the neighbour before `id` disappears from the list. */
  private advanceFocus(id: string): void {
    if (this.ui.focusedRowId() !== id) return;
    const flat = this.flat();
    const i = flat.findIndex((a) => a.id === id);
    const next = flat[i + 1] ?? flat[i - 1];
    this.ui.setFocusedRow(next?.id ?? null);
  }

  private remember(id: string, patch: Partial<AttentionItem>): void {
    this.acted.update((m) => new Map(m).set(id, patch));
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

  protected dismissQuestion(item: AttentionItem): void {
    const r = this.focusedQuestion();
    if (!r) return;
    this.advanceFocus(item.id);
    void this.store.dismissInput(r.id).then((ok) => {
      if (ok) toast('Question dismissed', { description: r.question });
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
