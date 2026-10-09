import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideExternalLink, LucidePencil, LucideStar, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, UiStore, type CustomerRequest } from '../../core';
import { normalizeHttpUrl } from '../../core/contracts/domain';
import { ActorAvatar } from '../../shared/actor-avatar';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { CustomerAvatar } from './customer-avatar';
import { requestsOn } from './customer-model';

/**
 * What customers asked for on one issue or one project, read in full: customer, tier, markdown body,
 * source link, author and time. Members can add, edit, delete and flag a request as important.
 *   <app-customer-requests [issueId]="issue.id" />
 */
@Component({
  selector: 'app-customer-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, Markdown, ActorAvatar, CustomerAvatar, RelativeTimePipe],
  host: { class: 'block' },
  template: `
    @if (rows().length || canManage()) {
      <section aria-label="Customer requests">
        <div class="mb-2 flex items-center gap-2">
          <h2 class="text-[13px] font-semibold">Customer requests</h2>
          @if (rows().length) {
            <span class="text-muted-foreground text-xs tabular-nums">{{ rows().length }}</span>
          }
          @if (canManage() && !adding()) {
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground ml-auto h-6 px-2 text-xs" (click)="startAdd()">Add request</button>
          }
        </div>

        <div class="flex flex-col gap-2">
          @for (r of rows(); track r.request.id) {
            <article class="bg-card border-border rounded-lg border px-3 py-2.5" [class.border-amber-500/50]="r.request.important">
              <header class="flex items-center gap-2">
                <app-customer-avatar [customer]="r.customer" [size]="18" />
                <a [routerLink]="['/', slug(), 'customers', r.customer.id]" class="min-w-0 truncate text-[13px] font-medium hover:underline">{{ r.customer.name }}</a>
                @if (tierOf(r.customer.tierId); as tier) {
                  <span class="rounded border px-1.5 text-[10px]" [style.color]="tier.color" [style.border-color]="tier.color">{{ tier.name }}</span>
                }
                @if (r.customer.archivedAt) {
                  <span class="text-muted-foreground text-[10px]">Archived</span>
                }
                <span class="ml-auto flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    class="hover:bg-accent inline-flex h-6 w-6 items-center justify-center rounded"
                    [class.text-amber-500]="r.request.important"
                    [class.text-muted-foreground]="!r.request.important"
                    [attr.aria-pressed]="r.request.important"
                    [attr.aria-label]="r.request.important ? 'Not important' : 'Mark important'"
                    [title]="r.request.important ? 'Important · click to unmark' : 'Mark important'"
                    [disabled]="!canManage()"
                    (click)="toggleImportant(r.request)"
                  >
                    <svg [lucideIcon]="star" [size]="14" [attr.fill]="r.request.important ? 'currentColor' : 'none'"></svg>
                  </button>
                  @if (canManage()) {
                    <button type="button" class="text-muted-foreground hover:bg-accent inline-flex h-6 w-6 items-center justify-center rounded" aria-label="Edit request" (click)="startEdit(r.request)">
                      <svg [lucideIcon]="pencil" [size]="13"></svg>
                    </button>
                    <button type="button" class="text-muted-foreground hover:text-destructive hover:bg-accent inline-flex h-6 w-6 items-center justify-center rounded" aria-label="Delete request" (click)="remove(r.request)">
                      <svg [lucideIcon]="trash" [size]="13"></svg>
                    </button>
                  }
                </span>
              </header>

              @if (editingId() === r.request.id) {
                <div class="mt-2 flex flex-col gap-2">
                  <textarea
                    class="border-border bg-background min-h-24 w-full resize-y rounded-md border px-2.5 py-2 text-sm leading-relaxed outline-none"
                    aria-label="Request"
                    placeholder="What did the customer ask for? Markdown works."
                    maxlength="20000"
                    [value]="draftBody()"
                    (input)="draftBody.set($any($event.target).value)"
                    (keydown.meta.enter)="saveEdit(r.request)"
                    (keydown.control.enter)="saveEdit(r.request)"
                  ></textarea>
                  <input hlmInput class="h-8 text-[13px]" type="url" aria-label="Source URL" placeholder="Source link (ticket, email thread…)" maxlength="2000" [value]="draftSource()" (input)="draftSource.set($any($event.target).value)" />
                  @if (error()) {
                    <p class="text-destructive text-xs">{{ error() }}</p>
                  }
                  <div class="flex gap-2">
                    <button hlmBtn size="sm" type="button" (click)="saveEdit(r.request)">Save</button>
                    <button hlmBtn size="sm" variant="ghost" type="button" (click)="cancel()">Cancel</button>
                  </div>
                </div>
              } @else {
                @if (r.request.body) {
                  <app-markdown class="mt-1.5" [source]="r.request.body" />
                } @else {
                  <p class="text-muted-foreground mt-1.5 text-xs">No details written.</p>
                }
                <footer class="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span class="inline-flex items-center gap-1">
                    <app-actor-avatar [actor]="r.request.createdBy" [size]="14" />
                    {{ store.actorName(r.request.createdBy) }} · {{ r.request.createdAt | relativeTime }}
                  </span>
                  @if (r.request.updatedAt > r.request.createdAt) {
                    <span>edited {{ r.request.updatedAt | relativeTime }}</span>
                  }
                  @if (safeSource(r.request); as href) {
                    <a [href]="href" target="_blank" rel="noopener noreferrer nofollow" class="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2">
                      <svg [lucideIcon]="external" [size]="12"></svg> Source
                    </a>
                  }
                </footer>
              }
            </article>
          } @empty {
            @if (!adding()) {
              <p class="text-muted-foreground text-xs">No customer has asked for this yet.</p>
            }
          }

          @if (adding() && canManage()) {
            <form class="bg-card border-border flex flex-col gap-2 rounded-lg border px-3 py-2.5" (submit)="add($event)">
              <select class="border-border bg-background h-8 rounded-md border px-2 text-xs" aria-label="Customer" [value]="customerId()" (change)="customerId.set($any($event.target).value)">
                <option value="">Choose a customer…</option>
                @for (c of customers(); track c.id) {
                  <option [value]="c.id">{{ c.name }} · {{ c.domain }}</option>
                }
              </select>
              <textarea
                class="border-border bg-background min-h-24 w-full resize-y rounded-md border px-2.5 py-2 text-sm leading-relaxed outline-none"
                aria-label="Request"
                placeholder="What did the customer ask for? Markdown works."
                maxlength="20000"
                [value]="draftBody()"
                (input)="draftBody.set($any($event.target).value)"
              ></textarea>
              <input hlmInput class="h-8 text-[13px]" type="url" aria-label="Source URL" placeholder="Source link (ticket, email thread…)" maxlength="2000" [value]="draftSource()" (input)="draftSource.set($any($event.target).value)" />
              <label class="flex items-center gap-2 text-xs">
                <input type="checkbox" [checked]="draftImportant()" (change)="draftImportant.set($any($event.target).checked)" />
                Important
              </label>
              @if (error()) {
                <p class="text-destructive text-xs">{{ error() }}</p>
              }
              <div class="flex gap-2">
                <button hlmBtn size="sm" type="submit" [disabled]="!customerId()">Add request</button>
                <button hlmBtn size="sm" variant="ghost" type="button" (click)="cancel()">Cancel</button>
              </div>
            </form>
          }
        </div>
      </section>
    }
  `,
})
export class CustomerRequests {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);

  /** Exactly one of these. */
  readonly issueId = input<string>();
  readonly projectId = input<string>();
  /** Hide the write controls (for example on a duplicate issue). */
  readonly readonly = input(false, { transform: booleanAttribute });

  protected readonly star = LucideStar;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly external = LucideExternalLink;

  protected readonly adding = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly customerId = signal('');
  protected readonly draftBody = signal('');
  protected readonly draftSource = signal('');
  protected readonly draftImportant = signal(false);
  protected readonly error = signal('');

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers') && !this.readonly());
  protected readonly rows = computed(() => {
    const issueId = this.issueId();
    const projectId = this.projectId();
    const target = issueId ? { issueId } : projectId ? { projectId } : null;
    return target ? requestsOn(target, this.store.customerRequests(), this.store.customerById()) : [];
  });
  protected readonly customers = computed(() =>
    this.store
      .customers()
      .filter((c) => !c.archivedAt)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  protected tierOf(id: string | undefined) {
    return id ? this.store.settings().customerTiers.find((t) => t.id === id) : undefined;
  }

  /** Only links that are plain http(s) are rendered as anchors. */
  protected safeSource(request: CustomerRequest): string | null {
    return request.sourceUrl ? normalizeHttpUrl(request.sourceUrl) : null;
  }

  protected startAdd(): void {
    this.reset();
    this.adding.set(true);
  }

  protected startEdit(request: CustomerRequest): void {
    this.reset();
    this.editingId.set(request.id);
    this.draftBody.set(request.body ?? '');
    this.draftSource.set(request.sourceUrl ?? '');
  }

  protected cancel(): void {
    this.reset();
  }

  protected async add(event: Event): Promise<void> {
    event.preventDefault();
    const customerId = this.customerId();
    if (!customerId) return;
    const source = this.draftSource().trim();
    if (source && !normalizeHttpUrl(source)) {
      this.error.set('The source must be an http(s) link.');
      return;
    }
    const issueId = this.issueId();
    const projectId = this.projectId();
    const created = await this.store.createCustomerRequest(customerId, {
      ...(issueId ? { issueId } : projectId ? { projectId } : {}),
      ...(this.draftBody().trim() ? { body: this.draftBody().trim() } : {}),
      ...(source ? { sourceUrl: source } : {}),
      important: this.draftImportant(),
    });
    if (created) this.reset();
  }

  protected async saveEdit(request: CustomerRequest): Promise<void> {
    const source = this.draftSource().trim();
    if (source && !normalizeHttpUrl(source)) {
      this.error.set('The source must be an http(s) link.');
      return;
    }
    const ok = await this.store.updateCustomerRequest(request.customerId, request.id, {
      body: this.draftBody().trim() || null,
      sourceUrl: source || null,
    });
    if (ok) this.reset();
  }

  protected toggleImportant(request: CustomerRequest): void {
    if (!this.canManage()) return;
    void this.store.updateCustomerRequest(request.customerId, request.id, { important: !request.important });
  }

  protected remove(request: CustomerRequest): void {
    const customer = this.store.getCustomer(request.customerId);
    this.ui.setConfirmDelete({
      title: 'Delete this request?',
      description: `${customer?.name ?? 'The customer'}'s request is removed. The ${request.issueId ? 'issue' : 'project'} stays.`,
      onConfirm: async () => {
        await this.store.deleteCustomerRequest(request.customerId, request.id);
      },
    });
  }

  private reset(): void {
    this.adding.set(false);
    this.editingId.set(null);
    this.customerId.set('');
    this.draftBody.set('');
    this.draftSource.set('');
    this.draftImportant.set(false);
    this.error.set('');
  }
}
