import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
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
import { IssueEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { WorkstreamsService, type WorkstreamInput } from '../workstreams/workstreams.service.js';

export interface IssueInput {
  title?: string;
  body?: string | null;
  source?: IssueSource;
  reporterName?: string | null;
  assigneeId?: string | null;
  teamId?: string | null;
  priority?: Priority;
  status?: IssueStatus;
  externalUrl?: string | null;
  workstreamIds?: string[];
  /** Id or key. `null` clears the relation. Setting it cancels the issue. */
  duplicateOfId?: string | null;
}

export interface LinkIssueInput {
  workstreamIds?: string[];
  createWorkstream?: WorkstreamInput & { title: string; ownerTeamId: string; deltaThreadUrl: string };
  /** Defaults to `in_progress` when the issue is still `backlog` or `todo`. */
  status?: IssueStatus;
}

const KEY_RE = /^[A-Za-z]+-\d+$/;
const SCHEDULED: ReadonlySet<IssueStatus> = new Set(['backlog', 'todo']);

@Injectable()
export class IssuesService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly counters: CountersService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    private readonly workstreams: WorkstreamsService,
    @InjectRepository(IssueEntity) private readonly repo: Repository<IssueEntity>,
  ) {}

  list(workspaceId: string, f: { kind?: IssueKind; status?: IssueStatus; teamId?: string; assigneeId?: string; workstreamId?: string; q?: string } = {}) {
    const qb = this.repo.createQueryBuilder('i').where('i.workspaceId = :workspaceId', { workspaceId }).orderBy('i.createdAt', 'DESC');
    if (f.kind) qb.andWhere('i.kind = :k', { k: f.kind });
    if (f.status) qb.andWhere('i.status = :s', { s: f.status });
    if (f.teamId) qb.andWhere('i.teamId = :t', { t: f.teamId });
    if (f.assigneeId) qb.andWhere('i.assigneeId = :a', { a: f.assigneeId });
    if (f.workstreamId) qb.andWhere('i.workstreamIds @> :w::jsonb', { w: JSON.stringify([f.workstreamId]) });
    if (f.q) qb.andWhere('(i.title ILIKE :q OR i.key ILIKE :q)', { q: `%${f.q}%` });
    return qb.getMany();
  }

  /** `idOrKey`: id (`in_…`) or key (`BUG-142`). */
  async get(workspaceId: string, idOrKey: string) {
    const row = await this.repo.findOneBy(
      KEY_RE.test(idOrKey) ? { workspaceId, key: idOrKey.toUpperCase() } : { workspaceId, id: idOrKey },
    );
    if (!row) throw notFound('Issue', idOrKey);
    return row;
  }

  async create(workspaceId: string, actor: ActorRef, input: IssueInput & { kind: IssueKind; title: string }) {
    await this.refs.teams(workspaceId, [input.teamId].filter((x): x is string => !!x));
    await this.refs.users(workspaceId, [input.assigneeId]);
    const row = await this.ds.transaction(async (m) => {
      const number = await this.counters.next(m, workspaceId, `issue:${input.kind}`);
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
          status: input.status ?? 'backlog',
          externalUrl: input.externalUrl ?? null,
        }),
      );
    });
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.created',
      subject: { type: 'issue', id: row.id },
      data: { key: row.key, kind: row.kind, title: row.title, status: row.status },
    });
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: IssueInput) {
    const row = await this.get(workspaceId, idOrKey);
    await this.refs.teams(workspaceId, [patch.teamId].filter((x): x is string => !!x));
    await this.refs.users(workspaceId, [patch.assigneeId]);
    await this.refs.workstreams(workspaceId, patch.workstreamIds);
    const before = new Set(row.workstreamIds);
    const from = row.status;

    let duplicateOfId = row.duplicateOfId;
    if (patch.duplicateOfId !== undefined) {
      if (patch.duplicateOfId === null) {
        duplicateOfId = null;
      } else {
        if (patch.status !== undefined && patch.status !== 'canceled')
          throw new BadRequestException('Marking an issue as a duplicate sets its status to "canceled"');
        if (patch.workstreamIds?.length)
          throw new BadRequestException('Cannot link workstreams when marking an issue as a duplicate');
        const target = await this.get(workspaceId, patch.duplicateOfId);
        if (target.id === row.id) throw new BadRequestException('An issue cannot duplicate itself');
        duplicateOfId = target.id;
        patch = { ...patch, status: 'canceled' };
      }
    }

    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.reporterName !== undefined) row.reporterName = patch.reporterName;
    if (patch.assigneeId !== undefined) row.assigneeId = patch.assigneeId;
    if (patch.teamId !== undefined) row.teamId = patch.teamId;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.externalUrl !== undefined) row.externalUrl = patch.externalUrl;
    if (patch.workstreamIds !== undefined) row.workstreamIds = unique(patch.workstreamIds);
    if (patch.status !== undefined) row.status = patch.status;
    row.duplicateOfId = duplicateOfId;
    row.updatedAt = new Date();
    await this.repo.save(row);

    const fields = Object.keys(patch).filter((k) => k !== 'status');
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
  async link(workspaceId: string, actor: ActorRef, idOrKey: string, input: LinkIssueInput) {
    const row = await this.get(workspaceId, idOrKey);
    if (row.duplicateOfId) throw new BadRequestException('A duplicate issue cannot be linked to a workstream');
    if (!input.createWorkstream && !input.workstreamIds?.length)
      throw new BadRequestException('workstreamIds or createWorkstream is required');
    if (input.status === 'canceled') throw new BadRequestException('Cancel the issue with PATCH instead of linking it');
    await this.refs.workstreams(workspaceId, input.workstreamIds);

    let created: Awaited<ReturnType<WorkstreamsService['create']>> | undefined;
    const previous = row.workstreamIds;
    const from = row.status;
    await this.ds.transaction(async (m) => {
      const ids = unique([...(row.workstreamIds ?? []), ...(input.workstreamIds ?? [])]);
      if (input.createWorkstream) {
        created = await this.workstreams.create(workspaceId, actor, input.createWorkstream, {
          manager: m,
          data: { fromIssue: row.key },
        });
        ids.push(created.id);
      }
      row.workstreamIds = ids;
      row.status = input.status ?? (SCHEDULED.has(row.status) ? 'in_progress' : row.status);
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
        data: { key: row.key, workstreamIds: row.workstreamIds, createdWorkstreamId: created?.id },
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
    await this.bus.touchMany(workspaceId, [...previous, ...row.workstreamIds], 'issue.linked');
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const row = await this.get(workspaceId, idOrKey);
    await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, row.id]);
    await this.ds.query(`UPDATE "issues" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = $2`, [workspaceId, row.id]);
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
