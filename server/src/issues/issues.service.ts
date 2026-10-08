import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import {
  ISSUE_KEY_PREFIX,
  type ActorRef,
  type IssueKind,
  type IssueSource,
  type IssueStatus,
  type Priority,
} from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { IssueEntity, MilestoneEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import {
  WorkstreamsService,
  type WorkstreamInput,
} from '../workstreams/workstreams.service.js';

export interface IssueInput {
  title?: string;
  /** Changing it re-keys the issue and keeps the old key as an alias. */
  kind?: IssueKind;
  estimate?: number | null;
  body?: string | null;
  source?: IssueSource;
  reporterName?: string | null;
  assigneeId?: string | null;
  teamId?: string | null;
  priority?: Priority;
  status?: IssueStatus;
  externalUrl?: string | null;
  workstreamIds?: string[];
  milestoneIds?: string[];
  /** Id or key. `null` clears the relation. Setting it cancels the issue. */
  duplicateOfId?: string | null;
}

export interface LinkIssueInput {
  workstreamIds?: string[];
  createWorkstream?: WorkstreamInput & {
    title: string;
    ownerTeamId: string;
    deltaThreadUrl: string;
  };
  /** Defaults to `in_progress` when the issue is still `backlog` or `todo`. */
  status?: IssueStatus;
}

const KEY_RE = /^[A-Za-z]+-\d+$/;
const SCHEDULED: ReadonlySet<IssueStatus> = new Set([
  'draft',
  'backlog',
  'todo',
]);
const STARTED: ReadonlySet<IssueStatus> = new Set(['in_progress', 'in_review']);
const FINISHED: ReadonlySet<IssueStatus> = new Set(['done', 'canceled']);

/**
 * Time-tracking facts follow the status: `startedAt` is set the first time the issue enters
 * in_progress / in_review (and kept afterwards); `completedAt` is set when it becomes done or
 * canceled and cleared when it is reopened.
 */
export function applyStatusFacts(
  row: Pick<IssueEntity, 'startedAt' | 'completedAt'>,
  to: IssueStatus,
  now = new Date(),
) {
  if (STARTED.has(to) && !row.startedAt) row.startedAt = now;
  if (FINISHED.has(to)) row.completedAt ??= now;
  else row.completedAt = null;
}

@Injectable()
export class IssuesService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly counters: CountersService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    private readonly workstreams: WorkstreamsService,
    @InjectRepository(IssueEntity)
    private readonly repo: Repository<IssueEntity>,
  ) {}

  list(
    workspaceId: string,
    f: {
      kind?: IssueKind;
      status?: IssueStatus;
      teamId?: string;
      assigneeId?: string;
      workstreamId?: string;
      milestoneId?: string;
      q?: string;
    } = {},
  ) {
    const qb = this.repo
      .createQueryBuilder('i')
      .where('i.workspaceId = :workspaceId', { workspaceId })
      .orderBy('i.createdAt', 'DESC');
    if (f.kind) qb.andWhere('i.kind = :k', { k: f.kind });
    if (f.status) qb.andWhere('i.status = :s', { s: f.status });
    if (f.teamId) qb.andWhere('i.teamId = :t', { t: f.teamId });
    if (f.assigneeId) qb.andWhere('i.assigneeId = :a', { a: f.assigneeId });
    if (f.workstreamId)
      qb.andWhere('i.workstreamIds @> :w::jsonb', {
        w: JSON.stringify([f.workstreamId]),
      });
    if (f.milestoneId)
      qb.andWhere('i.milestoneIds @> :m::jsonb', {
        m: JSON.stringify([f.milestoneId]),
      });
    if (f.q)
      qb.andWhere(
        '(i.title ILIKE :q OR i.key ILIKE :q OR i.aliases::text ILIKE :q)',
        { q: `%${f.q}%` },
      );
    return qb.getMany();
  }

  /** `idOrKey`: id (`in_…`), key (`BUG-142`) or an alias (an old key from before a kind change). */
  async get(workspaceId: string, idOrKey: string) {
    let row: IssueEntity | null;
    if (KEY_RE.test(idOrKey)) {
      const key = idOrKey.toUpperCase();
      row =
        (await this.repo.findOneBy({ workspaceId, key })) ??
        (await this.repo
          .createQueryBuilder('i')
          .where('i.workspaceId = :workspaceId', { workspaceId })
          .andWhere('i.aliases @> :a::jsonb', { a: JSON.stringify([key]) })
          .getOne());
    } else {
      row = await this.repo.findOneBy({ workspaceId, id: idOrKey });
    }
    if (!row) throw notFound('Issue', idOrKey);
    return row;
  }

  /**
   * Milestones must exist, belong to a workstream the issue is linked to, and an issue may be in
   * at most one milestone per workstream.
   */
  private async assertMilestones(
    workspaceId: string,
    milestoneIds: readonly string[],
    workstreamIds: readonly string[],
  ) {
    if (!milestoneIds.length) return;
    const rows = await this.ds
      .getRepository(MilestoneEntity)
      .findBy({ workspaceId, id: In(milestoneIds) });
    if (rows.length !== milestoneIds.length)
      throw new BadRequestException(
        `Unknown milestone in: ${milestoneIds.join(', ')}`,
      );
    const seen = new Set<string>();
    for (const m of rows) {
      if (!workstreamIds.includes(m.workstreamId))
        throw new BadRequestException(
          `Milestone "${m.name}" belongs to a workstream this issue is not linked to`,
        );
      if (seen.has(m.workstreamId))
        throw new BadRequestException(
          'An issue can be in at most one milestone per workstream',
        );
      seen.add(m.workstreamId);
    }
  }

  async create(
    workspaceId: string,
    actor: ActorRef,
    input: IssueInput & { kind: IssueKind; title: string },
  ) {
    await this.refs.teams(
      workspaceId,
      [input.teamId].filter((x): x is string => !!x),
    );
    await this.refs.users(workspaceId, [input.assigneeId]);
    const status = input.status ?? 'backlog';
    const facts: Pick<IssueEntity, 'startedAt' | 'completedAt'> = {
      startedAt: null,
      completedAt: null,
    };
    applyStatusFacts(facts, status);
    const row = await this.ds.transaction(async (m) => {
      const number = await this.counters.next(
        m,
        workspaceId,
        `issue:${input.kind}`,
      );
      return m.save(
        m.create(IssueEntity, {
          id: uid('in'),
          workspaceId,
          key: `${ISSUE_KEY_PREFIX[input.kind]}-${number}`,
          number,
          kind: input.kind,
          title: input.title.trim(),
          body: input.body ?? null,
          source: input.source ?? (actor.type === 'agent' ? 'agent' : 'manual'),
          reporterName: input.reporterName ?? null,
          reporterId: actor.type === 'user' ? (actor.id ?? null) : null,
          assigneeId: input.assigneeId ?? null,
          teamId: input.teamId ?? null,
          priority: input.priority ?? 'none',
          status,
          estimate: input.estimate ?? null,
          startedAt: facts.startedAt,
          completedAt: facts.completedAt,
          externalUrl: input.externalUrl ?? null,
        }),
      );
    });
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.created',
      subject: { type: 'issue', id: row.id },
      data: {
        key: row.key,
        kind: row.kind,
        title: row.title,
        status: row.status,
      },
    });
    return row;
  }

  async update(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    patch: IssueInput,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    await this.refs.teams(
      workspaceId,
      [patch.teamId].filter((x): x is string => !!x),
    );
    await this.refs.users(workspaceId, [patch.assigneeId]);
    await this.refs.workstreams(workspaceId, patch.workstreamIds);
    const before = new Set(row.workstreamIds);
    const from = row.status;
    const fromKey = row.key;
    const fromKind = row.kind;

    let duplicateOfId = row.duplicateOfId;
    if (patch.duplicateOfId !== undefined) {
      if (patch.duplicateOfId === null) {
        duplicateOfId = null;
      } else {
        if (patch.status !== undefined && patch.status !== 'canceled')
          throw new BadRequestException(
            'Marking an issue as a duplicate sets its status to "canceled"',
          );
        if (patch.workstreamIds?.length)
          throw new BadRequestException(
            'Cannot link workstreams when marking an issue as a duplicate',
          );
        const target = await this.get(workspaceId, patch.duplicateOfId);
        if (target.id === row.id)
          throw new BadRequestException('An issue cannot duplicate itself');
        duplicateOfId = target.id;
        patch = { ...patch, status: 'canceled' };
      }
    }

    const nextWorkstreamIds =
      patch.workstreamIds !== undefined
        ? unique(patch.workstreamIds)
        : row.workstreamIds;
    let nextMilestoneIds =
      patch.milestoneIds !== undefined
        ? unique(patch.milestoneIds)
        : row.milestoneIds;
    if (patch.milestoneIds !== undefined) {
      await this.assertMilestones(
        workspaceId,
        nextMilestoneIds,
        nextWorkstreamIds,
      );
    } else if (patch.workstreamIds !== undefined && row.milestoneIds.length) {
      // Unlinking a workstream drops that workstream's milestone.
      const kept = new Set(
        (
          await this.ds
            .getRepository(MilestoneEntity)
            .findBy({ workspaceId, id: In(row.milestoneIds) })
        )
          .filter((m) => nextWorkstreamIds.includes(m.workstreamId))
          .map((m) => m.id),
      );
      nextMilestoneIds = row.milestoneIds.filter((id) => kept.has(id));
    }
    row.milestoneIds = nextMilestoneIds;

    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.estimate !== undefined) row.estimate = patch.estimate;
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.reporterName !== undefined) row.reporterName = patch.reporterName;
    if (patch.assigneeId !== undefined) row.assigneeId = patch.assigneeId;
    if (patch.teamId !== undefined) row.teamId = patch.teamId;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.externalUrl !== undefined) row.externalUrl = patch.externalUrl;
    if (patch.workstreamIds !== undefined)
      row.workstreamIds = unique(patch.workstreamIds);
    if (patch.status !== undefined) {
      row.status = patch.status;
      if (row.status !== from) applyStatusFacts(row, row.status);
    }
    row.duplicateOfId = duplicateOfId;
    row.updatedAt = new Date();
    const rekey = patch.kind !== undefined && patch.kind !== fromKind;
    await this.ds.transaction(async (m) => {
      if (rekey) {
        // The key prefix follows the kind: take the next number of the new kind, keep the old key as an alias.
        const number = await this.counters.next(
          m,
          workspaceId,
          `issue:${patch.kind}`,
        );
        row.aliases = unique([...row.aliases, fromKey]);
        row.kind = patch.kind!;
        row.number = number;
        row.key = `${ISSUE_KEY_PREFIX[row.kind]}-${number}`;
      }
      await m.save(row);
    });

    const fields = Object.keys(patch)
      .filter((k) => (patch as Record<string, unknown>)[k] !== undefined)
      .filter((k) => k !== 'status' && k !== 'kind');
    if (rekey)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.rekeyed',
        subject: { type: 'issue', id: row.id },
        data: {
          key: row.key,
          from: fromKey,
          to: row.key,
          fromKind,
          toKind: row.kind,
        },
      });
    if (fields.length)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.updated',
        subject: { type: 'issue', id: row.id },
        data: { key: row.key, fields },
      });
    if (patch.status !== undefined && patch.status !== from)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.status_changed',
        subject: { type: 'issue', id: row.id },
        workstreamId: row.workstreamIds[0] ?? null,
        data: { key: row.key, from, to: row.status },
      });
    const touched = new Set([...before, ...row.workstreamIds]);
    await this.bus.touchMany(workspaceId, touched, 'issue.updated');
    return row;
  }

  /**
   * Attach the issue to existing workstreams and/or a newly created one (`createWorkstream`,
   * created atomically). Backlog and todo issues move to `in_progress` unless `status` is set.
   */
  async link(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    input: LinkIssueInput,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    if (row.duplicateOfId)
      throw new BadRequestException(
        'A duplicate issue cannot be linked to a workstream',
      );
    if (!input.createWorkstream && !input.workstreamIds?.length)
      throw new BadRequestException(
        'workstreamIds or createWorkstream is required',
      );
    if (input.status === 'canceled')
      throw new BadRequestException(
        'Cancel the issue with PATCH instead of linking it',
      );
    await this.refs.workstreams(workspaceId, input.workstreamIds);

    let created: Awaited<ReturnType<WorkstreamsService['create']>> | undefined;
    const previous = row.workstreamIds;
    const from = row.status;
    await this.ds.transaction(async (m) => {
      const ids = unique([
        ...(row.workstreamIds ?? []),
        ...(input.workstreamIds ?? []),
      ]);
      if (input.createWorkstream) {
        created = await this.workstreams.create(
          workspaceId,
          actor,
          input.createWorkstream,
          {
            manager: m,
            data: { fromIssue: row.key },
          },
        );
        ids.push(created.id);
      }
      row.workstreamIds = ids;
      row.status =
        input.status ??
        (SCHEDULED.has(row.status) ? 'in_progress' : row.status);
      if (row.status !== from) applyStatusFacts(row, row.status);
      row.updatedAt = new Date();
      await m.save(row);
    });
    if (created) await created.after?.();
    const targets = row.workstreamIds.length ? row.workstreamIds : [null];
    for (const workstreamId of targets)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.linked',
        subject: { type: 'issue', id: row.id },
        workstreamId,
        data: {
          key: row.key,
          workstreamIds: row.workstreamIds,
          createdWorkstreamId: created?.id,
        },
      });
    if (row.status !== from)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.status_changed',
        subject: { type: 'issue', id: row.id },
        workstreamId: row.workstreamIds[0] ?? null,
        data: { key: row.key, from, to: row.status },
      });
    await this.bus.touchMany(
      workspaceId,
      [...previous, ...row.workstreamIds],
      'issue.linked',
    );
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const row = await this.get(workspaceId, idOrKey);
    await this.ds.query(
      `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`,
      [workspaceId, row.id],
    );
    await this.ds.query(
      `UPDATE "issues" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = $2`,
      [workspaceId, row.id],
    );
    await this.repo.delete({ id: row.id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.deleted',
      subject: { type: 'issue', id: row.id },
      data: { key: row.key, title: row.title },
    });
    await this.bus.touchMany(workspaceId, row.workstreamIds, 'issue.deleted');
  }
}
