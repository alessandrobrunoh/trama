import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideBuilding2, LucideDynamicIcon, LucideExternalLink, LucideStar, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  CUSTOMER_STATUSES,
  NablaStore,
  UiStore,
  normalizeCustomerDomains,
  normalizeHttpUrl,
  type CustomerRequest,
  type CustomerStatus,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Markdown } from '../../shared/markdown';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { CustomerAvatar } from './customer-avatar';
import { requestRows, splitDomains } from './customer-model';

type TargetKind = 'issue' | 'project';

@Component({
  selector: 'app-customer-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmInputImports,
    LucideDynamicIcon,
    PageHeader,
    EmptyState,
    StatusIcon,
    TopBarActions,
    CustomerAvatar,
    Markdown,
    ActorAvatar,
    RelativeTimePipe,
  ],
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

      <app-page-header [title]="c.name" [description]="c.domains.join(' · ')">
        <span leading class="text-muted-foreground flex items-center gap-2 text-xs">
          <app-customer-avatar [customer]="c" [size]="22" />
          <span class="rounded border px-1.5 capitalize">{{ c.status }}</span>
          @if (tier(); as t) {
            <span class="rounded border px-1.5" [style.color]="t.color" [style.border-color]="t.color">{{ t.name }}</span>
          }
          @if (c.archivedAt) { <span class="rounded border px-1.5">Archived</span> }
        </span>
      </app-page-header>

      @if (canManage()) {
        <form class="grid grid-cols-1 gap-2 border-b px-4 py-3 sm:grid-cols-2 sm:px-6 lg:grid-cols-4" (submit)="save($event)">
          <label class="flex flex-col gap-1 text-xs">
            Name
            <input hlmInput name="name" required maxlength="200" class="h-9" [value]="c.name" />
          </label>
          <label class="flex flex-col gap-1 text-xs sm:col-span-1 lg:col-span-3">
            Domains (comma separated, the first is the primary)
            <input hlmInput name="domains" required maxlength="2000" class="h-9" [value]="c.domains.join(', ')" />
          </label>
          <label class="flex flex-col gap-1 text-xs sm:col-span-2">
            Logo URL
            <input hlmInput name="logoUrl" type="url" maxlength="2000" class="h-9" placeholder="https://…/logo.png" [value]="c.logoUrl ?? ''" />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            Annual revenue
            <input hlmInput name="revenue" type="number" min="0" step="1" class="h-9" [value]="c.revenue ?? ''" />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            Size (people)
            <input hlmInput name="size" type="number" min="0" step="1" class="h-9" [value]="c.size ?? ''" />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            Status
            <select name="status" class="border-border bg-background h-9 rounded-md border px-2 text-sm capitalize">
              @for (s of statuses; track s) {
                <option [value]="s" [selected]="c.status === s">{{ s }}</option>
              }
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs">
            Tier
            <select name="tierId" class="border-border bg-background h-9 rounded-md border px-2 text-sm">
              <option value="" [selected]="!c.tierId">No tier</option>
              @for (t of tiers(); track t.id) {
                <option [value]="t.id" [selected]="c.tierId === t.id">{{ t.name }}</option>
              }
            </select>
          </label>
          <div class="flex items-end gap-2">
            <button hlmBtn size="sm" type="submit">Save</button>
          </div>
          @if (formError()) { <p class="text-destructive text-xs sm:col-span-2 lg:col-span-4">{{ formError() }}</p> }
        </form>
      } @else {
        <dl class="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 border-b px-4 py-3 text-xs sm:px-6">
          @if (c.revenue !== undefined) { <div><dt class="inline">Revenue </dt><dd class="inline tabular-nums">{{ c.revenue }}</dd></div> }
          @if (c.size !== undefined) { <div><dt class="inline">Size </dt><dd class="inline tabular-nums">{{ c.size }}</dd></div> }
        </dl>
      }

      <div class="flex flex-wrap items-end gap-2 border-b px-4 py-3 sm:px-6">
        <h2 class="mr-auto text-sm font-medium">Requests <span class="text-muted-foreground tabular-nums">{{ rows().length }}</span></h2>
        @if (canManage()) {
          <button hlmBtn size="sm" variant="outline" type="button" (click)="adding.set(!adding())">{{ adding() ? 'Cancel' : 'Add request' }}</button>
        }
      </div>

      @if (adding() && canManage()) {
        <form class="bg-card flex flex-col gap-2 border-b px-4 py-3 sm:px-6" (submit)="addRequest($event)">
          <div class="flex flex-wrap gap-2">
            <select class="border-border bg-background h-9 rounded-md border px-2 text-sm" aria-label="Request on" [value]="kind()" (change)="setKind($any($event.target).value)">
              <option value="issue">On an issue</option>
              <option value="project">On a project</option>
            </select>
            <select class="border-border bg-background h-9 min-w-48 flex-1 rounded-md border px-2 text-sm" aria-label="Target" [value]="targetId()" (change)="targetId.set($any($event.target).value)">
              <option value="">Choose…</option>
              @if (kind() === 'issue') {
                @for (i of issueOptions(); track i.id) {
                  <option [value]="i.id">{{ i.key }} · {{ i.title }}</option>
                }
              } @else {
                @for (p of projectOptions(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              }
            </select>
          </div>
          <textarea class="border-border bg-background min-h-20 w-full resize-y rounded-md border px-2.5 py-2 text-sm outline-none" aria-label="Request" placeholder="What did they ask for? Markdown works." maxlength="20000" [value]="body()" (input)="body.set($any($event.target).value)"></textarea>
          <input hlmInput class="h-9" type="url" aria-label="Source URL" placeholder="Source link (ticket, email thread…)" maxlength="2000" [value]="source()" (input)="source.set($any($event.target).value)" />
          <label class="flex items-center gap-2 text-xs">
            <input type="checkbox" [checked]="important()" (change)="important.set($any($event.target).checked)" /> Important
          </label>
          @if (requestError()) { <p class="text-destructive text-xs">{{ requestError() }}</p> }
          <div><button hlmBtn size="sm" type="submit" [disabled]="!targetId()">Add request</button></div>
        </form>
      }

      @if (rows().length === 0) {
        <app-empty-state title="No requests yet" description="Add a request when this customer asked for something. It sits on an issue or a project, and the issue stays the unit of work." />
      } @else {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @for (r of rows(); track r.request.id) {
            <article class="border-b px-4 py-3 sm:px-6">
              <div class="flex items-center gap-2">
                @if (r.issue; as issue) {
                  <a [routerLink]="['/', slug(), 'issues', issue.key]" class="hover:bg-muted/60 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1">
                    <app-status-icon [status]="issue.status" entity="issue" />
                    <span class="text-muted-foreground w-20 shrink-0 font-mono text-xs">{{ issue.key }}</span>
                    <span class="min-w-0 flex-1 truncate text-sm">{{ issue.title }}</span>
                  </a>
                } @else if (r.project; as project) {
                  <a [routerLink]="['/', slug(), 'projects', project.id]" class="hover:bg-muted/60 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1">
                    <span class="text-muted-foreground w-20 shrink-0 text-xs">Project</span>
                    <span class="min-w-0 flex-1 truncate text-sm">{{ project.name }}</span>
                  </a>
                }
                <button
                  type="button"
                  class="hover:bg-accent inline-flex h-7 w-7 items-center justify-center rounded"
                  [class.text-amber-500]="r.request.important"
                  [class.text-muted-foreground]="!r.request.important"
                  [attr.aria-pressed]="r.request.important"
                  [attr.aria-label]="r.request.important ? 'Not important' : 'Mark important'"
                  [disabled]="!canManage()"
                  (click)="toggleImportant(r.request)"
                >
                  <svg [lucideIcon]="star" [size]="14" [attr.fill]="r.request.important ? 'currentColor' : 'none'"></svg>
                </button>
                @if (canManage()) {
                  <button type="button" class="text-muted-foreground hover:text-destructive text-xs" (click)="deleteRequest(r.request)">Delete</button>
                }
              </div>
              @if (r.request.body) {
                <app-markdown class="mt-1 pl-1" [source]="r.request.body" />
              }
              <div class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 pl-1 text-xs">
                <span class="inline-flex items-center gap-1">
                  <app-actor-avatar [actor]="r.request.createdBy" [size]="14" />
                  {{ store.actorName(r.request.createdBy) }} · {{ r.request.createdAt | relativeTime }}
                </span>
                @if (safeSource(r.request); as href) {
                  <a [href]="href" target="_blank" rel="noopener noreferrer nofollow" class="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2">
                    <svg [lucideIcon]="external" [size]="12"></svg> Source
                  </a>
                }
              </div>
            </article>
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
  protected readonly star = LucideStar;
  protected readonly external = LucideExternalLink;
  protected readonly statuses = CUSTOMER_STATUSES;

  protected readonly formError = signal('');
  protected readonly adding = signal(false);
  protected readonly kind = signal<TargetKind>('issue');
  protected readonly targetId = signal('');
  protected readonly body = signal('');
  protected readonly source = signal('');
  protected readonly important = signal(false);
  protected readonly requestError = signal('');

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly customer = computed(() => this.store.getCustomer(this.id()));
  protected readonly tiers = computed(() => this.store.settings().customerTiers);
  protected readonly tier = computed(() => {
    const tierId = this.customer()?.tierId;
    return tierId ? this.tiers().find((t) => t.id === tierId) : undefined;
  });
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers'));
  protected readonly canDelete = computed(() => this.store.allowed('deleteCustomers'));
  protected readonly rows = computed(() => {
    const c = this.customer();
    return c ? requestRows(c.id, this.store.customerRequests(), this.store.issueById(), this.store.projectById()) : [];
  });
  protected readonly issueOptions = computed(() =>
    this.store.issues().filter((i) => !i.duplicateOfId).slice().sort((a, b) => a.key.localeCompare(b.key)),
  );
  protected readonly projectOptions = computed(() =>
    this.store.projects().slice().sort((a, b) => a.name.localeCompare(b.name)),
  );

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
    const { domains, invalid } = normalizeCustomerDomains(splitDomains(String(data.get('domains') ?? '')));
    if (invalid.length || domains.length === 0) {
      this.formError.set(invalid.length ? `"${invalid[0]}" is not a domain. Use domains like acme.com.` : 'Add at least one domain like acme.com.');
      return;
    }
    const logo = String(data.get('logoUrl') ?? '').trim();
    if (logo && !normalizeHttpUrl(logo)) {
      this.formError.set('The logo must be an http(s) URL.');
      return;
    }
    const revenue = this.wholeNumber(data.get('revenue'));
    const size = this.wholeNumber(data.get('size'));
    if (revenue === undefined || size === undefined) {
      this.formError.set('Revenue and size must be whole numbers, 0 or more.');
      return;
    }
    this.formError.set('');
    await this.store.updateCustomer(c.id, {
      name,
      domains,
      logoUrl: logo || null,
      revenue,
      size,
      tierId: String(data.get('tierId') ?? '') || null,
      status: String(data.get('status') ?? 'active') as CustomerStatus,
    });
  }

  /** `null` for an empty field (clears it), `undefined` for something that is not a whole number >= 0. */
  private wholeNumber(raw: FormDataEntryValue | null): number | null | undefined {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  protected setKind(kind: TargetKind): void {
    this.kind.set(kind);
    this.targetId.set('');
  }

  protected async addRequest(event: Event): Promise<void> {
    event.preventDefault();
    const c = this.customer();
    const target = this.targetId();
    if (!c || !target) return;
    const source = this.source().trim();
    if (source && !normalizeHttpUrl(source)) {
      this.requestError.set('The source must be an http(s) link.');
      return;
    }
    const created = await this.store.createCustomerRequest(c.id, {
      ...(this.kind() === 'issue' ? { issueId: target } : { projectId: target }),
      ...(this.body().trim() ? { body: this.body().trim() } : {}),
      ...(source ? { sourceUrl: source } : {}),
      important: this.important(),
    });
    if (!created) return;
    this.targetId.set('');
    this.body.set('');
    this.source.set('');
    this.important.set(false);
    this.requestError.set('');
    this.adding.set(false);
  }

  protected safeSource(request: CustomerRequest): string | null {
    return request.sourceUrl ? normalizeHttpUrl(request.sourceUrl) : null;
  }

  protected toggleImportant(request: CustomerRequest): void {
    void this.store.updateCustomerRequest(request.customerId, request.id, { important: !request.important });
  }

  protected deleteRequest(request: CustomerRequest): void {
    this.ui.setConfirmDelete({
      title: 'Delete this request?',
      description: `The ${request.issueId ? 'issue' : 'project'} stays.`,
      onConfirm: async () => {
        await this.store.deleteCustomerRequest(request.customerId, request.id);
      },
    });
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
      description: 'The customer and its requests are removed. Issues and projects stay.',
      onConfirm: async () => {
        const ok = await this.store.deleteCustomer(c.id);
        if (ok) void this.router.navigate(['/', this.slug(), 'customers']);
      },
    });
  }
}
