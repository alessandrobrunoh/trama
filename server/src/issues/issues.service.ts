import { demandConditions, type DemandFilter } from '../customers/demand-filter.js';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import {
  ISSUE_KEY_PREFIX,
  type ExternalRef,
  type ActorRef,
  type IssueKind,
  type IssueSource,
  type IssueStatus,
  type Priority,
} from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { isUniqueViolation, notFound, uid, unique } from '../common/util.js';
import { IssueEntity, MilestoneEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import {
  WorkstreamsService,
  type WorkstreamInput,
} from '../workstreams/workstreams.service.js';
import { LabelsService } from '../workspaces/labels.service.js';

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
  /** Project the issue is planned under. `null` clears it (and drops that project's milestone). */
  projectId?: string | null;
  priority?: Priority;
  status?: IssueStatus;
  externalUrl?: string | null;
  workstreamIds?: string[];
  milestoneIds?: string[];
  labels?: string[];
  /** Id or key. `null` clears the relation. Setting it cancels the issue. */
  duplicateOfId?: string | null;
}

export interface LinkIssueInput {
  workstreamIds?: string[];
  createWorkstream?: WorkstreamInput & {
    title: string;
    ownerTeamId: string;
    deltaThreadUrl?: string;
  };
  /** Optional explicit status. Without it, linking leaves the status unchanged. */
  status?: IssueStatus;
}

const KEY_RE = /^[A-Za-z]+-\d+$/;
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

/**
 * The user who moves an unassigned issue to `in_progress` becomes the assignee.
 * An explicit assignee (including `null`) wins. Agents and other actors do not claim,
 * and an issue that is already `in_progress` is left as it is.
 */
export function claimAssignee(
  actor: ActorRef,
  from: IssueStatus | null,
  to: IssueStatus,
  assigneeId: string | null,
  assigneeWasSet: boolean,
): string | null {
  if (assigneeWasSet) return assigneeId;
  if (to === 'in_progress' && from !== 'in_progress' && !assigneeId && actor.type === 'user' && actor.id) {
    return actor.id;
  }
  return assigneeId;
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
    private readonly labels: LabelsService,
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
      projectId?: string;
      workstreamId?: string;
      milestoneId?: string;
    } & DemandFilter & {
      q?: string;
      priority?: Priority[];
      /** Only issues still in play: backlog, todo, in progress, in review. */
      open?: boolean;
      limit?: number;
    } = {},
  ) {
    const qb = this.repo
      .createQueryBuilder('i')
      .where('i.workspaceId = :workspaceId', { workspaceId })
      .orderBy('i.createdAt', 'DESC');
    if (f.kind) qb.andWhere('i.kind = :k', { k: f.kind });
    if (f.status) qb.andWhere('i.status = :s', { s: f.status });
    if (f.priority?.length) qb.andWhere('i.priority IN (:...pr)', { pr: f.priority });
    if (f.open) qb.andWhere("i.status IN ('backlog', 'todo', 'in_progress', 'in_review')");
    if (f.teamId) qb.andWhere('i.teamId = :t', { t: f.teamId });
    if (f.assigneeId) qb.andWhere('i.assigneeId = :a', { a: f.assigneeId });
    // Same meaning as the client's `issuesByProject`: planned under the project, or linked to one of its workstreams.
    if (f.projectId)
      qb.andWhere(
        `(i.projectId = :p OR EXISTS (SELECT 1 FROM workstreams pw WHERE pw."workspaceId" = i."workspaceId" AND pw."projectId" = :p AND i."workstreamIds" @> jsonb_build_array(pw.id)))`,
        { p: f.projectId },
      );
    if (f.workstreamId)
      qb.andWhere('i.workstreamIds @> :w::jsonb', {
        w: JSON.stringify([f.workstreamId]),
      });
    if (f.milestoneId)
      qb.andWhere('i.milestoneIds @> :m::jsonb', {
        m: JSON.stringify([f.milestoneId]),
      });
    for (const c of demandConditions('i', 'issueId', f)) qb.andWhere(c.sql, c.params);
    if (f.q)
      qb.andWhere(
        '(i.title ILIKE :q OR i.key ILIKE :q OR i.aliases::text ILIKE :q)',
        { q: `%${f.q}%` },
      );
    if (f.limit) qb.take(f.limit);
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

  /** Projects an issue may take milestones from: its own plus those its workstreams carry out. */
  private async milestoneProjects(
    workspaceId: string,
    projectId: string | null,
    workstreamIds: readonly string[],
  ) {
    const streams = workstreamIds.length
      ? await this.ds.getRepository(WorkstreamEntity).findBy({ workspaceId, id: In([...workstreamIds]) })
      : [];
    const projects = new Set(streams.map((w) => w.projectId).filter((p): p is string => !!p));
    if (projectId) projects.add(projectId);
    return projects;
  }

  /**
   * Milestones must exist, belong to the issue's project or to a project of a workstream the issue
   * is linked to, and an issue may be in at most one milestone per project.
   */
  private async assertMilestones(
    workspaceId: string,
    milestoneIds: readonly string[],
    projectId: string | null,
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
    const projects = await this.milestoneProjects(workspaceId, projectId, workstreamIds);
    const seen = new Set<string>();
    for (const m of rows) {
      if (!projects.has(m.projectId))
        throw new BadRequestException(
          `Milestone "${m.name}" belongs to a project that is neither this issue's project nor one its workstreams carry out`,
        );
      if (seen.has(m.projectId))
        throw new BadRequestException(
          'An issue can be in at most one milestone per project',
        );
      seen.add(m.projectId);
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
    await this.refs.projects(workspaceId, [input.projectId].filter((x): x is string => !!x));
    const status = input.status ?? 'backlog';
    const assigneeId = claimAssignee(actor, null, status, input.assigneeId ?? null, input.assigneeId !== undefined);
    await this.refs.users(workspaceId, [assigneeId]);
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
          assigneeId,
          teamId: input.teamId ?? null,
          projectId: input.projectId ?? null,
          priority: input.priority ?? 'none',
          status,
          estimate: input.estimate ?? null,
          startedAt: facts.startedAt,
          completedAt: facts.completedAt,
          externalUrl: input.externalUrl ?? null,
          labels: (await this.labels.assign(workspaceId, input.labels)) ?? [],
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
        assigneeId: row.assigneeId,
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
    const previousAssigneeId = row.assigneeId;
    await this.refs.teams(
      workspaceId,
      [patch.teamId].filter((x): x is string => !!x),
    );
    await this.refs.users(workspaceId, [patch.assigneeId]);
    await this.refs.projects(workspaceId, [patch.projectId].filter((x): x is string => !!x));
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
    const nextProjectId = patch.projectId !== undefined ? patch.projectId : row.projectId;
    let nextMilestoneIds =
      patch.milestoneIds !== undefined
        ? unique(patch.milestoneIds)
        : row.milestoneIds;
    if (patch.milestoneIds !== undefined) {
      await this.assertMilestones(
        workspaceId,
        nextMilestoneIds,
        nextProjectId,
        nextWorkstreamIds,
      );
    } else if (
      (patch.workstreamIds !== undefined || patch.projectId !== undefined) &&
      row.milestoneIds.length
    ) {
      // Leaving a project (clearing it, or unlinking its last workstream) drops that project's milestone.
      const projects = await this.milestoneProjects(workspaceId, nextProjectId, nextWorkstreamIds);
      const kept = new Set(
        (
          await this.ds
            .getRepository(MilestoneEntity)
            .findBy({ workspaceId, id: In(row.milestoneIds) })
        )
          .filter((m) => projects.has(m.projectId))
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
    if (patch.projectId !== undefined) row.projectId = patch.projectId;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.externalUrl !== undefined) row.externalUrl = patch.externalUrl;
    if (patch.workstreamIds !== undefined)
      row.workstreamIds = unique(patch.workstreamIds);
    if (patch.labels !== undefined) row.labels = (await this.labels.assign(workspaceId, patch.labels)) ?? [];
    if (patch.status !== undefined) {
      row.status = patch.status;
      if (row.status !== from) applyStatusFacts(row, row.status);
    }
    const claimed = claimAssignee(actor, from, row.status, row.assigneeId, patch.assigneeId !== undefined);
    if (claimed !== row.assigneeId) {
      await this.refs.users(workspaceId, [claimed]);
      row.assigneeId = claimed;
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
    if (row.assigneeId !== previousAssigneeId && !fields.includes('assigneeId')) fields.push('assigneeId');
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
        data: {
          key: row.key,
          fields,
          ...(row.assigneeId !== previousAssigneeId
            ? { assignee: { from: previousAssigneeId, to: row.assigneeId } }
            : {}),
        },
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
   * created atomically). Linking is organizational and never changes the status by itself; only an
   * explicit `status` does (moving to `in_progress` then assigns the acting user if unassigned).
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
    const previousAssigneeId = row.assigneeId;
    const nextStatus = input.status ?? row.status;
    const nextAssignee = claimAssignee(actor, from, nextStatus, row.assigneeId, false);
    if (nextAssignee !== row.assigneeId) await this.refs.users(workspaceId, [nextAssignee]);
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
      row.assigneeId = nextAssignee;
      row.status = nextStatus;
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
    if (row.assigneeId !== previousAssigneeId)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.updated',
        subject: { type: 'issue', id: row.id },
        workstreamId: row.workstreamIds[0] ?? null,
        data: { key: row.key, fields: ['assigneeId'], assignee: { from: previousAssigneeId, to: row.assigneeId } },
      });
    await this.bus.touchMany(
      workspaceId,
      [...previous, ...row.workstreamIds],
      'issue.linked',
    );
    return row;
  }

  /**
   * Attach (or, with `null`, detach) the external tracker issue this one mirrors. The pointer is a read-only
   * mirror: it never changes the status. One external issue belongs to one Trama issue (409 otherwise).
   */
  async setExternalRef(workspaceId: string, actor: ActorRef, idOrKey: string, ref: ExternalRef | null) {
    const row = await this.get(workspaceId, idOrKey);
    const previous = row.externalRef;
    row.externalRef = ref;
    if (ref && !row.externalUrl) row.externalUrl = ref.url;
    if (!ref && previous && row.externalUrl === previous.url) row.externalUrl = null;
    row.updatedAt = new Date();
    try {
      await this.repo.save(row);
    } catch (e) {
      if (isUniqueViolation(e) && ref) {
        const other = await this.ds
          .getRepository(IssueEntity)
          .createQueryBuilder('i')
          .where(`i."workspaceId" = :workspaceId AND i."externalRef"->>'provider' = :p AND i."externalRef"->>'id' = :id`, { workspaceId, p: ref.provider, id: ref.id })
          .getOne();
        throw new ConflictException(`${ref.key ?? ref.id} is already ${other ? `linked to ${other.key}` : 'linked to another issue'}`);
      }
      throw e;
    }
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.updated',
      subject: { type: 'issue', id: row.id },
      data: { key: row.key, fields: ['externalRef'], external: ref ? { provider: ref.provider, key: ref.key, origin: ref.origin } : null },
    });
    return row;
  }

  /** Stores a freshly read external status. Quiet on purpose (no domain event): it is a mirror, not a change of the work. */
  async refreshExternalRef(workspaceId: string, idOrKey: string, patch: Pick<ExternalRef, 'state' | 'stateType' | 'syncedAt' | 'key' | 'url'>) {
    const row = await this.get(workspaceId, idOrKey);
    if (!row.externalRef) throw new BadRequestException('This issue is not linked to an external issue');
    row.externalRef = { ...row.externalRef, ...patch };
    await this.repo.save(row);
    this.events.publish(workspaceId, { type: 'updated', entity: 'issue', id: row.id });
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
