// The signed-in user's notifications in the open workspace (Inbox, sidebar badge) and their settings.
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { filter, firstValueFrom } from 'rxjs';
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
import { TramaStore } from './trama.store';

const PAGE = 100;

/** Notification kinds that the attention queue already surfaces. */
const NEEDS_YOU_KINDS: ReadonlySet<NotificationKind> = new Set([
  'input_requested',
  'decision_proposed',
  'review_requested',
  'ci_failed',
]);

@Injectable({ providedIn: 'root' })
export class NotificationsStore {
  private readonly api = inject(ApiClient);
  private readonly trama = inject(TramaStore);
  private readonly notifier = inject(Notifier);
  private readonly live = inject(LiveSync);
  private readonly swPush = inject(SwPush);

  /** Newest first. */
  readonly items = signal<readonly Notification[]>([]);
  /** Unread in this workspace, even beyond the page that is loaded. */
  readonly unread = signal(0);
  readonly loaded = signal(false);

  readonly settings = signal<NotificationSettings>(resolveNotificationSettings());
  /** False when the server has no mail transport, so the email channel cannot deliver. */
  readonly emailAvailable = signal(false);

  readonly hasUnread = computed(() => this.unread() > 0);

  /**
   * Unread notifications that are not already a "needs you" item in the Inbox (a question or a review request
   * shows up there as attention too), so the Inbox badge does not count the same thing twice.
   */
  readonly updatesUnread = computed(() => {
    const dup = this.items().filter((n) => !n.readAt && NEEDS_YOU_KINDS.has(n.kind)).length;
    return Math.max(0, this.unread() - dup);
  });

  // ───────── push (system notifications on this device) ─────────

  /** False in dev builds and browsers without service workers / the Notification API. */
  readonly pushSupported = this.swPush.isEnabled && typeof Notification !== 'undefined';
  /** The server has VAPID keys, so it can send pushes. */
  readonly pushAvailable = signal(false);
  private readonly pushKey = signal<string | null>(null);
  /** This device is registered for push. */
  readonly pushSubscribed = signal(false);
  /** `denied` means the browser blocks notifications for this site until the person changes it there. */
  readonly pushPermission = signal<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );
  readonly pushBusy = signal(false);

  constructor() {
    effect(() => {
      const slug = this.trama.slug();
      const ready = this.trama.ready();
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
    const slug = this.trama.slug();
    if (!slug) return;
    try {
      const res = await this.api.notifications.list(slug, { limit: PAGE });
      if (this.trama.slug() !== slug) return;
      this.items.set(res.items);
      this.unread.set(res.unread);
      this.loaded.set(true);
    } catch {
      /* the inbox is a convenience; the app works without it */
    }
  }

  /** Marks the given notifications (or all of them) read, immediately in the UI. */
  async markRead(ids?: ID[]): Promise<void> {
    const slug = this.trama.slug();
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
    await this.loadPush();
  }

  private async loadPush(): Promise<void> {
    try {
      const res = await this.api.push.status();
      this.pushAvailable.set(res.enabled);
      this.pushKey.set(res.publicKey);
    } catch {
      this.pushAvailable.set(false);
    }
    if (!this.pushSupported) return;
    this.pushPermission.set(Notification.permission);
    const sub = await firstValueFrom(this.swPush.subscription).catch(() => null);
    this.pushSubscribed.set(!!sub);
  }

  /** Asks for permission (must be called from a click) and registers this device. */
  async enablePush(): Promise<void> {
    const serverPublicKey = this.pushKey();
    if (!this.pushSupported || !serverPublicKey || this.pushBusy()) return;
    this.pushBusy.set(true);
    try {
      const sub = await this.swPush.requestSubscription({ serverPublicKey });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth']) throw new Error('The browser returned an incomplete subscription');
      await this.api.push.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] } });
      this.pushSubscribed.set(true);
    } catch (e) {
      if (Notification.permission !== 'denied')
        this.notifier.error('Could not turn on notifications', { description: ApiError.from(e).message });
    } finally {
      this.pushPermission.set(Notification.permission);
      this.pushBusy.set(false);
    }
  }

  /** Unregisters this device; the browser permission stays as it is. */
  async disablePush(): Promise<void> {
    if (!this.pushSupported || this.pushBusy()) return;
    this.pushBusy.set(true);
    try {
      const sub = await firstValueFrom(this.swPush.subscription);
      if (sub) {
        await this.api.push.unsubscribe(sub.endpoint);
        await this.swPush.unsubscribe();
      }
      this.pushSubscribed.set(false);
    } catch (e) {
      this.notifier.error('Could not turn off notifications', { description: ApiError.from(e).message });
    } finally {
      this.pushBusy.set(false);
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
