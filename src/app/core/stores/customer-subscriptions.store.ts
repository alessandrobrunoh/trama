// The customers the signed-in user follows in the open workspace (the bell on a customer page).
// Stored on the server per user: they hear about new, important and delivered requests wherever they sign in.
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { filter } from 'rxjs';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { CustomerSubscription, ID } from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { LiveSync } from '../sync/live-sync.service';
import { NablaStore } from './nabla.store';

@Injectable({ providedIn: 'root' })
export class CustomerSubscriptionsStore {
  private readonly api = inject(ApiClient);
  private readonly nabla = inject(NablaStore);
  private readonly notifier = inject(Notifier);
  private readonly live = inject(LiveSync);

  readonly items = signal<readonly CustomerSubscription[]>([]);
  private readonly followed = computed(() => new Set(this.items().map((s) => s.customerId)));

  constructor() {
    effect(() => {
      const slug = this.nabla.slug();
      const ready = this.nabla.ready();
      untracked(() => {
        if (slug && ready) void this.load();
        else this.items.set([]);
      });
    });
    // Another tab or device of the same person followed or unfollowed something.
    this.live.events$.pipe(filter((e) => e.entity === 'customer_subscription')).subscribe(() => void this.load());
  }

  isFollowing(customerId: ID | null | undefined): boolean {
    return !!customerId && this.followed().has(customerId);
  }

  async load(): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    try {
      const list = await this.api.customerSubscriptions.list(slug);
      if (this.nabla.slug() === slug) this.items.set(list);
    } catch {
      /* following is a convenience; the app works without it */
    }
  }

  /** Follow or unfollow, updating at once and rolling back if the server refuses. */
  async toggle(customerId: ID): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    const before = this.items();
    const existing = before.find((s) => s.customerId === customerId);
    try {
      if (existing) {
        this.items.set(before.filter((s) => s !== existing));
        await this.api.customerSubscriptions.remove(slug, customerId);
      } else {
        const temp: CustomerSubscription = {
          id: `csub_pending_${Date.now()}`,
          workspaceId: this.nabla.workspace()?.id ?? '',
          customerId,
          createdAt: new Date().toISOString(),
        };
        this.items.set([...before, temp]);
        const saved = await this.api.customerSubscriptions.add(slug, customerId);
        this.items.update((list) => list.map((s) => (s === temp ? saved : s)));
      }
    } catch (e) {
      this.items.set(before);
      const err = ApiError.from(e);
      if (!err.isForbidden) this.notifier.error('Could not update notifications', { description: err.message });
    }
  }
}
