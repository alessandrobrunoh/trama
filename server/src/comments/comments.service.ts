import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { hasRole, type WorkspaceContext } from '../auth/request-context.js';
import type { SubjectRef } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { CommentEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

@Injectable()
export class CommentsService {
  constructor(
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(CommentEntity) private readonly repo: Repository<CommentEntity>,
  ) {}

  list(workspaceId: string, f: { subjectType?: string; subjectId?: string } = {}) {
    const qb = this.repo.createQueryBuilder('c').where('c.workspaceId = :workspaceId', { workspaceId }).orderBy('c.createdAt', 'ASC');
    if (f.subjectId) qb.andWhere("c.subject->>'id' = :sid", { sid: f.subjectId });
    if (f.subjectType) qb.andWhere("c.subject->>'type' = :st", { st: f.subjectType });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Comment', id);
    return row;
  }

  async create(ctx: WorkspaceContext, subject: SubjectRef, body: string) {
    const resolved = await this.refs.resolveSubject(ctx.workspace.id, subject);
    if (!resolved.exists) throw new BadRequestException(`Unknown ${subject.type} "${subject.id}"`);
    const row = await this.repo.save(
      this.repo.create({ id: uid('cm'), workspaceId: ctx.workspace.id, subject, author: ctx.actor, body: body.trim() }),
    );
    await this.events.record(
      {
        workspaceId: ctx.workspace.id,
        actor: ctx.actor,
        type: 'comment.created',
        subject,
        workstreamId: resolved.workstreamId,
        data: { commentId: row.id, excerpt: row.body.slice(0, 200) },
      },
      { type: 'created', entity: 'comment', id: row.id },
    );
    if (resolved.workstreamId) await this.bus.touch(ctx.workspace.id, resolved.workstreamId, 'comment.created');
    return row;
  }

  async update(ctx: WorkspaceContext, id: string, body: string) {
    const row = await this.get(ctx.workspace.id, id);
    if (row.author.type !== ctx.actor.type || row.author.id !== ctx.actor.id)
      throw new ForbiddenException('Only the author can edit a comment');
    row.body = body.trim();
    row.updatedAt = new Date();
    await this.repo.save(row);
    this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'comment', id });
    return row;
  }

  async remove(ctx: WorkspaceContext, id: string) {
    const row = await this.get(ctx.workspace.id, id);
    const own = row.author.type === ctx.actor.type && row.author.id === ctx.actor.id;
    if (!own && !hasRole(ctx.role, 'admin')) throw new ForbiddenException('Only the author or an admin can delete a comment');
    await this.repo.delete({ id });
    this.events.publish(ctx.workspace.id, { type: 'deleted', entity: 'comment', id });
  }
}
