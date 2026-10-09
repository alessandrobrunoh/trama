import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Subscription } from 'rxjs';
import { In, type Repository } from 'typeorm';
import { webhookEventMatches } from '../contracts/domain.js';
import type { WebhookDeliveryLog } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  DomainEventEntity,
  OutgoingWebhookDeliveryEntity,
  OutgoingWebhookEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { HttpClient } from '../integrations/http-client.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { signBody } from './signature.js';

export const DELIVERY_TIMEOUT_MS = 5000;
/** Newest deliveries kept per webhook. */
export const DELIVERY_LOG_KEEP = 50;
const MAX_QUEUE = 200;
const CACHE_TTL_MS = 10_000;
export const MAX_WEBHOOKS_PER_WORKSPACE = 20;

export interface DeliveryPayload {
  id: string;
  event: string;
  workspaceId: string;
  at: string;
  actor: DomainEventEntity['actor'];
  subject: DomainEventEntity['subject'];
  workstreamId?: string;
  data: Record<string, unknown>;
}

@Injectable()
export class OutgoingWebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutgoingWebhooksService.name);
  private sub?: Subscription;
  /** Delay before the single retry (tests lower it). */
  retryDelayMs = Number(process.env.NABLA_WEBHOOK_RETRY_MS ?? 2000);
  private readonly cache = new Map<string, { at: number; rows: OutgoingWebhookEntity[] }>();
  /** Deliveries of one webhook run one after the other, so receivers see events in order. */
  private readonly dispatching = new Set<Promise<void>>();
  private readonly chains = new Map<string, { tail: Promise<void>; size: number }>();

  constructor(
    private readonly events: EventsService,
    private readonly http: HttpClient,
    private readonly secrets: SecretsService,
    @InjectRepository(OutgoingWebhookEntity) private readonly hooks: Repository<OutgoingWebhookEntity>,
    @InjectRepository(OutgoingWebhookDeliveryEntity) private readonly deliveries: Repository<OutgoingWebhookDeliveryEntity>,
  ) {}

  onModuleInit(): void {
    this.sub = this.events.recorded$.subscribe((event) => {
      const p: Promise<void> = this.dispatch(event)
        .catch((e: Error) => this.logger.warn(`dispatch failed: ${e.message}`))
        .finally(() => this.dispatching.delete(p));
      this.dispatching.add(p);
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  // ───────── management

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  list(workspaceId: string) {
    return this.hooks.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.hooks.findOneBy({ id, workspaceId });
    if (!row) throw notFound('Webhook', id);
    return row;
  }

  async create(workspaceId: string, input: { name: string; url: string; events: string[]; enabled?: boolean }) {
    const id = uid('wh');
    const secret = generateSecret();
    const row = await this.hooks.save(
      this.hooks.create({
        id,
        workspaceId,
        name: input.name.trim(),
        url: input.url,
        events: [...new Set(input.events)],
        enabled: input.enabled ?? true,
        secret: this.secrets.encrypt(secret, aad(id)),
      }),
    );
    this.invalidate(workspaceId);
    return { webhook: row, secret };
  }

  async update(workspaceId: string, id: string, patch: { name?: string; url?: string; events?: string[]; enabled?: boolean }) {
    const row = await this.get(workspaceId, id);
    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.url !== undefined) row.url = patch.url;
    if (patch.events !== undefined) row.events = [...new Set(patch.events)];
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    await this.hooks.save(row);
    this.invalidate(workspaceId);
    return row;
  }

  async rotateSecret(workspaceId: string, id: string) {
    const row = await this.get(workspaceId, id);
    const secret = generateSecret();
    row.secret = this.secrets.encrypt(secret, aad(id));
    await this.hooks.save(row);
    this.invalidate(workspaceId);
    return { webhook: row, secret };
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.hooks.delete({ id });
    this.invalidate(workspaceId);
  }

  async recentDeliveries(workspaceId: string, id: string, limit = 20): Promise<WebhookDeliveryLog[]> {
    await this.get(workspaceId, id);
    const rows = await this.deliveries.find({ where: { webhookId: id }, order: { at: 'DESC', id: 'DESC' }, take: Math.min(Math.max(limit, 1), DELIVERY_LOG_KEEP) });
    return rows.map(toLog);
  }

  /** Sends a `ping` event now (even when the webhook is disabled) and returns the delivery result. */
  async ping(workspaceId: string, id: string): Promise<WebhookDeliveryLog> {
    const hook = await this.get(workspaceId, id);
    const payload: DeliveryPayload = {
      id: uid('ev'),
      event: 'ping',
      workspaceId,
      at: new Date().toISOString(),
      actor: { type: 'system' },
      subject: { type: 'webhook', id: hook.id } as unknown as DomainEventEntity['subject'],
      data: { message: `Test delivery for webhook "${hook.name}"` },
    };
    return toLog(await this.deliver(hook, payload, false));
  }

  // ───────── dispatch

  private async activeFor(workspaceId: string): Promise<OutgoingWebhookEntity[]> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await this.hooks.find({ where: { workspaceId, enabled: true } });
    this.cache.set(workspaceId, { at: Date.now(), rows });
    return rows;
  }

  private async dispatch(event: DomainEventEntity): Promise<void> {
    const hooks = (await this.activeFor(event.workspaceId)).filter((h) => webhookEventMatches(h.events, event.type));
    if (!hooks.length) return;
    const payload: DeliveryPayload = {
      id: event.id,
      event: event.type,
      workspaceId: event.workspaceId,
      at: event.at.toISOString(),
      actor: event.actor,
      subject: event.subject,
      ...(event.workstreamId ? { workstreamId: event.workstreamId } : {}),
      data: event.data,
    };
    for (const hook of hooks) this.enqueue(hook, payload);
  }

  private enqueue(hook: OutgoingWebhookEntity, payload: DeliveryPayload): void {
    const chain = this.chains.get(hook.id) ?? { tail: Promise.resolve(), size: 0 };
    if (chain.size >= MAX_QUEUE) {
      this.logger.warn(`webhook ${hook.id}: delivery queue full, dropping ${payload.event}`);
      return;
    }
    chain.size++;
    chain.tail = chain.tail
      .then(() => this.deliver(hook, payload, true).then(() => undefined))
      .catch((e: Error) => this.logger.warn(`webhook ${hook.id}: ${e.message}`))
      .finally(() => {
        chain.size--;
        if (chain.size === 0) this.chains.delete(hook.id);
      });
    this.chains.set(hook.id, chain);
  }

  /** Waits for every queued delivery (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.dispatching.size || this.chains.size) {
      await Promise.all([...this.dispatching]);
      await Promise.all([...this.chains.values()].map((c) => c.tail));
    }
  }

  /** POST once, then (when `retry`) once more after `retryDelayMs` if it failed with a network error, 429 or 5xx. */
  private async deliver(hook: OutgoingWebhookEntity, payload: DeliveryPayload, retry: boolean): Promise<OutgoingWebhookDeliveryEntity> {
    let last = await this.attempt(hook, payload, 1);
    if (retry && !last.ok && (last.status === 0 || last.status === 429 || last.status >= 500)) {
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      last = await this.attempt(hook, payload, 2);
    }
    return last;
  }

  private async attempt(hook: OutgoingWebhookEntity, payload: DeliveryPayload, attempt: number): Promise<OutgoingWebhookDeliveryEntity> {
    const started = Date.now();
    let status = 0;
    let error: string | null = null;
    try {
      const body = JSON.stringify(payload);
      const secret = this.secrets.decrypt(hook.secret, aad(hook.id));
      const res = await this.http.request({
        method: 'POST',
        url: hook.url,
        rawBody: body,
        timeoutMs: DELIVERY_TIMEOUT_MS,
        maxBytes: 64 * 1024,
        truncate: true,
        headers: {
          'User-Agent': 'Nabla-Webhooks/1',
          'X-Nabla-Event': payload.event,
          'X-Nabla-Delivery': payload.id,
          'X-Nabla-Signature': signBody(secret, body),
        },
      });
      status = res.status;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e) {
      error = describeError(e);
    }
    const log = this.deliveries.create({
      id: uid('wd'),
      webhookId: hook.id,
      event: payload.event,
      status,
      ok: status >= 200 && status < 300,
      durationMs: Date.now() - started,
      error,
      attempt,
      at: new Date(),
    });
    try {
      await this.deliveries.save(log);
      await this.hooks.update({ id: hook.id }, { lastDeliveryAt: log.at, lastStatus: status });
      void this.prune(hook.id);
    } catch (e) {
      // the webhook may have been deleted while the delivery was in flight
      this.logger.debug(`delivery log not saved: ${(e as Error).message}`);
    }
    return log;
  }

  private async prune(webhookId: string): Promise<void> {
    const old = await this.deliveries.find({ where: { webhookId }, order: { at: 'DESC', id: 'DESC' }, skip: DELIVERY_LOG_KEEP, take: 100, select: { id: true } });
    if (old.length) await this.deliveries.delete({ id: In(old.map((o) => o.id)) });
  }
}

const aad = (id: string) => `${id}:outgoing`;
const generateSecret = () => SecretsService.generateWebhookSecret();

function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `Timed out after ${DELIVERY_TIMEOUT_MS / 1000}s`;
  const cause = err?.cause?.code ?? err?.cause?.message;
  return (cause ? `${err.message}: ${cause}` : (err?.message ?? 'Request failed')).slice(0, 300);
}

function toLog(row: OutgoingWebhookDeliveryEntity): WebhookDeliveryLog {
  return {
    id: row.id,
    webhookId: row.webhookId,
    event: row.event,
    status: row.status,
    ok: row.ok,
    durationMs: row.durationMs,
    ...(row.error ? { error: row.error } : {}),
    attempt: row.attempt,
    at: row.at.toISOString(),
  };
}
