import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideBuilding2, LucideDynamicIcon, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, UiStore, normalizeCustomerDomain } from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { StatusIcon } from '../../shared/status';
import { linkedIssues } from './customer-model';

@Component({
  selector: 'app-customer-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, EmptyState, StatusIcon, TopBarActions],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (customer(); as c) {
      <ng-template appTopBarActions>
        @if (canManage()) {
          <button hlmBtn size="sm" variant="outline" (click)="archive()">{{ c.archivedAt ? 'Restore' : 'Archive' }}</button>
        }
        @if (canDelete()) {
          <button hlmBtn size="sm" variant="outline" (click)="remove()">
            <svg [lucideIcon]="trash" [size]="14"></svg> Delete
          </button>
        }
      </ng-template>

      <app-page-header [title]="c.name" [description]="c.domain">
        <span leading class="text-muted-foreground flex items-center gap-2 text-xs">
          <svg [lucideIcon]="building" [size]="14"></svg>
          @if (c.archivedAt) { <span class="rounded border px-1.5">Archived</span> }
        </span>
      </app-page-header>

      @if (canManage()) {
        <form class="flex flex-wrap items-end gap-2 border-b px-4 py-3 sm:px-6" (submit)="save($event)">
          <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs">
            Name
            <input hlmInput name="name" required maxlength="200" class="h-9" [value]="c.name" />
          </label>
          <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs">
            Domain
            <input hlmInput name="domain" required maxlength="300" class="h-9" [value]="c.domain" />
          </label>
          <button hlmBtn size="sm" type="submit">Save</button>
          @if (formError()) { <p class="text-destructive w-full text-xs">{{ formError() }}</p> }
        </form>
      }

      <div class="flex flex-wrap items-end gap-2 border-b px-4 py-3 sm:px-6">
        <h2 class="mr-auto text-sm font-medium">Linked issues <span class="text-muted-foreground tabular-nums">{{ rows().length }}</span></h2>
        @if (canManage()) {
          <select class="border-border bg-background h-9 min-w-48 rounded-md border px-2 text-sm" aria-label="Issue to link" [value]="issueId()" (change)="issueId.set($any($event.target).value)">
            <option value="">Link an issue…</option>
            @for (i of linkable(); track i.id) {
              <option [value]="i.id">{{ i.key }} · {{ i.title }}</option>
            }
          </select>
          <button hlmBtn size="sm" type="button" [disabled]="!issueId()" (click)="link()">Link</button>
        }
      </div>

      @if (rows().length === 0) {
        <app-empty-state title="No issues linked" description="Link an existing issue when this customer asked for it. The issue stays the unit of demand." />
      } @else {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @for (r of rows(); track r.request.id) {
            <div class="flex min-h-12 items-center gap-3 border-b px-4 py-2 sm:px-6">
              <a [routerLink]="['/', slug(), 'issues', r.issue.key]" class="hover:bg-muted/60 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1">
                <app-status-icon [status]="r.issue.status" entity="issue" />
                <span class="text-muted-foreground w-20 shrink-0 font-mono text-xs">{{ r.issue.key }}</span>
                <span class="min-w-0 flex-1 truncate text-sm">{{ r.issue.title }}</span>
                <span class="text-muted-foreground hidden text-xs capitalize sm:inline">{{ r.issue.status.replaceAll('_', ' ') }}</span>
              </a>
              @if (canManage()) {
                <button type="button" class="text-muted-foreground hover:text-foreground text-xs" (click)="unlink(r.request.id)">Unlink</button>
              }
            </div>
          }
        </div>
      }
    } @else if (store.ready()) {
      <app-empty-state title="Customer not found" description="It may have been deleted, or the link is from another workspace.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'customers']">Back to customers</a>
      </app-empty-state>
    }
  `,
})
export class CustomerDetailPage {
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();

  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  protected readonly building = LucideBuilding2;
  protected readonly trash = LucideTrash2;
  protected readonly issueId = signal('');
  protected readonly formError = signal('');
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly customer = computed(() => this.store.getCustomer(this.id()));
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers'));
  protected readonly canDelete = computed(() => this.store.allowed('deleteCustomers'));
  protected readonly rows = computed(() => {
    const c = this.customer();
    return c ? linkedIssues(c.id, this.store.customerRequests(), this.store.issueById()) : [];
  });
  protected readonly linkable = computed(() => {
    const taken = new Set(this.rows().map((r) => r.issue.id));
    return this.store.issues().filter((i) => !taken.has(i.id)).slice().sort((a, b) => a.key.localeCompare(b.key));
  });

  private readonly _crumbs = usePageCrumbs(() => {
    const c = this.customer();
    return c ? [{ label: c.name }] : [];
  });

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const c = this.customer();
    if (!c) return;
    const data = new FormData(event.target as HTMLFormElement);
    const name = String(data.get('name') ?? '').trim();
    const domain = String(data.get('domain') ?? '').trim();
    if (!normalizeCustomerDomain(domain)) {
      this.formError.set('Use a domain like acme.com.');
      return;
    }
    this.formError.set('');
    await this.store.updateCustomer(c.id, { name, domain });
  }

  protected async link(): Promise<void> {
    const c = this.customer();
    const issueId = this.issueId();
    if (!c || !issueId) return;
    const linked = await this.store.linkCustomer(c.id, { issueId });
    if (linked) this.issueId.set('');
  }

  protected unlink(requestId: string): void {
    const c = this.customer();
    if (c) void this.store.unlinkCustomer(c.id, requestId);
  }

  protected archive(): void {
    const c = this.customer();
    if (c) void this.store.updateCustomer(c.id, { archived: !c.archivedAt });
  }

  protected remove(): void {
    const c = this.customer();
    if (!c) return;
    this.ui.setConfirmDelete({
      title: `Delete ${c.name}?`,
      description: 'The customer and its links are removed. Issues stay.',
      onConfirm: async () => {
        const ok = await this.store.deleteCustomer(c.id);
        if (ok) void this.router.navigate(['/', this.slug(), 'customers']);
      },
    });
  }
}
