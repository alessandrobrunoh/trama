import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBuilding2, LucideDynamicIcon } from '@lucide/angular';
import { NablaStore, type Issue } from '../../core';
import { linkedCustomers } from './customer-model';

/** Customers linked to this issue: the count, the list, and link / unlink. */
@Component({
  selector: 'app-issue-customers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    <div class="mb-2 flex items-center gap-1.5 px-0.5">
      <svg [lucideIcon]="building" [size]="13" [strokeWidth]="1.75" class="text-muted-foreground"></svg>
      <h3 class="text-muted-foreground text-xs font-medium">Customers</h3>
      @if (rows().length) {
        <span class="text-muted-foreground/70 text-xs tabular-nums">{{ rows().length }}</span>
      }
    </div>
    <div class="flex flex-col gap-1.5">
      @for (r of rows(); track r.request.id) {
        <div class="bg-card border-border flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
          <a [routerLink]="['/', slug(), 'customers', r.customer.id]" class="min-w-0 flex-1">
            <span class="block truncate text-[13px] font-medium">{{ r.customer.name }}</span>
            <span class="text-muted-foreground block truncate font-mono text-[11px]">{{ r.customer.domain }}</span>
          </a>
          @if (r.customer.archivedAt) {
            <span class="text-muted-foreground text-[10px]">Archived</span>
          }
          @if (canManage()) {
            <button type="button" class="text-muted-foreground hover:text-foreground text-[11px]" (click)="unlink(r.request.id)">Unlink</button>
          }
        </div>
      } @empty {
        <p class="text-muted-foreground px-0.5 text-xs">No customer feedback linked.</p>
      }
      @if (canManage() && linkable().length) {
        <div class="flex gap-1.5">
          <select class="border-border bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-xs" aria-label="Customer to link" [value]="customerId()" (change)="customerId.set($any($event.target).value)">
            <option value="">Link a customer…</option>
            @for (c of linkable(); track c.id) {
              <option [value]="c.id">{{ c.name }} · {{ c.domain }}</option>
            }
          </select>
          <button type="button" class="border-border hover:bg-accent h-8 rounded-md border px-2 text-xs" [disabled]="!customerId()" (click)="link()">Link</button>
        </div>
      }
    </div>
  `,
})
export class IssueCustomers {
  private readonly store = inject(NablaStore);
  readonly issue = input.required<Issue>();
  protected readonly building = LucideBuilding2;
  protected readonly customerId = signal('');
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers') && !this.issue().duplicateOfId);
  protected readonly rows = computed(() =>
    linkedCustomers(this.issue().id, this.store.customerRequests(), this.store.customerById()),
  );
  protected readonly linkable = computed(() => {
    const taken = new Set(this.rows().map((r) => r.customer.id));
    return this.store
      .customers()
      .filter((c) => !c.archivedAt && !taken.has(c.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected async link(): Promise<void> {
    const id = this.customerId();
    if (!id) return;
    const linked = await this.store.linkCustomer(id, { issueId: this.issue().id });
    if (linked) this.customerId.set('');
  }

  protected unlink(requestId: string): void {
    const row = this.rows().find((r) => r.request.id === requestId);
    if (row) void this.store.unlinkCustomer(row.customer.id, requestId);
  }
}
