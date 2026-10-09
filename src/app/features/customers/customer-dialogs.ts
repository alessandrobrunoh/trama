import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import {
  CUSTOMER_STATUSES,
  TramaStore,
  Notifier,
  UiStore,
  normalizeCustomerDomains,
  normalizeHttpUrl,
  type CustomerStatus,
} from '../../core';
import { Picker, type PickOption } from '../workstreams/picker';
import { splitDomains } from './customer-model';

type TargetKind = 'issue' | 'project';

/** Whole number >= 0 from a text field: `null` when empty, `undefined` when it is not a whole number. */
function wholeNumber(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The two quick forms behind "New customer" and "New customer request" in the command menu and the customer
 * screens. Driven by `UiStore.openCustomerDialog(...)`; one dialog is open at a time.
 */
@Component({
  selector: 'app-customer-dialogs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDialogImports, HlmInputImports, HlmLabelImports, HlmTextareaImports, Picker],
  host: { class: 'contents' },
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="onClosed()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] overflow-y-auto sm:max-w-lg"
        (keydown.meta.enter)="submit()"
        (keydown.control.enter)="submit()"
      >
        @if (isRequest()) {
          <hlm-dialog-header>
            <h2 hlmDialogTitle>New customer request</h2>
            <p hlmDialogDescription>Record what a customer asked for. It sits on an issue or a project; the issue stays the unit of work.</p>
          </hlm-dialog-header>
          <div class="grid gap-3">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Customer</label>
              <app-picker label="Customer" placeholder="Choose a customer…" [options]="customerOptions()" [value]="requestCustomer() ? [requestCustomer()] : []" (valueChange)="requestCustomer.set($event[0] ?? '')" />
            </div>
            <div class="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
              <div class="grid min-w-0 gap-1.5">
                <label hlmLabel>Asked for</label>
                <app-picker label="Kind" [searchable]="false" [options]="kindOptions" [value]="[kind()]" (valueChange)="setKind($event[0])" />
              </div>
              <div class="grid min-w-0 gap-1.5">
                <label hlmLabel>{{ kind() === 'issue' ? 'Issue' : 'Project' }}</label>
                <app-picker
                  [label]="kind() === 'issue' ? 'Issue' : 'Project'"
                  [placeholder]="kind() === 'issue' ? 'Find an issue…' : 'Choose a project…'"
                  [options]="targetOptions()"
                  [value]="targetId() ? [targetId()] : []"
                  (valueChange)="targetId.set($event[0] ?? '')"
                />
              </div>
            </div>
            <div class="grid gap-1.5">
              <label hlmLabel for="cd-body">What did they ask for? <span class="text-muted-foreground font-normal">(markdown)</span></label>
              <textarea hlmTextarea id="cd-body" rows="5" maxlength="20000" placeholder="We need SSO before we can roll this out to the whole company…" [value]="body()" (input)="body.set($any($event.target).value)"></textarea>
            </div>
            <div class="grid gap-1.5">
              <label hlmLabel for="cd-source">Source <span class="text-muted-foreground font-normal">(ticket, email thread, call notes)</span></label>
              <input hlmInput id="cd-source" type="url" maxlength="2000" autocomplete="off" placeholder="https://…" [value]="source()" (input)="source.set($any($event.target).value)" />
            </div>
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" [checked]="important()" (change)="important.set($any($event.target).checked)" />
              Important for this customer
            </label>
            @if (error()) {
              <p class="text-destructive text-xs" role="alert">{{ error() }}</p>
            }
          </div>
          <hlm-dialog-footer>
            <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
            <button hlmBtn type="button" [disabled]="busy()" (click)="submit()">Add request</button>
          </hlm-dialog-footer>
        } @else {
          <hlm-dialog-header>
            <h2 hlmDialogTitle>New customer</h2>
            <p hlmDialogDescription>A customer is a company, not a contact. Its domains identify it.</p>
          </hlm-dialog-header>
          <div class="grid gap-3">
            <div class="grid gap-1.5">
              <label hlmLabel for="cd-name">Name</label>
              <input hlmInput id="cd-name" maxlength="200" autocomplete="off" placeholder="Acme" [attr.aria-invalid]="nameError() ? 'true' : null" [value]="name()" (input)="name.set($any($event.target).value)" />
              @if (nameError()) {
                <p class="text-destructive text-xs" role="alert">Required.</p>
              }
            </div>
            <div class="grid gap-1.5">
              <label hlmLabel for="cd-domains">Domains <span class="text-muted-foreground font-normal">· comma separated, the first is primary</span></label>
              <input hlmInput id="cd-domains" maxlength="2000" autocomplete="off" placeholder="acme.com, acme.io" [value]="domains()" (input)="domains.set($any($event.target).value)" />
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <label hlmLabel for="cd-revenue">Annual revenue <span class="text-muted-foreground font-normal">· optional</span></label>
                <input hlmInput id="cd-revenue" type="number" min="0" step="1" [value]="revenue()" (input)="revenue.set($any($event.target).value)" />
              </div>
              <div class="grid gap-1.5">
                <label hlmLabel for="cd-size">Size in people <span class="text-muted-foreground font-normal">· optional</span></label>
                <input hlmInput id="cd-size" type="number" min="0" step="1" [value]="size()" (input)="size.set($any($event.target).value)" />
              </div>
              <div class="grid min-w-0 gap-1.5">
                <label hlmLabel>Status</label>
                <app-picker label="Status" [searchable]="false" [options]="statusOptions" [value]="[status()]" (valueChange)="status.set($any($event[0] ?? 'active'))" />
              </div>
              @if (tierOptions().length) {
                <div class="grid min-w-0 gap-1.5">
                  <label hlmLabel>Tier</label>
                  <app-picker label="Tier" [searchable]="false" [clearable]="true" clearLabel="No tier" [options]="tierOptions()" [value]="tierId() ? [tierId()] : []" (valueChange)="tierId.set($event[0] ?? '')" />
                </div>
              }
            </div>
            @if (error()) {
              <p class="text-destructive text-xs" role="alert">{{ error() }}</p>
            }
          </div>
          <hlm-dialog-footer>
            <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
            <button hlmBtn type="button" [disabled]="busy()" (click)="submit()">Create customer</button>
          </hlm-dialog-footer>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class CustomerDialogs {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);

  protected readonly open = computed(() => this.ui.modal() === 'customer');
  protected readonly isRequest = computed(() => this.ui.customerDialog().kind === 'request');

  protected readonly kindOptions: PickOption[] = [
    { value: 'issue', label: 'An issue' },
    { value: 'project', label: 'A project' },
  ];
  protected readonly statusOptions: PickOption[] = CUSTOMER_STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));

  // customer form
  protected readonly name = signal('');
  protected readonly domains = signal('');
  protected readonly revenue = signal('');
  protected readonly size = signal('');
  protected readonly status = signal<CustomerStatus>('active');
  protected readonly tierId = signal('');
  // request form
  protected readonly requestCustomer = signal('');
  protected readonly kind = signal<TargetKind>('issue');
  protected readonly targetId = signal('');
  protected readonly body = signal('');
  protected readonly source = signal('');
  protected readonly important = signal(false);

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly submitted = signal(false);
  protected readonly nameError = computed(() => this.submitted() && !this.name().trim());

  protected readonly tierOptions = computed<PickOption[]>(() =>
    this.store.settings().customerTiers.map((t) => ({ value: t.id, label: t.name, kind: 'label', color: t.color })),
  );
  protected readonly customerOptions = computed<PickOption[]>(() =>
    this.store
      .customers()
      .filter((c) => !c.archivedAt)
      .map((c) => ({ value: c.id, label: c.name, hint: c.domain, search: `${c.name} ${c.domains.join(' ')}` })),
  );
  protected readonly targetOptions = computed<PickOption[]>(() => {
    if (this.kind() === 'project') {
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
    // A fresh form every time the dialog opens, prefilled from what opened it.
    effect(() => {
      if (!this.open()) return;
      const state = this.ui.customerDialog();
      untracked(() => {
        this.name.set('');
        this.domains.set('');
        this.revenue.set('');
        this.size.set('');
        this.status.set('active');
        this.tierId.set('');
        this.body.set('');
        this.source.set('');
        this.important.set(false);
        this.busy.set(false);
        this.error.set('');
        this.submitted.set(false);
        if (state.kind === 'request') {
          this.requestCustomer.set(state.customerId ?? '');
          this.kind.set(state.projectId ? 'project' : 'issue');
          this.targetId.set(state.projectId ?? state.issueId ?? '');
        } else {
          this.requestCustomer.set('');
          this.kind.set('issue');
          this.targetId.set('');
        }
      });
    });
  }

  protected setKind(value: string | undefined): void {
    this.kind.set(value === 'project' ? 'project' : 'issue');
    this.targetId.set('');
  }

  protected onClosed(): void {
    if (this.ui.modal() === 'customer') this.ui.closeModal();
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.error.set('');
    this.submitted.set(true);
    if (this.isRequest()) await this.submitRequest();
    else await this.submitCustomer();
  }

  private async submitCustomer(): Promise<void> {
    const name = this.name().trim();
    const { domains, invalid } = normalizeCustomerDomains(splitDomains(this.domains()));
    if (!name) return;
    if (invalid.length || domains.length === 0) {
      this.error.set(invalid.length ? `"${invalid[0]}" is not a domain. Use domains like acme.com.` : 'Add at least one domain like acme.com.');
      return;
    }
    const revenue = wholeNumber(this.revenue());
    const size = wholeNumber(this.size());
    if (revenue === undefined || size === undefined) {
      this.error.set('Revenue and size must be whole numbers, 0 or more.');
      return;
    }
    this.busy.set(true);
    const created = await this.store.createCustomer({
      name,
      domains,
      status: this.status(),
      ...(revenue !== null ? { revenue } : {}),
      ...(size !== null ? { size } : {}),
      ...(this.tierId() ? { tierId: this.tierId() } : {}),
    });
    this.busy.set(false);
    if (!created) return;
    this.ui.closeModal();
    const commands = ['/', this.store.slug() ?? '', 'customers', created.id];
    this.notifier.success(`Customer ${created.name} created`, { action: { label: 'Open', run: () => void this.router.navigate(commands) } });
  }

  private async submitRequest(): Promise<void> {
    const customerId = this.requestCustomer();
    const target = this.targetId();
    if (!customerId || !target) {
      this.error.set(!customerId ? 'Choose a customer.' : 'Choose an issue or a project.');
      return;
    }
    const source = this.source().trim();
    if (source && !normalizeHttpUrl(source)) {
      this.error.set('The source must be an http(s) link.');
      return;
    }
    this.busy.set(true);
    const created = await this.store.createCustomerRequest(customerId, {
      ...(this.kind() === 'issue' ? { issueId: target } : { projectId: target }),
      ...(this.body().trim() ? { body: this.body().trim() } : {}),
      ...(source ? { sourceUrl: source } : {}),
      important: this.important(),
    });
    this.busy.set(false);
    if (!created) return;
    this.ui.closeModal();
    const customer = this.store.getCustomer(customerId);
    const commands = ['/', this.store.slug() ?? '', 'customers', customerId];
    this.notifier.success('Request added', {
      description: customer ? `For ${customer.name}.` : undefined,
      action: { label: 'Open', run: () => void this.router.navigate(commands) },
    });
  }
}
