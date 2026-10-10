import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { hasRole, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, CommentIndexEntry, CommentPage, SubjectRef, SubjectType } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { currentAccess, projectHidden } from '../auth/member-access.js';
import { CommentEntity, IssueEntity, MilestoneEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { decodeCommentCursor, encodeCommentCursor, parseCommentLimit } from './comment-cursor.js';

@Injectable()
export class CommentsService {
  constructor(
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(CommentEntity) private readonly repo: Repository<CommentEntity>,
  ) {}

  async list(workspaceId: string, f: { subjectType?: string; subjectId?: string } = {}) {
    if (currentAccess()) {
      if (!f.subjectType || !f.subjectId) throw new ForbiddenException('List comments for one subject you can access');
      await this.assertSubjectVisible(workspaceId, f.subjectType, f.subjectId);
    }
    const qb = this.repo.createQueryBuilder('c').where('c.workspaceId = :workspaceId', { workspaceId }).orderBy('c.createdAt', 'ASC');
    if (f.subjectId) qb.andWhere("c.subject->>'id' = :sid", { sid: f.subjectId });
    if (f.subjectType) qb.andWhere("c.subject->>'type' = :st", { st: f.subjectType });
    return qb.getMany();
  }

  /** Every comment of the workspace, oldest first (the default snapshot). */
  listAll(workspaceId: string) {
    return this.repo.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
  }

  /**
   * One page of the comments of a single subject, newest first, keyset-paginated on (createdAt, id).
   * Always scoped to the workspace *and* the subject. `createdAt` is compared at millisecond precision
   * (the precision of the cursor) so rows written with the database `now()` default are never skipped.
   */
  async page(
    workspaceId: string,
    f: { subjectType: SubjectType; subjectId: string; limit?: number; cursor?: string },
  ): Promise<{ items: CommentEntity[]; nextCursor: CommentPage['nextCursor'] }> {
    await this.assertSubjectVisible(workspaceId, f.subjectType, f.subjectId);
    const limit = parseCommentLimit(f.limit);
    const rows = await this.pageQuery(workspaceId, f, limit).getMany();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCommentCursor({ at: last.createdAt, id: last.id }) : null;
    return { items, nextCursor };
  }

  /** The page query (fetches `limit + 1` rows to learn whether another page exists). Exposed for tests. */
  pageQuery(workspaceId: string, f: { subjectType: SubjectType; subjectId: string; cursor?: string }, limit: number) {
    const cursor = f.cursor ? decodeCommentCursor(f.cursor) : undefined;
    const ts = "date_trunc('milliseconds', c.createdAt)";
    const qb = this.repo
      .createQueryBuilder('c')
      .addSelect(ts, 'c_ts')
      .where('c.workspaceId = :workspaceId', { workspaceId })
      .andWhere("c.subject->>'type' = :st", { st: f.subjectType })
      .andWhere("c.subject->>'id' = :sid", { sid: f.subjectId })
      .orderBy('c_ts', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .limit(limit + 1);
    if (cursor) qb.andWhere(`(${ts} < :cat OR (${ts} = :cat AND c.id < :cid))`, { cat: cursor.at, cid: cursor.id });
    return qb;
  }

  /** Per (subject, author) comment counts of the whole workspace: the slim snapshot's stand-in for the comments. */
  async index(workspaceId: string): Promise<CommentIndexEntry[]> {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select("c.subject->>'type'", 'st')
      .addSelect("c.subject->>'id'", 'sid')
      .addSelect("c.author->>'type'", 'at')
      .addSelect("c.author->>'id'", 'aid')
      .addSelect('COUNT(*)', 'n')
      .where('c.workspaceId = :workspaceId', { workspaceId })
      .groupBy("c.subject->>'type'")
      .addGroupBy("c.subject->>'id'")
      .addGroupBy("c.author->>'type'")
      .addGroupBy("c.author->>'id'")
      .getRawMany<{ st: SubjectType; sid: string; at: ActorRef['type']; aid: string | null; n: string }>();
    return rows.map((r) => ({
      subject: { type: r.st, id: r.sid },
      author: r.aid ? { type: r.at, id: r.aid } : { type: r.at },
      count: Number(r.n),
    }));
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Comment', id);
    await this.assertSubjectVisible(workspaceId, row.subject.type, row.subject.id);
    return row;
  }

  async create(ctx: WorkspaceContext, subject: SubjectRef, body: string) {
    await this.assertSubjectVisible(ctx.workspace.id, subject.type, subject.id);
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

  /** A limited person can only read or write comments on work they are allowed to see. */
  private async assertSubjectVisible(workspaceId: string, type: string, id: string): Promise<void> {
    if (!currentAccess()) return;
    if (type === 'project') {
      if (projectHidden(currentAccess(), id)) throw notFound('Project', id);
      return;
    }
    const entity = type === 'issue' ? IssueEntity : type === 'workstream' ? WorkstreamEntity : type === 'milestone' ? MilestoneEntity : null;
    if (!entity) return;
    const row = await this.repo.manager.getRepository(entity).findOne({ where: { workspaceId, id }, select: { id: true, projectId: true } });
    if (!row || projectHidden(currentAccess(), row.projectId)) throw notFound(type, id);
  }
}
