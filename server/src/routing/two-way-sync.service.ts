import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Subscription } from 'rxjs';
import { DataSource, type Repository } from 'typeorm';
import { resolveStatusEntry } from '../contracts/domain.js';
import { DomainEventEntity, IntegrationConnectionEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { ProviderHttpError } from '../integrations/http-client.js';
import { loadStatusCatalog } from '../status/status-catalog.js';
import { connectionHealthy, connectionLabel, connectionView } from './connection-access.js';
import { RoutingRuleEntity, RoutingRuleItemEntity } from './entities.js';
import { RoutingRulesService } from './routing-rules.service.js';

export type TwoWayOutcome =
  | { status: 'synced'; state: 'open' | 'closed' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Two-way rules: when a person (or an agent) closes or reopens a task that a rule created from an external
 * issue, the issue is closed or reopened on the host through the rule's connection. The other direction
 * (the host closing the issue) is `InboundRoutingService.follow`. Changes made by the system itself never go
 * back out, so the two directions cannot echo each other.
 */
@Injectable()
export class TwoWaySyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TwoWaySyncService.name);
  private sub?: Subscription;
  /** Changes of one task run in order, so a quick close and reopen ends in the state the person left. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    private readonly routing: RoutingRulesService,
    @InjectRepository(RoutingRuleItemEntity) private readonly items: Repository<RoutingRuleItemEntity>,
    @InjectRepository(RoutingRuleEntity) private readonly rules: Repository<RoutingRuleEntity>,
    @InjectRepository(IntegrationConnectionEntity) private readonly connections: Repository<IntegrationConnectionEntity>,
  ) {}

  onModuleInit(): void {
    this.sub = this.events.recorded$.subscribe((event) => {
      if (event.type !== 'issue.status_changed' || event.actor?.type === 'system') return;
      void this.enqueue(event).catch((e: Error) => this.log.warn(`two-way sync failed: ${e.message}`));
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  private enqueue(event: DomainEventEntity): Promise<unknown> {
    const key = event.subject.id;
    const next = (this.chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.apply(event));
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    }).catch(() => undefined);
    return next;
  }

  /** Resolves when every change queued so far has been sent (tests). */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  async apply(event: DomainEventEntity): Promise<TwoWayOutcome> {
    const from = String(event.data?.from ?? '');
    const to = String(event.data?.to ?? '');
    const item = await this.items.findOneBy({ issueId: event.subject.id, kind: 'issue', workspaceId: event.workspaceId });
    if (!item?.ruleId) return { status: 'skipped', reason: 'not routed by a rule' };
    const rule = await this.rules.findOneBy({ id: item.ruleId });
    if (!rule || rule.direction !== 'two_way') return { status: 'skipped', reason: 'the rule is inbound only' };

    const catalog = (await loadStatusCatalog(this.ds, event.workspaceId)).issue;
    const finished = (status: string) => {
      const type = resolveStatusEntry(catalog, status)?.type;
      return type === 'done' || type === 'canceled';
    };
    if (finished(from) === finished(to)) return { status: 'skipped', reason: 'open or closed did not change' };
    const state = finished(to) ? 'closed' : 'open';
    if (item.externalState === state) return { status: 'skipped', reason: 'the issue is already there' };

    const row = rule.connectionId ? await this.connections.findOneBy({ id: rule.connectionId }) : null;
    const view = row ? connectionView(row) : null;
    if (!row || !view || !connectionHealthy(view)) {
      const reason = `The connection is not working, so ${item.repository}${item.externalId} was not ${state === 'closed' ? 'closed' : 'reopened'}.`;
      await this.routing.recordError(rule.id, reason);
      return { status: 'failed', reason };
    }
    try {
      const client = await this.routing.clientFor(row);
      if (!client.setIssueState) throw new Error(`${connectionLabel(view)} cannot close issues`);
      const number = Number(item.externalId.slice(1));
      if (!Number.isInteger(number)) throw new Error(`Not an issue number: ${item.externalId}`);
      await client.setIssueState(item.repository, number, state, resolveStatusEntry(catalog, to)?.type === 'canceled' ? 'not_planned' : 'completed');
      await this.items.update({ id: item.id }, { externalState: state });
      await this.routing.recordSuccess(rule.id);
      return { status: 'synced', state };
    } catch (e) {
      const reason = e instanceof ProviderHttpError ? `${connectionLabel(view)} refused the change (${e.message})` : (e as Error).message;
      await this.routing.recordError(rule.id, `Could not ${state === 'closed' ? 'close' : 'reopen'} ${item.repository}${item.externalId}: ${reason}`);
      return { status: 'failed', reason };
    }
  }
}
