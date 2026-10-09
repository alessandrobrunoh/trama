// The triage inbox of inbound customer requests (Intercom, Zendesk, Front, Slack, email, signed webhooks)
// for the open workspace. Server-owned: rows are loaded on demand, only the waiting count is kept warm.
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { debounceTime, filter } from 'rxjs';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { LinkIntakeItemInput } from '../api/api.types';
import type { ID, IntakeItem, IntakeItemStatus } from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { LiveSync } from '../sync/live-sync.service';
import { NablaStore } from './nabla.store';

@Injectable({ providedIn: 'root' })
export class CustomerIntakeStore {
  private readonly api = inject(ApiClient);
  private readonly nabla = inject(NablaStore);
  private readonly notifier = inject(Notifier);
  private readonly live = inject(LiveSync);

  /** Requests waiting to be linked; `null` until first loaded. */
  readonly pending = signal<number | null>(null);
  readonly items = signal<readonly IntakeItem[]>([]);
  readonly status = signal<IntakeItemStatus>('pending');
  readonly loading = signal(false);

  constructor() {
    effect(() => {
      const slug = this.nabla.slug();
      const ready = this.nabla.ready();
      untracked(() => {
        this.items.set([]);
        this.pending.set(null);
        if (slug && ready) void this.refreshCount();
      });
    });
    // Auto-linked requests and links made by someone else show up as customer-request events.
    this.live.events$
      .pipe(
        filter((e) => e.entity === 'customer_request' || e.entity === 'customer'),
        debounceTime(400),
      )
      .subscribe(() => void this.refreshCount());
  }

  async refreshCount(): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    try {
      const { pending } = await this.api.customerIntake.count(slug, { quiet: true });
      if (this.nabla.slug() === slug) this.pending.set(pending);
    } catch {
      /* the inbox is a convenience on the customers page; it reports its own errors when opened */
    }
  }

  async load(status: IntakeItemStatus = this.status()): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    this.status.set(status);
    this.loading.set(true);
    try {
      const list = await this.api.customerIntake.list(slug, status);
      if (this.nabla.slug() === slug && this.status() === status) this.items.set(list);
      if (status === 'pending' && this.nabla.slug() === slug) this.pending.set(list.length);
    } catch (e) {
      this.fail('Could not load the inbox', e);
    } finally {
      this.loading.set(false);
    }
  }

  /** Links the item to an issue or project. Resolves true when the server accepted it. */
  async link(id: ID, input: LinkIntakeItemInput): Promise<boolean> {
    const slug = this.nabla.slug();
    if (!slug) return false;
    try {
      const item = await this.api.customerIntake.link(slug, id, input);
      this.settle(item);
      // the new request (and maybe a new customer) belongs in the workspace data too
      await this.nabla.refetch();
      return true;
    } catch (e) {
      this.fail('Could not link the request', e);
      return false;
    }
  }

  async dismiss(id: ID): Promise<void> {
    await this.move(id, (slug) => this.api.customerIntake.dismiss(slug, id), 'Could not dismiss the request');
  }

  async restore(id: ID): Promise<void> {
    await this.move(id, (slug) => this.api.customerIntake.restore(slug, id), 'Could not restore the request');
  }

  private async move(id: ID, call: (slug: string) => Promise<IntakeItem>, failure: string): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    try {
      this.settle(await call(slug));
    } catch (e) {
      this.fail(failure, e);
      void this.load();
    }
  }

  /** The item left the list it was shown in. */
  private settle(item: IntakeItem): void {
    if (item.status !== this.status()) this.items.update((list) => list.filter((i) => i.id !== item.id));
    else this.items.update((list) => list.map((i) => (i.id === item.id ? item : i)));
    void this.refreshCount();
  }

  private fail(title: string, e: unknown): void {
    const err = ApiError.from(e);
    if (err.status !== 403) this.notifier.error(title, { description: err.message });
  }
}
