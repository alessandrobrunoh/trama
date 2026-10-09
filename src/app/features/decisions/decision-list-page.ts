import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlus, LucideRows3, LucideScale, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  DECISION_STATUSES,
  DECISION_STATUS_META,
  NablaStore,
  UiStore,
  type Decision,
  type DecisionStatus,
} from '../../core';
import { readJson, writeJson } from '../../core/stores/storage';
import { ListStateStore } from '../../core/stores/list-state.store';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { EntityChip } from '../../shared/entity-chip';
import { Kbd } from '../../shared/kbd';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { Picker, type PickOption } from '../workstreams/picker';
import { SearchInput } from '../../shared/search-input';

const PREFS_KEY = 'nabla.decisions.list.v1';
type GroupMode = 'status' | 'none';

interface DecisionGroup {
  status: DecisionStatus | null;
  label: string;
  items: Decision[];
}

/** Decisions: dense Linear-style list, grouped by status (proposed first), searchable. */
@Component({
  selector: 'app-decision-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SearchInput,
    RouterLink,
    HlmButtonImports,
    HlmTooltip,
    LucideDynamicIcon,
    PageHeader,
    Picker,
    Kbd,
    EmptyState,
    KeyChip,
    StatusIcon,
    EntityChip,
    RelativeTimePipe,
    TopBarActions,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New decision</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Decisions" [description]="description()" />

    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2 sm:px-6">
      <app-search-input noun="decisions" [(value)]="search" />
      <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="statusFilter()" (valueChange)="statusFilter.set($event)" />
      @if (tagOptions().length) {
        <app-picker variant="chip" label="Tag" [multiple]="true" [options]="tagOptions()" [value]="tagFilter()" (valueChange)="tagFilter.set($event)" />
      }
      @if (hasFilters()) {
        <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 gap-1 px-2 text-xs" (click)="clear()">
          <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
        </button>
      }
      <span class="flex-1"></span>
      <button
        hlmBtn
        variant="ghost"
        size="sm"
        class="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
        [class.text-foreground]="group() === 'status'"
        [hlmTooltip]="group() === 'status' ? 'Show as one flat list' : 'Group by status'"
        position="bottom"
        (click)="toggleGroup()"
      >
        <svg [lucideIcon]="rowsIcon" [size]="13"></svg>
        {{ group() === 'status' ? 'Grouped by status' : 'No grouping' }}
      </button>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="scale" title="No decisions yet" description="Decisions record what was chosen and why, so the next person (or agent) does not have to dig through a thread to rediscover it.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New decision</button>
        }
      </app-empty-state>
    } @else if (shown().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No decisions match" description="Try another status, tag or search.">
        <button hlmBtn size="sm" variant="outline" (click)="clear()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        @for (g of groups(); track g.label) {
          @if (g.status) {
            <div class="bg-muted/40 sticky top-0 z-10 flex h-8 items-center gap-2 border-b px-4 backdrop-blur sm:px-6">
              <app-status-icon [status]="g.status" entity="other" [size]="13" />
              <span class="text-xs font-medium">{{ g.label }}</span>
              <span class="text-muted-foreground text-xs tabular-nums">{{ g.items.length }}</span>
            </div>
          }
          @for (d of g.items; track d.id) {
            <div
              role="listitem"
              [attr.data-row-id]="d.id"
              class="hover:bg-hover relative flex min-h-14 items-center gap-3 border-b px-4 py-2.5 sm:px-6 md:min-h-9 md:py-1.5"
              [class.bg-selected]="ui.focusedRowId() === d.id"
            >
              <a
                [routerLink]="['/', slug(), 'decisions', d.key]"
                class="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset"
                [attr.aria-label]="d.key + ' ' + d.title"
              ></a>
              <app-status-icon [status]="d.status" entity="other" class="pointer-events-none relative" />
              <app-key-chip [value]="d.key" class="pointer-events-none relative w-14" />
              <span
                class="pointer-events-none relative min-w-0 flex-1 truncate text-sm"
                [class.text-muted-foreground]="d.status === 'superseded' || d.status === 'rejected'"
                >{{ d.title }}</span
              >
              <span class="pointer-events-none relative hidden items-center gap-1 md:flex">
                @for (t of d.tags.slice(0, 2); track t) {
                  <span class="border-border-strong text-muted-foreground inline-flex h-5 items-center rounded-full border px-1.5 text-[11px]">{{ t }}</span>
                }
                @if (d.tags.length > 2) {
                  <span class="text-muted-foreground text-[11px]">+{{ d.tags.length - 2 }}</span>
                }
              </span>
              @if (d.originWorkstreamId) {
                <app-entity-chip type="workstream" [ref]="d.originWorkstreamId" compact class="relative max-sm:hidden" />
              }
              <span class="text-meta pointer-events-none relative w-24 shrink-0 text-end whitespace-nowrap tabular-nums max-sm:hidden">{{ (d.decidedAt ?? d.updatedAt) | relativeTime }}</span>
            </div>
          }
        }
      </div>
    }
  `,
})
export class DecisionListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  private readonly listState = inject(ListStateStore);
  protected readonly ui = inject(UiStore);

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly scale = LucideScale;
  protected readonly rowsIcon = LucideRows3;
  protected readonly statuses: PickOption[] = DECISION_STATUSES.map((s) => ({
    value: s,
    label: DECISION_STATUS_META[s].label,
    kind: 'status',
    status: s,
    statusEntity: 'other',
  }));

  // Filters survive navigation inside the app (see ListStateStore).
  protected readonly search = this.listState.remember('decisions.search', '');
  protected readonly statusFilter = this.listState.remember<string[]>('decisions.status', []);
  protected readonly tagFilter = this.listState.remember<string[]>('decisions.tag', []);
  protected readonly group = signal<GroupMode>(readJson<{ group: GroupMode }>(PREFS_KEY)?.group === 'none' ? 'none' : 'status');
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly total = computed(() => this.store.decisions().length);
  protected readonly hasFilters = computed(
    () => !!this.search().trim() || this.statusFilter().length > 0 || this.tagFilter().length > 0,
  );

  protected readonly tagOptions = computed<PickOption[]>(() => {
    const set = new Set<string>();
    for (const d of this.store.decisions()) for (const t of d.tags) set.add(t);
    return [...set].sort().map((t) => ({ value: t, label: t, kind: 'label' }));
  });

  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    const statuses = new Set(this.statusFilter());
    const tags = this.tagFilter();
    return this.store
      .decisions()
      .filter((d) => {
        if (statuses.size && !statuses.has(d.status)) return false;
        if (tags.length && !tags.some((t) => d.tags.includes(t))) return false;
        if (!q) return true;
        return `${d.key} ${d.title} ${d.statement} ${d.tags.join(' ')}`.toLowerCase().includes(q);
      })
      .slice()
      .sort((a, b) => ((a.decidedAt ?? a.updatedAt) < (b.decidedAt ?? b.updatedAt) ? 1 : -1));
  });

  protected readonly groups = computed<DecisionGroup[]>(() => {
    const list = this.shown();
    if (this.group() === 'none') return [{ status: null, label: 'all', items: list }];
    return DECISION_STATUSES.map((s) => ({
      status: s,
      label: DECISION_STATUS_META[s].label,
      items: list.filter((d) => d.status === s),
    })).filter((g) => g.items.length > 0);
  });

  protected readonly description = computed(() => {
    const n = this.total();
    const noun = n === 1 ? 'decision' : 'decisions';
    const proposed = this.store.decisions().filter((d) => d.status === 'proposed').length;
    if (this.hasFilters()) return `${this.shown().length} of ${n} ${noun}`;
    return proposed ? `${n} ${noun} · ${proposed} awaiting a call` : `${n} ${noun}`;
  });

  constructor() {
    effect(() => writeJson(PREFS_KEY, { group: this.group() }));
  }

  protected toggleGroup(): void {
    this.group.update((g) => (g === 'status' ? 'none' : 'status'));
  }

  protected create(): void {
    this.ui.openCreate('decision');
  }

  protected clear(): void {
    this.search.set('');
    this.statusFilter.set([]);
    this.tagFilter.set([]);
  }
}
