import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowDown,
  LucideArrowUp,
  LucideBuilding2,
  LucideDynamicIcon,
  LucideInbox,
  LucidePlus,
  LucideSearch,
  LucideStar,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { CUSTOMER_STATUSES, CustomerIntakeStore, CustomerSubscriptionsStore, ListStateStore, TramaStore, UiStore, usePageShortcuts, type CustomerStatus } from '../../core';
import { oneOf, readJson, writeJson } from '../../core/stores/storage';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { Picker, type PickOption } from '../workstreams/picker';
import { CustomerAvatar } from './customer-avatar';
import {
  compactNumber,
  customerStats,
  groupCustomerStats,
  sortCustomerStats,
  type CustomerGroup,
  type CustomerSort,
} from './customer-model';
import { SearchInput } from '../../shared/search-input';

const DISPLAY_KEY = 'trama.customers.display.v1';
const SORTS: readonly CustomerSort[] = ['name', 'tier', 'revenue', 'size', 'requests', 'important', 'open', 'last'];
const GROUPS: readonly CustomerGroup[] = ['none', 'tier', 'status'];

interface Display {
  sort: CustomerSort;
  dir: 'asc' | 'desc';
  group: CustomerGroup;
}

const DEFAULT_DISPLAY: Display = { sort: 'open', dir: 'desc', group: 'none' };

function readDisplay(): Display {
  const raw = readJson<Display>(DISPLAY_KEY) ?? {};
  return {
    sort: oneOf(raw.sort, SORTS, DEFAULT_DISPLAY.sort),
    dir: oneOf(raw.dir, ['asc', 'desc'], DEFAULT_DISPLAY.dir),
    group: oneOf(raw.group, GROUPS, DEFAULT_DISPLAY.group),
  };
}

/** The sortable columns of the table, in order. `first` sorts ascending, the rest start with the biggest. */
const COLUMNS: { sort: CustomerSort; label: string; width: string; hideBelow?: 'md' | 'lg'; tip: string }[] = [
  { sort: 'tier', label: 'Tier', width: 'w-24', hideBelow: 'md', tip: 'Workspace tier' },
  { sort: 'revenue', label: 'Revenue', width: 'w-20 text-right', hideBelow: 'md', tip: 'Annual revenue' },
  { sort: 'size', label: 'Size', width: 'w-16 text-right', hideBelow: 'lg', tip: 'People in the company' },
  { sort: 'requests', label: 'Requests', width: 'w-[4.5rem] text-right', tip: 'All requests ever recorded' },
  { sort: 'open', label: 'Open', width: 'w-14 text-right', tip: 'Waiting on work that is not done' },
  { sort: 'important', label: 'Important', width: 'w-[4.5rem] text-right', hideBelow: 'md', tip: 'Requests flagged important' },
  { sort: 'last', label: 'Last asked', width: 'w-24 text-right', hideBelow: 'lg', tip: 'Newest request' },
];

@Component({
  selector: 'app-customer-list-page',
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
    TopBarActions,
    CustomerAvatar,
    RelativeTimePipe,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      <a hlmBtn variant="outline" size="sm" [routerLink]="['/', slug(), 'customers', 'inbox']">
        <svg [lucideIcon]="inboxIcon" [size]="14"></svg>
        <span>Inbox</span>
        @if (intake.pending()) {
          <span class="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] leading-4 tabular-nums">{{ intake.pending() }}</span>
        }
      </a>
      @if (canManage()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New customer</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Customers" [description]="description()" />

    @if (summary().requests > 0) {
      <dl class="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4" aria-label="Customer demand">
        @for (s of tiles(); track s.label) {
          <div class="bg-background px-4 py-2.5 sm:px-6">
            <dt class="text-muted-foreground text-xs">{{ s.label }}</dt>
            <dd class="mt-0.5 text-lg font-semibold tabular-nums" [class.text-tone-amber]="s.accent">{{ s.value }}</dd>
          </div>
        }
      </dl>
    }

    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-1.5 sm:px-6">
      <app-search-input noun="customers" placeholder="Search name or domain…" [(value)]="search" />
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
        <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statusOptions" [value]="statusFilter()" (valueChange)="statusFilter.set($any($event))" />
        @if (tierOptions().length) {
          <app-picker variant="chip" label="Tier" [multiple]="true" [searchable]="false" [options]="tierOptions()" [value]="tierFilter()" (valueChange)="tierFilter.set($event)" />
        }
        <button
          type="button"
          class="h-7 shrink-0 rounded-md border px-2 text-xs transition-colors"
          [class]="waitingOnly() ? 'border-border-strong bg-accent text-foreground' : 'border-dashed text-muted-foreground hover:text-foreground'"
          [attr.aria-pressed]="waitingOnly()"
          hlmTooltip="Only customers with requests still waiting on work"
          (click)="waitingOnly.set(!waitingOnly())"
        >Waiting on us</button>
        <button
          type="button"
          class="h-7 shrink-0 rounded-md border px-2 text-xs transition-colors"
          [class]="showArchived() ? 'border-border-strong bg-accent text-foreground' : 'border-dashed text-muted-foreground hover:text-foreground'"
          [attr.aria-pressed]="showArchived()"
          (click)="showArchived.set(!showArchived())"
        >Archived</button>
        @if (hasFilters()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs" (click)="clearFilters()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2 text-xs">
        <app-picker
          variant="chip"
          label="Group"
          [searchable]="false"
          [clearable]="d().group !== 'none'"
          clearLabel="No grouping"
          [options]="groupOptions"
          [value]="d().group === 'none' ? [] : [d().group]"
          (valueChange)="patch({ group: $any($event[0] ?? 'none') })"
        />
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="building" title="No customers yet" description="A customer is a company, not a contact. Add one when requests should be tied to the issues and projects they produced, so you can see who is waiting on what.">
        @if (canManage()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New customer</button>
        }
      </app-empty-state>
    } @else if (shown() === 0) {
      <app-empty-state [icon]="searchIcon" title="No customers match" description="Try another name or domain, or clear the filters.">
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="table" aria-label="Customers">
        <div role="row" class="text-muted-foreground bg-background sticky top-0 z-10 hidden items-center gap-3 border-b px-4 py-1.5 text-xs sm:px-6 sm:flex">
          <button type="button" role="columnheader" class="hover:text-foreground flex flex-1 items-center gap-1 text-left" (click)="sortBy('name')">
            Customer
            @if (d().sort === 'name') { <svg [lucideIcon]="d().dir === 'asc' ? up : down" [size]="11"></svg> }
          </button>
          @for (c of columns; track c.sort) {
            <button
              type="button"
              role="columnheader"
              class="hover:text-foreground flex shrink-0 items-center gap-1"
              [class]="c.width + ' ' + (c.hideBelow === 'lg' ? 'max-lg:hidden' : c.hideBelow === 'md' ? 'max-md:hidden' : '') + (c.width.includes('text-right') ? ' justify-end' : '')"
              [hlmTooltip]="c.tip"
              (click)="sortBy(c.sort)"
            >
              {{ c.label }}
              @if (d().sort === c.sort) { <svg [lucideIcon]="d().dir === 'asc' ? up : down" [size]="11"></svg> }
            </button>
          }
        </div>

        @for (b of buckets(); track b.key) {
          @if (d().group !== 'none') {
            <div class="bg-muted/40 flex items-center gap-2 border-b px-4 py-1.5 text-xs sm:px-6">
              @if (b.color) { <span class="size-2 rounded-full" [style.background]="b.color"></span> }
              <span class="font-medium">{{ b.label }}</span>
              <span class="text-muted-foreground tabular-nums">{{ b.rows.length }}</span>
            </div>
          }
          @for (r of b.rows; track r.customer.id) {
            <a
              [routerLink]="['/', slug(), 'customers', r.customer.id]"
              role="row"
              class="hover:bg-muted/60 focus-visible:bg-muted/60 flex min-h-12 items-center gap-3 border-b px-4 py-2 outline-none sm:px-6"
              [class.opacity-60]="r.customer.archivedAt || r.customer.status === 'churned'"
            >
              <app-customer-avatar [customer]="r.customer" [size]="28" />
              <span class="min-w-0 flex-1">
                <span class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-sm font-medium">{{ r.customer.name }}</span>
                  @if (r.customer.archivedAt) { <span class="text-muted-foreground rounded border px-1.5 text-[11px]">Archived</span> }
                  @if (r.customer.status !== 'active') { <span class="text-muted-foreground rounded border px-1.5 text-[11px] capitalize">{{ r.customer.status }}</span> }
                  @if (following(r.customer.id)) { <svg [lucideIcon]="star" [size]="11" class="text-tone-amber shrink-0" fill="currentColor" hlmTooltip="You follow this customer"></svg> }
                </span>
                <span class="text-muted-foreground block truncate font-mono text-xs">{{ r.customer.domains.join(', ') }}</span>
              </span>
              <span class="hidden w-24 shrink-0 md:block">
                @if (r.tier; as tier) {
                  <span class="rounded border px-1.5 text-[11px]" [style.color]="tier.color" [style.border-color]="tier.color">{{ tier.name }}</span>
                }
              </span>
              <span class="text-muted-foreground hidden w-20 shrink-0 text-right text-sm tabular-nums md:block">{{ r.customer.revenue === undefined ? '' : compact(r.customer.revenue) }}</span>
              <span class="text-muted-foreground hidden w-16 shrink-0 text-right text-sm tabular-nums lg:block">{{ r.customer.size === undefined ? '' : compact(r.customer.size) }}</span>
              <span class="text-muted-foreground w-[4.5rem] shrink-0 text-right text-sm tabular-nums">{{ r.requests || '' }}</span>
              <span class="w-14 shrink-0 text-right text-sm tabular-nums" [class.font-medium]="r.open > 0" [class.text-muted-foreground]="r.open === 0">{{ r.open || '' }}</span>
              <span class="hidden w-[4.5rem] shrink-0 items-center justify-end gap-1 text-sm tabular-nums md:flex" [class]="r.openImportant ? 'text-tone-amber' : 'text-muted-foreground'">
                @if (r.important) {
                  <svg [lucideIcon]="star" [size]="11" [attr.fill]="r.openImportant ? 'currentColor' : 'none'"></svg>{{ r.important }}
                }
              </span>
              <span class="text-muted-foreground hidden w-24 shrink-0 text-right text-xs whitespace-nowrap lg:block">{{ r.lastRequestAt ? (r.lastRequestAt | relativeTime) : '' }}</span>
            </a>
          }
        }
      </div>
    }
  `,
})
export class CustomerListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly listState = inject(ListStateStore);
  private readonly subs = inject(CustomerSubscriptionsStore);

  protected readonly plus = LucidePlus;
  protected readonly inboxIcon = LucideInbox;
  protected readonly intake = inject(CustomerIntakeStore);
  protected readonly searchIcon = LucideSearch;
  protected readonly building = LucideBuilding2;
  protected readonly xIcon = LucideX;
  protected readonly star = LucideStar;
  protected readonly up = LucideArrowUp;
  protected readonly down = LucideArrowDown;
  protected readonly columns = COLUMNS;
  protected readonly compact = compactNumber;
  protected readonly groupOptions: PickOption[] = [
    { value: 'tier', label: 'Tier' },
    { value: 'status', label: 'Status' },
  ];
  protected readonly statusOptions: PickOption[] = CUSTOMER_STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));

  // Filters survive navigation inside the app (see ListStateStore); display options persist in localStorage.
  protected readonly search = this.listState.remember('customers.search', '');
  protected readonly statusFilter = this.listState.remember<CustomerStatus[]>('customers.status', []);
  protected readonly tierFilter = this.listState.remember<string[]>('customers.tier', []);
  protected readonly waitingOnly = this.listState.remember('customers.waiting', false);
  protected readonly showArchived = this.listState.remember('customers.archived', false);
  protected readonly d = this.listState.remember<Display>('customers.display', readDisplay());

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers'));
  protected readonly tierOptions = computed<PickOption[]>(() => [
    ...this.store.settings().customerTiers.map((t) => ({ value: t.id, label: t.name, kind: 'label' as const, color: t.color })),
    { value: '', label: 'No tier' },
  ]);

  /** Every customer with its numbers, archived ones only when asked for. */
  private readonly all = computed(() => {
    const showArchived = this.showArchived();
    return customerStats(
      this.store.customers().filter((c) => showArchived || !c.archivedAt),
      this.store.customerRequests(),
      this.store.issueById(),
      this.store.projectById(),
      this.store.settings().customerTiers,
    );
  });
  protected readonly total = computed(() => this.all().length);
  protected readonly hasFilters = computed(
    () => !!this.search().trim() || this.statusFilter().length > 0 || this.tierFilter().length > 0 || this.waitingOnly(),
  );

  private readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const statuses = new Set<string>(this.statusFilter());
    const tiers = new Set(this.tierFilter());
    const waiting = this.waitingOnly();
    return this.all().filter((r) => {
      if (statuses.size && !statuses.has(r.customer.status)) return false;
      if (tiers.size && !tiers.has(r.customer.tierId ?? '')) return false;
      if (waiting && r.open === 0) return false;
      return !q || `${r.customer.name} ${r.customer.domains.join(' ')}`.toLowerCase().includes(q);
    });
  });
  protected readonly buckets = computed(() => {
    const d = this.d();
    const sorted = sortCustomerStats(this.filtered(), d.sort, d.dir);
    return groupCustomerStats(sorted, d.group, this.store.settings().customerTiers);
  });
  protected readonly shown = computed(() => this.filtered().length);

  /** Totals over the customers on screen (archived excluded unless shown). */
  protected readonly summary = computed(() => {
    let requests = 0;
    let open = 0;
    let openImportant = 0;
    let delivered = 0;
    for (const r of this.all()) {
      requests += r.requests;
      open += r.open;
      openImportant += r.openImportant;
      delivered += r.delivered;
    }
    return { requests, open, openImportant, delivered, customers: this.all().length };
  });
  protected readonly tiles = computed(() => {
    const s = this.summary();
    return [
      { label: 'Customers', value: String(s.customers), accent: false },
      { label: 'Waiting on us', value: String(s.open), accent: false },
      { label: 'Important, waiting', value: String(s.openImportant), accent: s.openImportant > 0 },
      { label: 'Delivered', value: String(s.delivered), accent: false },
    ];
  });
  protected readonly description = computed(() => {
    const n = this.store.customers().filter((c) => !c.archivedAt).length;
    return n === 1 ? '1 customer · who is asking for what' : `${n} customers · who is asking for what`;
  });

  private readonly _keys = usePageShortcuts([
    { keys: 'c', label: 'New customer', group: 'Customers', run: () => this.canManage() && this.create() },
    { keys: 'f', label: 'Search customers', group: 'Customers', run: () => document.querySelector<HTMLInputElement>('input[aria-label="Search customers"]')?.focus() },
  ]);

  constructor() {
    effect(() => writeJson(DISPLAY_KEY, this.d()));
  }

  protected following(id: string): boolean {
    return this.subs.isFollowing(id);
  }

  protected patch(p: Partial<Display>): void {
    this.d.update((d) => ({ ...d, ...p }));
  }

  /** Same column again flips the direction; a new column starts with the biggest first (A to Z for text). */
  protected sortBy(sort: CustomerSort): void {
    this.d.update((d) =>
      d.sort === sort
        ? { ...d, dir: d.dir === 'asc' ? 'desc' : 'asc' }
        : { ...d, sort, dir: sort === 'name' || sort === 'tier' ? 'asc' : 'desc' },
    );
  }

  protected clearFilters(): void {
    this.search.set('');
    this.statusFilter.set([]);
    this.tierFilter.set([]);
    this.waitingOnly.set(false);
  }

  protected create(): void {
    this.ui.openCustomerDialog({ kind: 'customer' });
  }
}
