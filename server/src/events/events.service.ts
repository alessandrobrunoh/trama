import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Client } from 'pg';
import { Subject } from 'rxjs';
import type { EntityManager, Repository } from 'typeorm';
import type {
  ActorRef,
  LiveEvent,
  SubjectRef,
} from '../contracts/domain.js';
import { databaseUrl } from '../database/data-source.options.js';
import { DomainEventEntity } from '../database/entities/index.js';
import { uid } from '../common/util.js';
import { requestStore } from './request-store.js';

export interface RecordEventInput {
  workspaceId: string;
  actor: ActorRef;
  /** e.g. `workstream.created`, `execution.state_changed` (see contracts/domain.ts). */
  type: string;
  subject: SubjectRef;
  workstreamId?: string | null;
  data?: Record<string, unknown>;
  /** Backdating (seed only). */
  at?: Date;
  /** Pass the transaction manager to write atomically with the mutation. */
  manager?: EntityManager;
}

export interface PublishedEvent {
  workspaceId: string;
  event: LiveEvent;
  /** When set, only this person's streams receive the event (private things, like notifications). */
  userId?: string;
}

/** Postgres channel that carries live events between API instances. */
const LIVE_CHANNEL = 'trama_live';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EventsService.name);
  private readonly bus = new Subject<PublishedEvent>();
  /** All live events of all workspaces; filter by `workspaceId`. */
  readonly stream$ = this.bus.asObservable();

  private readonly recorded = new Subject<DomainEventEntity>();
  /** Every DomainEvent right after it was persisted (not backdated seed events). Used by outgoing webhooks. */
  readonly recorded$ = this.recorded.asObservable();

  /** Dedicated connection that LISTENs on LIVE_CHANNEL; null while it is not connected. */
  private listener: Client | null = null;
  private listening = false;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;

  constructor(
    @InjectRepository(DomainEventEntity)
    private readonly repo: Repository<DomainEventEntity>,
  ) {}

  /**
   * Live events go through Postgres (NOTIFY / LISTEN) so every API instance, not just the one that
   * handled the request, can push them to its connected browsers. If the listener is down, events
   * are delivered to this instance's own streams only (what a single instance always did).
   */
  onModuleInit(): void {
    void this.listen();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listening = false;
    const client = this.listener;
    this.listener = null;
    await client?.end().catch(() => undefined);
  }

  private async listen(): Promise<void> {
    if (this.stopping) return;
    const client = new Client({ connectionString: databaseUrl() });
    client.on('notification', (msg) => {
      if (msg.channel !== LIVE_CHANNEL || !msg.payload) return;
      try {
        this.bus.next(JSON.parse(msg.payload) as PublishedEvent);
      } catch {
        /* a payload we did not write: ignore */
      }
    });
    const lost = (reason: string) => {
      if (this.listener !== client) return;
      this.listener = null;
      this.listening = false;
      client.removeAllListeners();
      void client.end().catch(() => undefined);
      if (this.stopping) return;
      this.log.warn(`Live event listener lost (${reason}); retrying in ${Math.round(this.reconnectDelay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => void this.listen(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    };
    client.on('error', (e) => lost(e.message));
    client.on('end', () => lost('connection closed'));
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      if (this.stopping) return void (await client.end());
      this.listener = client;
      this.listening = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
    } catch (e) {
      this.listener = client;
      lost(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Append a DomainEvent AND broadcast a LiveEvent for the subject
   * (`<x>.created` → created, `<x>.deleted` → deleted, anything else → updated).
   * Use `live: false` to only persist, or a custom LiveEvent shape.
   */
  async record(
    input: RecordEventInput,
    live: false | Pick<LiveEvent, 'type' | 'entity' | 'id'> = {
      type: input.type.endsWith('.created')
        ? 'created'
        : input.type.endsWith('.deleted')
          ? 'deleted'
          : 'updated',
      entity: input.subject.type,
      id: input.subject.id,
    },
  ): Promise<DomainEventEntity> {
    const repo = input.manager ? input.manager.getRepository(DomainEventEntity) : this.repo;
    const row = repo.create({
      id: uid('ev'),
      workspaceId: input.workspaceId,
      at: input.at ?? new Date(),
      actor: input.actor,
      type: input.type,
      subject: input.subject,
      workstreamId: input.workstreamId ?? null,
      data: input.data ?? {},
    });
    await repo.save(row);
    if (!input.at) this.recorded.next(row);
    if (live) this.publish(input.workspaceId, live);
    return row;
  }

  /** Broadcast a LiveEvent to SSE subscribers of the workspace (clientId added automatically). */
  publish(workspaceId: string, event: Pick<LiveEvent, 'type' | 'entity' | 'id'>, userId?: string): void {
    const published: PublishedEvent = {
      workspaceId,
      userId,
      event: {
        ...event,
        clientId: requestStore.getStore()?.clientId,
        at: new Date().toISOString(),
      },
    };
    if (!this.listening) {
      this.bus.next(published);
      return;
    }
    // The NOTIFY comes back through our own listener, so this instance's streams get it exactly once.
    this.repo.query('SELECT pg_notify($1, $2)', [LIVE_CHANNEL, JSON.stringify(published)]).catch((e: unknown) => {
      this.log.warn(`Could not relay a live event: ${e instanceof Error ? e.message : String(e)}`);
      this.bus.next(published);
    });
  }
}
