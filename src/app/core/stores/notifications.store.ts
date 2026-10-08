// The signed-in user's notifications in the open workspace (Inbox, sidebar badge) and their settings.
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { filter } from 'rxjs';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type {
  ID,
  Notification,
  NotificationChannels,
  NotificationKind,
  NotificationSettings,
} from '../contracts/domain';
import { resolveNotificationSettings } from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { LiveSync } from '../sync/live-sync.service';
import { NablaStore } from './nabla.store';

const PAGE = 100;

@Injectable({ providedIn: 'root' })
export class NotificationsStore {
  private readonly api = inject(ApiClient);
  private readonly nabla = inject(NablaStore);
  private readonly notifier = inject(Notifier);
  private readonly live = inject(LiveSync);

  /** Newest first. */
  readonly items = signal<readonly Notification[]>([]);
  /** Unread in this workspace, even beyond the page that is loaded. */
  readonly unread = signal(0);
  readonly loaded = signal(false);

  readonly settings = signal<NotificationSettings>(resolveNotificationSettings());
  /** False when the server has no mail transport, so the email channel cannot deliver. */
  readonly emailAvailable = signal(false);

  readonly hasUnread = computed(() => this.unread() > 0);

  constructor() {
    effect(() => {
      const slug = this.nabla.slug();
      const ready = this.nabla.ready();
      untracked(() => {
        if (slug && ready) void this.load();
        else {
          this.items.set([]);
          this.unread.set(0);
          this.loaded.set(false);
        }
      });
    });
    // A new notification arrived, or another tab marked some as read.
    this.live.events$.pipe(filter((e) => e.entity === 'notification')).subscribe(() => void this.load());
  }

  async load(): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    try {
      const res = await this.api.notifications.list(slug, { limit: PAGE });
      if (this.nabla.slug() !== slug) return;
      this.items.set(res.items);
      this.unread.set(res.unread);
      this.loaded.set(true);
    } catch {
      /* the inbox is a convenience; the app works without it */
    }
  }

  /** Marks the given notifications (or all of them) read, immediately in the UI. */
  async markRead(ids?: ID[]): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    const before = this.items();
    const before_unread = this.unread();
    const now = new Date().toISOString();
    const targets = new Set(ids ?? before.filter((n) => !n.readAt).map((n) => n.id));
    const flipped = before.filter((n) => !n.readAt && targets.has(n.id)).length;
    if (!flipped && ids) return;
    this.items.set(before.map((n) => (!n.readAt && targets.has(n.id) ? { ...n, readAt: now } : n)));
    this.unread.set(ids ? Math.max(0, before_unread - flipped) : 0);
    try {
      const res = await this.api.notifications.markRead(slug, ids);
      this.unread.set(res.unread);
    } catch (e) {
      this.items.set(before);
      this.unread.set(before_unread);
      this.notifier.error('Could not mark as read', { description: ApiError.from(e).message });
    }
  }

  async loadSettings(): Promise<void> {
    try {
      const res = await this.api.notifications.settings();
      this.settings.set(resolveNotificationSettings(res.settings));
      this.emailAvailable.set(res.emailAvailable);
    } catch {
      /* keep the defaults; saving will report errors */
    }
  }

  /** Turn one channel of one kind on or off; rolls back if the server refuses. */
  async setChannel(kind: NotificationKind, channel: keyof NotificationChannels, on: boolean): Promise<void> {
    const before = this.settings();
    this.settings.set({ ...before, [kind]: { ...before[kind], [channel]: on } });
    try {
      const res = await this.api.notifications.updateSettings({ [kind]: { [channel]: on } });
      this.settings.set(resolveNotificationSettings(res.settings));
    } catch (e) {
      this.settings.set(before);
      this.notifier.error('Could not save notification settings', { description: ApiError.from(e).message });
    }
  }
}
