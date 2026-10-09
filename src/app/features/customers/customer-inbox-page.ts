import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideInbox, LucideRefreshCw, LucideSettings2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { CustomerIntakeStore, NablaStore, normalizeCustomerDomain, type IntakeItem, type IntakeItemStatus } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { Picker, type PickOption } from '../workstreams/picker';
import { CustomerAvatar } from './customer-avatar';
import { IntakeSourceBadge } from './intake-source-badge';

const TABS: { id: IntakeItemStatus; label: string }[] = [
  { id: 'pending', label: 'Waiting' },
  { id: 'linked', label: 'Linked' },
  { id: 'dismissed', label: 'Dismissed' },
];

/** Same value the picker uses for "create the customer from the sender's domain". */
const NEW_CUSTOMER = '__new__';

interface Draft {
  kind: 'issue' | 'project';
  targetId: string;
  customerId: string;
  important: boolean;
}

/**
 * Triage inbox of inbound customer requests (Intercom, Zendesk, Front, Slack, email, webhooks) that were not
 * attached automatically: link each to an issue or a project, or dismiss it.
 */
@Component({
  selector: 'app-customer-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, EmptyState, TopBarActions, Picker, CustomerAvatar, IntakeSourceBadge, RelativeTimePipe],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canConfigure()) {
        <a hlmBtn variant="outline" size="sm" [routerLink]="['/', slug(), 'settings', 'customer-requests']">
          <svg [lucideIcon]="settingsIcon" [size]="14"></svg><span>Sources</span>
        </a>
      }
    </ng-template>

    <app-page-header title="Customer request inbox" description="Requests from your support and chat tools, waiting to be linked to the work they belong to" />

    <div class="flex items-center gap-1.5 border-b px-4 py-1.5 sm:px-6" role="tablist" aria-label="Inbox filter">
      @for (t of tabs; track t.id) {
        <button
          type="button"
          role="tab"
          class="h-7 rounded-md border px-2.5 text-xs transition-colors"
          [class]="inbox.status() === t.id ? 'border-border-strong bg-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          [attr.aria-selected]="inbox.status() === t.id"
          (click)="inbox.load(t.id)"
        >
          {{ t.label }}@if (t.id === 'pending' && inbox.pending()) { <span class="text-muted-foreground ml-1 tabular-nums">{{ inbox.pending() }}</span> }
        </button>
      }
      <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground ml-auto" aria-label="Refresh" [disabled]="inbox.loading()" (click)="inbox.load()">
        <svg [lucideIcon]="refreshIcon" [size]="14" [class.animate-spin]="inbox.loading()"></svg>
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4 py-5 sm:px-6">
        @for (item of inbox.items(); track item.id) {
          <article class="bg-card border-border rounded-lg border px-3.5 py-3" [attr.aria-label]="item.subject || 'Customer request'">
            <header class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
              <app-intake-source-badge [provider]="item.provider" [url]="item.externalUrl" [ticket]="item.externalId" />
              <span class="text-foreground min-w-0 truncate font-medium">{{ item.requesterName || item.requesterEmail || 'Unknown sender' }}</span>
              @if (item.requesterName && item.requesterEmail) {
                <span class="text-muted-foreground min-w-0 truncate">{{ item.requesterEmail }}</span>
              }
              <span class="text-muted-foreground ml-auto shrink-0">{{ item.receivedAt | relativeTime }}</span>
            </header>

            @if (item.subject && item.subject !== item.body) {
              <h3 class="mt-2 text-[13px] font-semibold">{{ item.subject }}</h3>
            }
            <p class="text-foreground/90 mt-1 line-clamp-5 text-[13px] leading-relaxed whitespace-pre-line">{{ item.body }}</p>

            <footer class="mt-3 flex flex-wrap items-center gap-2">
              @if (customerOf(item); as c) {
                <a [routerLink]="['/', slug(), 'customers', c.id]" class="hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs">
                  <app-customer-avatar [customer]="c" [size]="14" /> {{ c.name }}
                </a>
              } @else {
                <span class="text-muted-foreground rounded-md border border-dashed px-1.5 py-0.5 text-xs">No customer matched</span>
              }

              @if (item.status === 'linked') {
                @if (item.issueId && store.getIssue(item.issueId); as issue) {
                  <span class="text-muted-foreground text-xs">Linked to</span>
                  <a class="text-xs underline underline-offset-2" [routerLink]="['/', slug(), 'issues', issue.key]">{{ issue.key }} {{ issue.title }}</a>
                } @else if (item.projectId && store.getProject(item.projectId); as project) {
                  <span class="text-muted-foreground text-xs">Linked to</span>
                  <a class="text-xs underline underline-offset-2" [routerLink]="['/', slug(), 'projects', project.id]">{{ project.name }}</a>
                } @else {
                  <span class="text-muted-foreground text-xs">Linked</span>
                }
              } @else if (item.status === 'dismissed') {
                @if (canManage()) {
                  <button hlmBtn variant="outline" size="sm" class="ml-auto h-7" (click)="inbox.restore(item.id)">Restore</button>
                }
              } @else if (canManage()) {
                <span class="ml-auto flex items-center gap-1.5">
                  <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7" (click)="inbox.dismiss(item.id)">Dismiss</button>
                  <button hlmBtn size="sm" class="h-7" [attr.aria-expanded]="open() === item.id" (click)="toggle(item)">Link…</button>
                </span>
              }
            </footer>

            @if (open() === item.id && draft(); as d) {
              <form class="mt-3 grid gap-2.5 border-t pt-3" (submit)="submit($event, item)">
                <div class="grid gap-2.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <app-picker label="Kind" [searchable]="false" [options]="kindOptions" [value]="[d.kind]" (valueChange)="patch({ kind: $any($event[0] ?? 'issue'), targetId: '' })" />
                  <app-picker
                    [label]="d.kind === 'issue' ? 'Issue' : 'Project'"
                    [placeholder]="d.kind === 'issue' ? 'Find an issue…' : 'Choose a project…'"
                    [options]="targetOptions()"
                    [value]="d.targetId ? [d.targetId] : []"
                    (valueChange)="patch({ targetId: $event[0] ?? '' })"
                  />
                </div>
                @if (!item.customerId) {
                  <app-picker
                    label="Customer"
                    placeholder="Choose the customer…"
                    [options]="customerOptions(item)"
                    [value]="d.customerId ? [d.customerId] : []"
                    (valueChange)="patch({ customerId: $event[0] ?? '' })"
                  />
                }
                <label class="flex items-center gap-2 text-xs">
                  <input type="checkbox" [checked]="d.important" (change)="patch({ important: $any($event.target).checked })" />
                  Flag as important
                </label>
                <div class="flex gap-2">
                  <button hlmBtn size="sm" type="submit" [disabled]="!canSubmit(item, d) || busy()">Link request</button>
                  <button hlmBtn size="sm" variant="ghost" type="button" (click)="open.set(null)">Cancel</button>
                </div>
              </form>
            }
          </article>
        } @empty {
          @if (!inbox.loading()) {
            <app-empty-state
              [icon]="inboxIcon"
              [title]="inbox.status() === 'pending' ? 'Inbox zero' : 'Nothing here'"
              [description]="inbox.status() === 'pending' ? 'Requests that cannot be attached automatically wait here until you link them to an issue or a project.' : ''"
            >
              @if (inbox.status() === 'pending' && canConfigure()) {
                <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'settings', 'customer-requests']">Connect a source</a>
              }
            </app-empty-state>
          }
        }
      </div>
    </div>
  `,
})
export class CustomerInboxPage {
  protected readonly store = inject(NablaStore);
  protected readonly inbox = inject(CustomerIntakeStore);

  protected readonly tabs = TABS;
  protected readonly inboxIcon = LucideInbox;
  protected readonly refreshIcon = LucideRefreshCw;
  protected readonly settingsIcon = LucideSettings2;
  protected readonly kindOptions: PickOption[] = [
    { value: 'issue', label: 'Issue' },
    { value: 'project', label: 'Project' },
  ];

  protected readonly open = signal<string | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly busy = signal(false);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers'));
  protected readonly canConfigure = computed(() => this.store.allowed('manageIntegrations'));

  protected readonly targetOptions = computed<PickOption[]>(() => {
    if (this.draft()?.kind === 'project') {
      return this.store
        .projects()
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: p.id, label: p.name, kind: 'project' as const }));
    }
    return this.store
      .issues()
      .filter((i) => !i.duplicateOfId && i.status !== 'draft')
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((i) => ({ value: i.id, label: i.title, hint: i.key, kind: 'status' as const, status: i.status, statusEntity: 'issue' as const, search: `${i.key} ${i.title}` }));
  });

  constructor() {
    effect(() => {
      if (this.store.slug() && this.store.ready()) untracked(() => void this.inbox.load('pending'));
    });
  }

  protected customerOf(item: IntakeItem) {
    return this.store.getCustomer(item.customerId);
  }

  /** Existing customers, plus "create from the sender's domain" when the sender has a company address. */
  protected customerOptions(item: IntakeItem): PickOption[] {
    const options: PickOption[] = this.store
      .customers()
      .filter((c) => !c.archivedAt)
      .map((c) => ({ value: c.id, label: c.name, hint: c.domain, search: `${c.name} ${c.domains.join(' ')}` }));
    const domain = this.senderDomain(item);
    return domain ? [{ value: NEW_CUSTOMER, label: `Create a customer for ${domain}`, hint: 'new' }, ...options] : options;
  }

  private senderDomain(item: IntakeItem): string | null {
    const at = item.requesterEmail?.lastIndexOf('@') ?? -1;
    return at < 0 ? null : normalizeCustomerDomain(item.requesterEmail!.slice(at + 1));
  }

  protected canSubmit(item: IntakeItem, d: Draft): boolean {
    return !!d.targetId && (!!item.customerId || !!d.customerId);
  }

  protected toggle(item: IntakeItem): void {
    if (this.open() === item.id) {
      this.open.set(null);
      return;
    }
    this.draft.set({ kind: 'issue', targetId: '', customerId: '', important: false });
    this.open.set(item.id);
  }

  protected patch(change: Partial<Draft>): void {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
  }

  protected async submit(event: Event, item: IntakeItem): Promise<void> {
    event.preventDefault();
    const d = this.draft();
    if (!d || !this.canSubmit(item, d)) return;
    this.busy.set(true);
    const creating = !item.customerId && d.customerId === NEW_CUSTOMER;
    const ok = await this.inbox.link(item.id, {
      ...(d.kind === 'issue' ? { issueId: d.targetId } : { projectId: d.targetId }),
      ...(!item.customerId && !creating ? { customerId: d.customerId } : {}),
      ...(creating ? { createCustomer: true } : {}),
      important: d.important,
    });
    this.busy.set(false);
    if (ok) this.open.set(null);
  }
}
