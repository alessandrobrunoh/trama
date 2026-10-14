import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import {
  statusTypeOf,
  type ActorRef,
  type DecisionStatus,
} from '../contracts/domain.js';
import {
  loadStatusCatalog,
  requireStatus,
  statusFilterIds,
} from '../status/status-catalog.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import {
  DecisionEntity,
  IssueEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import {
  assertCanUseProject,
  canView,
  currentAccess,
  projectHidden,
} from '../auth/member-access.js';

export interface DecisionInput {
  title?: string;
  statement?: string;
  rationale?: string | null;
  /** Catalog id, or a legacy enum (the seeded status of that type). */
  status?: string;
  originIssueId?: string | null;
  relatedIssueIds?: string[];
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
    @InjectRepository(DecisionEntity)
    private readonly repo: Repository<DecisionEntity>,
  ) {}

  private async entries(workspaceId: string) {
    return (await loadStatusCatalog(this.ds, workspaceId)).decision;
  }

  async list(
    workspaceId: string,
    f: {
      status?: string;
      issueId?: string;
      tag?: string;
      q?: string;
    } = {},
  ) {
    const qb = this.repo
      .createQueryBuilder('d')
      .where('d.workspaceId = :workspaceId', { workspaceId })
      .orderBy('d.number', 'DESC');
    if (f.status) {
      const entries = await this.entries(workspaceId);
      qb.andWhere('d.status IN (:...st)', {
        st: statusFilterIds(entries, f.status),
      });
    }
    if (f.issueId)
      qb.andWhere('(d.originIssueId = :i OR d.relatedIssueIds @> :ij::jsonb)', {
        i: f.issueId,
        ij: JSON.stringify([f.issueId]),
      });
    if (f.tag)
      qb.andWhere('d.tags @> :tag::jsonb', { tag: JSON.stringify([f.tag]) });
    if (f.q)
      qb.andWhere(
        '(d.title ILIKE :q OR d.statement ILIKE :q OR d.key ILIKE :q)',
        { q: `%${f.q}%` },
      );
    return this.visibleRows(workspaceId, await qb.getMany());
  }

  /** `idOrKey`: id (`dc_…`) or key (`ADR-21`). */
  async get(workspaceId: string, idOrKey: string) {
    const row = await this.repo.findOneBy(
      KEY_RE.test(idOrKey)
        ? { workspaceId, key: idOrKey.toUpperCase() }
        : { workspaceId, id: idOrKey },
    );
    if (!row) throw notFound('Decision', idOrKey);
    const visible = await this.visibleRows(workspaceId, [row]);
    if (!visible.length)
      throw new ForbiddenException('Outside the issues you can access');
    return row;
  }

  /** Decisions are visible only when every linked Issue is visible to this member. */
  private async visibleRows(
    workspaceId: string,
    rows: DecisionEntity[],
  ): Promise<DecisionEntity[]> {
    const access = currentAccess();
    if (!access || !rows.length) return rows;

    const issueIds = unique(
      rows.flatMap((row) => [
        ...(row.originIssueId ? [row.originIssueId] : []),
        ...(row.relatedIssueIds ?? []),
      ]),
    );
    if (!issueIds.length) return rows;

    const issues = canView('issues', access)
      ? await this.ds
          .getRepository(IssueEntity)
          .findBy({ workspaceId, id: In(issueIds) })
      : [];
    const visibleIssueIds = new Set(
      issues
        .filter((issue) => !projectHidden(access, issue.projectId))
        .map((issue) => issue.id),
    );
    return rows.filter((row) => {
      const linkedIds = [
        ...(row.originIssueId ? [row.originIssueId] : []),
        ...(row.relatedIssueIds ?? []),
      ];
      return linkedIds.every((id) => visibleIssueIds.has(id));
    });
  }

  private async validate(workspaceId: string, input: DecisionInput) {
    const issueIds = unique([
      ...(input.relatedIssueIds ?? []),
      ...(input.originIssueId ? [input.originIssueId] : []),
    ]);
    await this.refs.issues(workspaceId, issueIds);
    const access = currentAccess();
    if (access && issueIds.length) {
      if (!canView('issues', access))
        throw new ForbiddenException('Outside the issues you can access');
      const issues = await this.ds
        .getRepository(IssueEntity)
        .findBy({ workspaceId, id: In(issueIds) });
      for (const issue of issues) assertCanUseProject(issue.projectId);
    }
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
    input: DecisionInput & {
      title: string;
      originIssueId: string;
      statement?: string;
    },
  ) {
    if (!input.originIssueId)
      throw new BadRequestException('originIssueId is required');
    await this.validate(workspaceId, input);
    const chosen = requireStatus(
      await this.entries(workspaceId),
      input.status ?? 'proposed',
      'status',
    );
    if (chosen.type === 'superseded')
      throw new BadRequestException('Use /supersede to supersede a decision');
    if (
      chosen.type !== 'draft' &&
      chosen.type !== 'proposed' &&
      chosen.type !== 'accepted' &&
      chosen.type !== 'rejected'
    )
      throw new BadRequestException(
        'A decision cannot be created with this status',
      );
    const status = chosen.id as DecisionStatus;
    const type = chosen.type;
    const decidedById =
      type === 'accepted' || type === 'rejected'
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
          originIssueId: input.originIssueId,
          relatedIssueIds: unique(input.relatedIssueIds),
          legacyWorkstreamKey: null,
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
      type === 'draft'
        ? 'decision.draft'
        : type === 'proposed'
          ? 'decision.proposed'
          : `decision.${type}`,
      { title: row.title },
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
      data: { key: row.key, originIssueId: row.originIssueId, ...data },
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
      const entries = await this.entries(workspaceId);
      const to = requireStatus(entries, patch.status, 'status');
      if (
        statusTypeOf(entries, row.status) !== 'draft' ||
        to.type !== 'proposed' ||
        !(patch.statement ?? row.statement).trim()
      )
        throw new BadRequestException(
          'Only a complete draft decision can be proposed',
        );
      row.status = to.id as DecisionStatus;
    }
    await this.validate(workspaceId, patch);
    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.statement !== undefined) row.statement = patch.statement;
    if (patch.rationale !== undefined) row.rationale = patch.rationale;
    if (patch.originIssueId !== undefined) {
      if (!patch.originIssueId)
        throw new BadRequestException('originIssueId cannot be cleared');
      row.originIssueId = patch.originIssueId;
    }
    if (patch.relatedIssueIds !== undefined)
      row.relatedIssueIds = unique(patch.relatedIssueIds);
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
    return row;
  }

  async accept(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const userId = this.requireHuman(actor);
    const row = await this.get(workspaceId, idOrKey);
    const entries = await this.entries(workspaceId);
    const current = statusTypeOf(entries, row.status) ?? row.status;
    if (current !== 'proposed')
      throw new ConflictException(
        `Decision is ${current}, only proposed decisions can be accepted`,
      );
    row.status = 'accepted';
    row.decidedById = userId;
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.record(row, actor, 'decision.accepted', { title: row.title });
    return row;
  }

  async reject(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const userId = this.requireHuman(actor);
    const row = await this.get(workspaceId, idOrKey);
    const entries = await this.entries(workspaceId);
    const current = statusTypeOf(entries, row.status) ?? row.status;
    if (current !== 'proposed')
      throw new ConflictException(
        `Decision is ${current}, only proposed decisions can be rejected`,
      );
    row.status = 'rejected';
    row.decidedById = userId;
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.record(row, actor, 'decision.rejected', { title: row.title });
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
    const entries = await this.entries(workspaceId);
    const rowType = statusTypeOf(entries, row.status) ?? row.status;
    const byType = statusTypeOf(entries, by.status) ?? by.status;
    if (rowType !== 'accepted' && rowType !== 'proposed')
      throw new ConflictException(
        `Decision is ${rowType} and cannot be superseded`,
      );
    if (byType === 'superseded' || byType === 'rejected')
      throw new ConflictException(
        `Decision ${by.key} is ${byType} and cannot supersede another`,
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
  }
}
