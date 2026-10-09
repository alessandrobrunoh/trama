import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBuilding2, LucideDynamicIcon, LucidePlus, LucideSearch } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, normalizeCustomerDomains, usePageShortcuts } from '../../core';
import { ListStateStore } from '../../core/stores/list-state.store';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { CustomerAvatar } from './customer-avatar';
import { compactNumber, splitDomains } from './customer-model';


@Component({
  selector: 'app-customer-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, Kbd, EmptyState, TopBarActions, CustomerAvatar],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canManage()) {
        <button hlmBtn size="sm" (click)="open.set(true)">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New customer</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Customers" [description]="description()" />

    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
      <div class="relative w-full sm:w-64">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input hlmInput class="h-10 w-full pl-9 text-sm" placeholder="Search name or domain…" aria-label="Search customers" [value]="search()" (input)="search.set($any($event.target).value)" />
      </div>
      <button type="button" class="text-muted-foreground hover:text-foreground h-8 rounded-md px-2 text-xs" (click)="showArchived.set(!showArchived())">
        {{ showArchived() ? 'Hide archived' : 'Show archived' }}
      </button>
    </div>

    @if (open()) {
      <form class="bg-card border-b flex flex-wrap items-end gap-2 px-4 py-3 sm:px-6" (submit)="create($event)">
        <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs">
          Name
          <input hlmInput name="name" required maxlength="200" class="h-9" placeholder="Acme" />
        </label>
        <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs">
          Domains
          <input hlmInput name="domains" required maxlength="2000" class="h-9" placeholder="acme.com, acme.io" />
        </label>
        <button hlmBtn size="sm" type="submit" [disabled]="saving()">Create</button>
        <button hlmBtn size="sm" variant="ghost" type="button" (click)="open.set(false)">Cancel</button>
        @if (formError()) {
          <p class="text-destructive w-full text-xs">{{ formError() }}</p>
        }
      </form>
    }

    @if (total() === 0) {
      <app-empty-state [icon]="building" title="No customers yet" description="A customer is a company, not a contact. Add one when requests should be tied to the issues and projects they produced.">
        @if (canManage()) {
          <button hlmBtn size="sm" (click)="open.set(true)"><svg [lucideIcon]="plus" [size]="14"></svg>New customer</button>
        }
      </app-empty-state>
    } @else if (shown().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No customers match" description="Try another name or domain." />
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        <div class="text-muted-foreground bg-muted/30 hidden items-center gap-3 border-b px-4 py-1.5 text-xs sm:px-6 md:flex">
          <span class="flex-1">Customer</span>
          <span class="w-24">Tier</span>
          <span class="w-20 text-right">Revenue</span>
          <span class="w-16 text-right">Size</span>
          <span class="w-20 text-right">Requests</span>
        </div>
        @for (r of shown(); track r.customer.id) {
          <a
            [routerLink]="['/', slug(), 'customers', r.customer.id]"
            role="listitem"
            class="hover:bg-muted/60 flex min-h-14 items-center gap-3 border-b px-4 py-3 sm:px-6"
          >
            <app-customer-avatar [customer]="r.customer" [size]="32" />
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium">{{ r.customer.name }}</span>
                @if (r.customer.archivedAt) {
                  <span class="text-muted-foreground rounded border px-1.5 text-[11px]">Archived</span>
                }
                @if (r.customer.status !== 'active') {
                  <span class="text-muted-foreground rounded border px-1.5 text-[11px] capitalize">{{ r.customer.status }}</span>
                }
              </span>
              <span class="text-muted-foreground block truncate font-mono text-xs">{{ r.customer.domains.join(', ') }}</span>
            </span>
            <span class="hidden w-24 shrink-0 md:block">
              @if (r.tier; as tier) {
                <span class="rounded border px-1.5 text-[11px]" [style.color]="tier.color" [style.border-color]="tier.color">{{ tier.name }}</span>
              }
            </span>
            <span class="text-muted-foreground hidden w-20 shrink-0 text-right text-sm tabular-nums md:block">{{ r.customer.revenue === undefined ? '' : compact(r.customer.revenue) }}</span>
            <span class="text-muted-foreground hidden w-16 shrink-0 text-right text-sm tabular-nums md:block">{{ r.customer.size === undefined ? '' : compact(r.customer.size) }}</span>
            <span class="text-muted-foreground w-20 shrink-0 text-right text-sm tabular-nums">{{ r.requests }}</span>
          </a>
        }
      </div>
    }
  `,
})
export class CustomerListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  private readonly listState = inject(ListStateStore);
  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly building = LucideBuilding2;
  // Filters survive navigation inside the app (see ListStateStore).
  protected readonly search = this.listState.remember('customers.search', '');
  protected readonly showArchived = this.listState.remember('customers.showArchived', false);
  protected readonly open = signal(false);
  protected readonly saving = signal(false);
  protected readonly formError = signal('');
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers'));

  protected readonly compact = compactNumber;
  private readonly requestCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const request of this.store.customerRequests()) counts.set(request.customerId, (counts.get(request.customerId) ?? 0) + 1);
    return counts;
  });
  protected readonly total = computed(() => this.store.customers().filter((c) => this.showArchived() || !c.archivedAt).length);
  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    const counts = this.requestCounts();
    const tiers = new Map(this.store.settings().customerTiers.map((t) => [t.id, t]));
    return this.store
      .customers()
      .filter((c) => (this.showArchived() || !c.archivedAt) && (!q || `${c.name} ${c.domains.join(' ')}`.toLowerCase().includes(q)))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((customer) => ({ customer, requests: counts.get(customer.id) ?? 0, tier: customer.tierId ? tiers.get(customer.tierId) : undefined }));
  });
  protected readonly description = computed(() => {
    const n = this.store.customers().filter((c) => !c.archivedAt).length;
    return n === 1 ? '1 customer · requests on issues and projects' : `${n} customers · requests on issues and projects`;
  });

  private readonly _keys = usePageShortcuts([
    { keys: 'c', label: 'New customer', group: 'Customers', run: () => this.canManage() && this.open.set(true) },
  ]);

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const name = String(data.get('name') ?? '').trim();
    const { domains, invalid } = normalizeCustomerDomains(splitDomains(String(data.get('domains') ?? '')));
    if (invalid.length || domains.length === 0) {
      this.formError.set(invalid.length ? `"${invalid[0]}" is not a domain. Use domains like acme.com.` : 'Add at least one domain like acme.com.');
      return;
    }
    this.formError.set('');
    this.saving.set(true);
    const created = await this.store.createCustomer({ name, domains });
    this.saving.set(false);
    if (created) {
      this.open.set(false);
      (event.target as HTMLFormElement).reset();
    }
  }
}
