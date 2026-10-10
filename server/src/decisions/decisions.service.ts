import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, DecisionStatus } from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { applyWorkstreamScope } from '../auth/member-access.js';
import { DecisionEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

export interface DecisionInput {
  title?: string;
  statement?: string;
  rationale?: string | null;
  status?: DecisionStatus;
  originWorkstreamId?: string | null;
  relatedWorkstreamIds?: string[];
  tags?: string[];
}

const KEY_RE = /^ADR-\d+$/i;

@Injectable()
export class DecisionsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly counters: CountersService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(DecisionEntity)
    private readonly repo: Repository<DecisionEntity>,
  ) {}

  list(
    workspaceId: string,
    f: {
      status?: DecisionStatus;
      workstreamId?: string;
      tag?: string;
      q?: string;
    } = {},
  ) {
    const qb = this.repo
      .createQueryBuilder('d')
      .where('d.workspaceId = :workspaceId', { workspaceId })
      .orderBy('d.number', 'DESC');
    if (f.status) qb.andWhere('d.status = :s', { s: f.status });
    if (f.workstreamId)
      qb.andWhere(
        '(d.originWorkstreamId = :w OR d.relatedWorkstreamIds @> :wj::jsonb)',
        { w: f.workstreamId, wj: JSON.stringify([f.workstreamId]) },
      );
    if (f.tag)
      qb.andWhere('d.tags @> :tag::jsonb', { tag: JSON.stringify([f.tag]) });
    if (f.q)
      qb.andWhere(
        '(d.title ILIKE :q OR d.statement ILIKE :q OR d.key ILIKE :q)',
        { q: `%${f.q}%` },
      );
    applyWorkstreamScope(qb, 'd', 'originWorkstreamId');
    return qb.getMany();
  }

  /** `idOrKey`: id (`dc_…`) or key (`ADR-21`). */
  async get(workspaceId: string, idOrKey: string) {
    const row = await this.repo.findOneBy(
      KEY_RE.test(idOrKey)
        ? { workspaceId, key: idOrKey.toUpperCase() }
        : { workspaceId, id: idOrKey },
    );
    if (!row) throw notFound('Decision', idOrKey);
    return row;
  }

  private touched(row: DecisionEntity): string[] {
    return unique(
      [row.originWorkstreamId, ...row.relatedWorkstreamIds].filter(
        (x): x is string => !!x,
      ),
    );
  }

  private async validate(workspaceId: string, input: DecisionInput) {
    await this.refs.workstreams(workspaceId, [
      ...(input.relatedWorkstreamIds ?? []),
      ...(input.originWorkstreamId ? [input.originWorkstreamId] : []),
    ]);
  }

  private requireHuman(actor: ActorRef): string {
    if (actor.type !== 'user' || !actor.id)
      throw new ForbiddenException(
        'Decisions must be accepted or rejected by a person',
      );
    return actor.id;
  }

  async create(
    workspaceId: string,
    actor: ActorRef,
    input: DecisionInput & { title: string; statement?: string },
  ) {
    await this.validate(workspaceId, input);
    const status = input.status ?? 'proposed';
    if (status === 'superseded')
      throw new BadRequestException('Use /supersede to supersede a decision');
    const decidedById =
      status === 'accepted' || status === 'rejected'
        ? this.requireHuman(actor)
        : null;
    const row = await this.ds.transaction(async (m) => {
      const number = await this.counters.next(m, workspaceId, 'adr');
      return m.save(
        m.create(DecisionEntity, {
          id: uid('dc'),
          workspaceId,
          key: `ADR-${number}`,
          number,
          title: input.title.trim(),
          statement: input.statement ?? '',
          rationale: input.rationale ?? null,
          status,
          originWorkstreamId: input.originWorkstreamId ?? null,
          relatedWorkstreamIds: unique(input.relatedWorkstreamIds),
          proposedBy: actor,
          decidedById,
          decidedAt: decidedById ? new Date() : null,
          tags: unique(input.tags),
        }),
      );
    });
    await this.record(
      row,
      actor,
      status === 'draft'
        ? 'decision.draft'
        : status === 'proposed'
          ? 'decision.proposed'
          : `decision.${status}`,
      { title: row.title },
    );
    await this.bus.touchMany(
      workspaceId,
      this.touched(row),
      'decision.created',
    );
    return row;
  }

  private record(
    row: DecisionEntity,
    actor: ActorRef,
    type: string,
    data: Record<string, unknown> = {},
  ) {
    return this.events.record({
      workspaceId: row.workspaceId,
      actor,
      type,
      subject: { type: 'decision', id: row.id },
      workstreamId: row.originWorkstreamId,
      data: { key: row.key, ...data },
    });
  }

  async update(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    patch: DecisionInput,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    if (patch.status !== undefined) {
      if (
        row.status !== 'draft' ||
        patch.status !== 'proposed' ||
        !(patch.statement ?? row.statement).trim()
      )
        throw new BadRequestException(
          'Only a complete draft decision can be proposed',
        );
      row.status = 'proposed';
    }
    await this.validate(workspaceId, patch);
    const before = this.touched(row);
    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.statement !== undefined) row.statement = patch.statement;
    if (patch.rationale !== undefined) row.rationale = patch.rationale;
    if (patch.originWorkstreamId !== undefined)
      row.originWorkstreamId = patch.originWorkstreamId;
    if (patch.relatedWorkstreamIds !== undefined)
      row.relatedWorkstreamIds = unique(patch.relatedWorkstreamIds);
    if (patch.tags !== undefined) row.tags = unique(patch.tags);
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.record(
      row,
      actor,
      patch.status === 'proposed' ? 'decision.proposed' : 'decision.updated',
      {
        fields: Object.keys(patch).filter(
          (k) => (patch as Record<string, unknown>)[k] !== undefined,
        ),
      },
    );
    await this.bus.touchMany(
      workspaceId,
      [...before, ...this.touched(row)],
      'decision.updated',
    );
    return row;
  }

  async accept(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const userId = this.requireHuman(actor);
    const row = await this.get(workspaceId, idOrKey);
    if (row.status !== 'proposed')
      throw new ConflictException(
        `Decision is ${row.status}, only proposed decisions can be accepted`,
      );
    row.status = 'accepted';
    row.decidedById = userId;
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.record(row, actor, 'decision.accepted', { title: row.title });
    await this.bus.touchMany(
      workspaceId,
      this.touched(row),
      'decision.accepted',
    );
    return row;
  }

  async reject(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const userId = this.requireHuman(actor);
    const row = await this.get(workspaceId, idOrKey);
    if (row.status !== 'proposed')
      throw new ConflictException(
        `Decision is ${row.status}, only proposed decisions can be rejected`,
      );
    row.status = 'rejected';
    row.decidedById = userId;
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.record(row, actor, 'decision.rejected', { title: row.title });
    await this.bus.touchMany(
      workspaceId,
      this.touched(row),
      'decision.rejected',
    );
    return row;
  }

  /** Marks this decision superseded by another (`byId`: id or key of an accepted/proposed decision). */
  async supersede(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    byId: string,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    const by = await this.get(workspaceId, byId);
    if (by.id === row.id)
      throw new BadRequestException('A decision cannot supersede itself');
    if (row.status !== 'accepted' && row.status !== 'proposed')
      throw new ConflictException(
        `Decision is ${row.status} and cannot be superseded`,
      );
    if (by.status === 'superseded' || by.status === 'rejected')
      throw new ConflictException(
        `Decision ${by.key} is ${by.status} and cannot supersede another`,
      );
    for (
      let cursor: DecisionEntity | null = by, i = 0;
      cursor?.supersededById && i < 100;
      i++
    ) {
      if (cursor.supersededById === row.id)
        throw new ConflictException('This would create a supersede cycle');
      cursor = await this.repo.findOneBy({
        id: cursor.supersededById,
        workspaceId,
      });
    }
    row.status = 'superseded';
    row.supersededById = by.id;
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.record(row, actor, 'decision.superseded', {
      title: row.title,
      supersededBy: by.key,
    });
    await this.bus.touchMany(
      workspaceId,
      [...this.touched(row), ...this.touched(by)],
      'decision.superseded',
    );
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const row = await this.get(workspaceId, idOrKey);
    await this.ds.transaction(async (m) => {
      await m.query(
        `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`,
        [workspaceId, row.id],
      );
      await m.query(
        `UPDATE "decisions" SET "supersededById" = NULL WHERE "workspaceId" = $1 AND "supersededById" = $2`,
        [workspaceId, row.id],
      );
      await m.delete(DecisionEntity, { id: row.id });
    });
    await this.record(row, actor, 'decision.deleted', { title: row.title });
    await this.bus.touchMany(
      workspaceId,
      this.touched(row),
      'decision.deleted',
    );
  }
}
