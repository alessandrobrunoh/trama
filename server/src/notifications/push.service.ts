import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import webpush from 'web-push';
import { uid } from '../common/util.js';
import { PushSubscriptionEntity } from '../database/entities/index.js';

/** What the browser needs to show a notification and open the right page on click. */
export interface PushMessage {
  title: string;
  body?: string;
  /** Path inside the web app, e.g. `/acme/issues/BUG-12`. */
  path: string;
  /** Same tag replaces the previous notification instead of stacking. */
  tag?: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

const TTL_SECONDS = 24 * 60 * 60;

/**
 * Angular's service worker (ngsw-worker.js) shows a `push` payload shaped `{ notification: {…} }` and,
 * on click, runs `data.onActionClick.default`: focus an open tab on the path or open a new one.
 */
export function pushPayload(message: PushMessage): string {
  return JSON.stringify({
    notification: {
      title: message.title,
      ...(message.body ? { body: message.body } : {}),
      icon: '/icons/icon-192x192.png',
      ...(message.tag ? { tag: message.tag } : {}),
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: message.path } } },
    },
  });
}

/**
 * Web Push to a person's devices. Enabled by `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (generate with
 * `npx web-push generate-vapid-keys`) and optionally `VAPID_SUBJECT` (a `mailto:` or https URL).
 * Without keys nothing is sent and the UI hides the device switch.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private readonly publicKey: string | null;

  constructor(private readonly ds: DataSource) {
    const pub = process.env.VAPID_PUBLIC_KEY?.trim();
    const priv = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:no-reply@localhost';
    this.publicKey = null;
    if (pub && priv) {
      try {
        webpush.setVapidDetails(subject, pub, priv);
        this.publicKey = pub;
      } catch (e) {
        this.log.warn(`Invalid VAPID configuration, push is off: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      this.log.log('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set: push notifications are not sent');
    }
  }

  get enabled(): boolean {
    return this.publicKey !== null;
  }

  /** Public key the browser subscribes with; null when push is off. */
  get applicationServerKey(): string | null {
    return this.publicKey;
  }

  async list(userId: string) {
    return this.ds.getRepository(PushSubscriptionEntity).findBy({ userId });
  }

  /** Idempotent per endpoint; a device that moves to another account is re-pointed to it. */
  async subscribe(userId: string, input: PushSubscriptionInput) {
    const repo = this.ds.getRepository(PushSubscriptionEntity);
    const existing = await repo.findOneBy({ endpoint: input.endpoint });
    const row = existing ?? repo.create({ id: uid('psh'), endpoint: input.endpoint, createdAt: new Date() });
    row.userId = userId;
    row.p256dh = input.p256dh;
    row.auth = input.auth;
    row.userAgent = input.userAgent?.slice(0, 300) ?? null;
    return repo.save(row);
  }

  /** Only the owner can remove a subscription; unknown endpoints are fine. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.ds.getRepository(PushSubscriptionEntity).delete({ userId, endpoint });
  }

  /** Sends to every device of the person. Returns how many accepted it; dead subscriptions are removed. */
  async send(userId: string, message: PushMessage): Promise<number> {
    if (!this.enabled) return 0;
    const subs = await this.list(userId);
    if (!subs.length) return 0;
    const payload = pushPayload(message);
    let delivered = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: TTL_SECONDS, urgency: 'normal' },
          );
          delivered++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // the browser dropped it (uninstalled, permission revoked): forget it
            await this.ds.getRepository(PushSubscriptionEntity).delete({ id: sub.id });
          } else {
            this.log.warn(`Push to ${new URL(sub.endpoint).host} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }),
    );
    return delivered;
  }
}
