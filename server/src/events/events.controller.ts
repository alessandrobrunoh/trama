import {
  BadRequestException,
  Controller,
  Get,
  MessageEvent,
  Query,
  Sse,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Observable, filter, interval, map, merge, mergeMap } from 'rxjs';
import type { Repository } from 'typeorm';
import { Auth, Ctx, type AuthInfo, type WorkspaceContext } from '../auth/request-context.js';
import { DomainEventEntity } from '../database/entities/index.js';
import { EventVisibilityService } from './event-visibility.service.js';
import { EventsService } from './events.service.js';
import { StreamAuthService, closeWhenInvalid, streamRecheckMs } from './stream-auth.js';

class ListEventsQuery {
  /** Filter legacy history by its former Workstream key; this is not a live resource lookup. */
  @IsOptional() @IsString() legacyWorkstreamKey?: string;
  /** `<type>:<id>`, e.g. `execution:ex_abc`. */
  @IsOptional() @IsString() subject?: string;
  /** Event type or prefix, e.g. `execution.` */
  @IsOptional() @IsString() type?: string;
  /** ISO timestamp: only events strictly older than this. */
  @IsOptional() @IsString() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Controller('w/:slug/events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly visibility: EventVisibilityService,
    private readonly streamAuth: StreamAuthService,
    @InjectRepository(DomainEventEntity)
    private readonly repo: Repository<DomainEventEntity>,
  ) {}

  @Get()
  async list(@Ctx() ctx: WorkspaceContext, @Query() q: ListEventsQuery) {
    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.workspaceId = :ws', { ws: ctx.workspace.id })
      .orderBy('e.at', 'DESC')
      .addOrderBy('e.id', 'DESC')
      .limit(q.limit ?? 100);
    if (q.legacyWorkstreamKey)
      qb.andWhere('e.legacyWorkstreamKey = :legacyKey', { legacyKey: q.legacyWorkstreamKey });
    if (q.subject) {
      const [type, id] = q.subject.split(':');
      if (!type || !id) throw new BadRequestException('subject must be "<type>:<id>"');
      qb.andWhere("e.subject->>'type' = :st AND e.subject->>'id' = :sid", { st: type, sid: id });
    }
    if (q.type) qb.andWhere('e.type LIKE :type', { type: `${q.type.replace(/[%_]/g, '')}%` });
    if (q.before) {
      const before = new Date(q.before);
      if (Number.isNaN(before.getTime())) throw new BadRequestException('before must be an ISO date');
      qb.andWhere('e.at < :before', { before });
    }
    const rows = await qb.getMany();
    return this.visibility.filterEvents(ctx.workspace.id, rows, ctx.access);
  }

  /**
   * Server-Sent Events: one visible LiveEvent JSON per message, a ping comment every 25s. The
   * stream ends when credentials, role, or project access change.
   */
  @Sse('stream')
  stream(@Ctx() ctx: WorkspaceContext, @Auth() auth: AuthInfo): Observable<MessageEvent> {
    const live$ = this.events.stream$.pipe(
      filter((e) => e.workspaceId === ctx.workspace.id && (!e.userId || e.userId === ctx.userId)),
      mergeMap(async (published) => ({
        published,
        visible: await this.visibility.isLiveVisible(
          ctx.workspace.id,
          published.event,
          ctx.access,
          published.subject,
        ),
      }), 8),
      filter(({ visible }) => visible),
      map(({ published }): MessageEvent => ({ data: published.event })),
    );
    const ping$ = interval(25_000).pipe(
      map((): MessageEvent => ({ type: 'ping', data: { at: new Date().toISOString() } })),
    );
    return merge(live$, ping$).pipe(
      closeWhenInvalid(() => this.streamAuth.isStillValid(auth, ctx), streamRecheckMs()),
    );
  }
}
