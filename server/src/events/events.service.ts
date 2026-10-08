import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import type { EntityManager, Repository } from 'typeorm';
import type {
  ActorRef,
  LiveEvent,
  SubjectRef,
} from '../contracts/domain.js';
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
}

@Injectable()
export class EventsService {
  private readonly bus = new Subject<PublishedEvent>();
  /** All live events of all workspaces; filter by `workspaceId`. */
  readonly stream$ = this.bus.asObservable();

  private readonly recorded = new Subject<DomainEventEntity>();
  /** Every DomainEvent right after it was persisted (not backdated seed events). Used by outgoing webhooks. */
  readonly recorded$ = this.recorded.asObservable();

  constructor(
    @InjectRepository(DomainEventEntity)
    private readonly repo: Repository<DomainEventEntity>,
  ) {}

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
  publish(workspaceId: string, event: Pick<LiveEvent, 'type' | 'entity' | 'id'>): void {
    this.bus.next({
      workspaceId,
      event: {
        ...event,
        clientId: requestStore.getStore()?.clientId,
        at: new Date().toISOString(),
      },
    });
  }
}
