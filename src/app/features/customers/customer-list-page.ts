import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBuilding2, LucideDynamicIcon, LucidePlus, LucideSearch } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, normalizeCustomerDomain, usePageShortcuts } from '../../core';
import { ListStateStore } from '../../core/stores/list-state.store';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';


@Component({
  selector: 'app-customer-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, Kbd, EmptyState, TopBarActions],
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
          Domain
          <input hlmInput name="domain" required maxlength="300" class="h-9" placeholder="acme.com" />
        </label>
        <button hlmBtn size="sm" type="submit" [disabled]="saving()">Create</button>
        <button hlmBtn size="sm" variant="ghost" type="button" (click)="open.set(false)">Cancel</button>
        @if (formError()) {
          <p class="text-destructive w-full text-xs">{{ formError() }}</p>
        }
      </form>
    }

    @if (total() === 0) {
      <app-empty-state [icon]="building" title="No customers yet" description="A customer is a company, not a contact. Add one when feedback should be tied to the issues it produced.">
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
          <span class="w-28 text-right">Issues</span>
        </div>
        @for (r of shown(); track r.customer.id) {
          <a
            [routerLink]="['/', slug(), 'customers', r.customer.id]"
            role="listitem"
            class="hover:bg-muted/60 flex min-h-14 items-center gap-3 border-b px-4 py-3 sm:px-6"
          >
            <span class="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
              <svg [lucideIcon]="building" [size]="15"></svg>
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium">{{ r.customer.name }}</span>
                @if (r.customer.archivedAt) {
                  <span class="text-muted-foreground rounded border px-1.5 text-[11px]">Archived</span>
                }
              </span>
              <span class="text-muted-foreground block truncate font-mono text-xs">{{ r.customer.domain }}</span>
            </span>
            <span class="text-muted-foreground w-28 shrink-0 text-right text-sm tabular-nums">{{ r.issues }}</span>
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

  private readonly issueCounts = computed(() => {
    const sets = new Map<string, Set<string>>();
    for (const request of this.store.customerRequests()) {
      let set = sets.get(request.customerId);
      if (!set) sets.set(request.customerId, (set = new Set()));
      set.add(request.issueId);
    }
    return sets;
  });
  protected readonly total = computed(() => this.store.customers().filter((c) => this.showArchived() || !c.archivedAt).length);
  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    const counts = this.issueCounts();
    return this.store
      .customers()
      .filter((c) => (this.showArchived() || !c.archivedAt) && (!q || `${c.name} ${c.domain}`.toLowerCase().includes(q)))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((customer) => ({ customer, issues: counts.get(customer.id)?.size ?? 0 }));
  });
  protected readonly description = computed(() => {
    const n = this.store.customers().filter((c) => !c.archivedAt).length;
    return n === 1 ? '1 customer · feedback linked to issues' : `${n} customers · feedback linked to issues`;
  });

  private readonly _keys = usePageShortcuts([
    { keys: 'c', label: 'New customer', group: 'Customers', run: () => this.canManage() && this.open.set(true) },
  ]);

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const name = String(data.get('name') ?? '').trim();
    const domain = String(data.get('domain') ?? '').trim();
    if (!normalizeCustomerDomain(domain)) {
      this.formError.set('Use a domain like acme.com.');
      return;
    }
    this.formError.set('');
    this.saving.set(true);
    const created = await this.store.createCustomer({ name, domain });
    this.saving.set(false);
    if (created) {
      this.open.set(false);
      (event.target as HTMLFormElement).reset();
    }
  }
}
