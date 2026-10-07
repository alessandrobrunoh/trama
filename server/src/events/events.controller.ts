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
import { Observable, filter, interval, map, merge } from 'rxjs';
import type { Repository } from 'typeorm';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { DomainEventEntity } from '../database/entities/index.js';
import { EventsService } from './events.service.js';

class ListEventsQuery {
  @IsOptional() @IsString() workstreamId?: string;
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
    @InjectRepository(DomainEventEntity)
    private readonly repo: Repository<DomainEventEntity>,
  ) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListEventsQuery) {
    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.workspaceId = :ws', { ws: ctx.workspace.id })
      .orderBy('e.at', 'DESC')
      .addOrderBy('e.id', 'DESC')
      .limit(q.limit ?? 100);
    if (q.workstreamId) qb.andWhere('e.workstreamId = :wk', { wk: q.workstreamId });
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
    return qb.getMany();
  }

  /** Server-Sent Events: one LiveEvent JSON per message, a ping comment every 25s. */
  @Sse('stream')
  stream(@Ctx() ctx: WorkspaceContext): Observable<MessageEvent> {
    const live$ = this.events.stream$.pipe(
      filter((e) => e.workspaceId === ctx.workspace.id),
      map((e): MessageEvent => ({ data: e.event })),
    );
    const ping$ = interval(25_000).pipe(
      map((): MessageEvent => ({ type: 'ping', data: { at: new Date().toISOString() } })),
    );
    return merge(live$, ping$);
  }
}
