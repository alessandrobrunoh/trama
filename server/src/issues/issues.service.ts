import {
  demandConditions,
  type DemandFilter,
} from '../customers/demand-filter.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type EntityManager, type Repository } from 'typeorm';
import {
  ISSUE_KEY_PREFIX,
  statusIdsForTypes,
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
import {
  IssueEntity,
  MilestoneEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import {
  loadStatusCatalog,
  requireStatus,
  statusFilterIds,
} from '../status/status-catalog.js';
import { LabelsService } from '../workspaces/labels.service.js';
import {
  applyProjectScope,
  assertCanUseProject,
  currentAccess,
  projectHidden,
} from '../auth/member-access.js';
import { UploadsService } from '../uploads/uploads.service.js';

export interface IssueInput {
  title?: string;
  /** Changing it re-keys the issue and keeps the old key as an alias. */
  kind?: IssueKind;
  estimate?: number | null;
  body?: string | null;
  source?: IssueSource;
  reporterName?: string | null;
  goal?: string | null;
  assigneeId?: string | null;
  teamId?: string | null;
  /** Project the issue is planned under. `null` clears it (and drops that project's milestone). */
  projectId?: string | null;
  priority?: Priority;
  /** Catalog id, or a legacy enum (the seeded status of that type). */
  status?: string;
  externalUrl?: string | null;
  milestoneIds?: string[];
  labels?: string[];
  /** Id or key. `null` clears the relation. Setting it cancels the issue. */
  duplicateOfId?: string | null;
}

/** One change applied to every issue of a bulk request. Labels are added / removed. */
export interface BulkIssuePatch {
  /** Catalog id, or a legacy enum (the seeded status of that type). */
  status?: string;
  priority?: Priority;
  assigneeId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  addLabels?: string[];
  removeLabels?: string[];
}

/** An update validated and applied to the row in memory, waiting to be persisted and announced. */
interface PreparedUpdate {
  row: IssueEntity;
  patch: IssueInput;
  from: IssueStatus;
  fromKey: string;
  fromKind: IssueKind;
  previousAssigneeId: string | null;
  rekey: boolean;
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
  if (
    to === 'in_progress' &&
    from !== 'in_progress' &&
    !assigneeId &&
    actor.type === 'user' &&
    actor.id
  ) {
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
    private readonly labels: LabelsService,
    @InjectRepository(IssueEntity)
    private readonly repo: Repository<IssueEntity>,
    @Optional()
    @Inject(UploadsService)
    private readonly uploads?: UploadsService,
  ) {}

  private async resolveIssueStatus(workspaceId: string, stored: string) {
    const catalog = (await loadStatusCatalog(this.ds, workspaceId)).issue;
    return requireStatus(catalog, stored, 'status');
  }

  private async issueStatusType(
    workspaceId: string,
    stored: string,
  ): Promise<IssueStatus> {
    return (await this.resolveIssueStatus(workspaceId, stored)).type;
  }

  async list(
    workspaceId: string,
    f: {
      kind?: IssueKind;
      /** Catalog id, or a legacy enum (the seeded status of that type). */
      status?: string;
      teamId?: string;
      assigneeId?: string;
      projectId?: string;
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
    if (f.status || f.open) {
      const catalog = (await loadStatusCatalog(this.ds, workspaceId)).issue;
      if (f.status)
        qb.andWhere('i.status IN (:...st)', {
          st: statusFilterIds(catalog, f.status),
        });
      if (f.open) {
        qb.andWhere('i.status IN (:...open)', {
          open: statusIdsForTypes(catalog, [
            'backlog',
            'todo',
            'in_progress',
            'in_review',
          ]),
        });
      }
    }
    if (f.priority?.length)
      qb.andWhere('i.priority IN (:...pr)', { pr: f.priority });
    if (f.teamId) qb.andWhere('i.teamId = :t', { t: f.teamId });
    if (f.assigneeId) qb.andWhere('i.assigneeId = :a', { a: f.assigneeId });
    if (f.projectId)
      qb.andWhere('i.projectId = :p', { p: f.projectId });
    if (f.milestoneId)
      qb.andWhere('i.milestoneIds @> :m::jsonb', {
        m: JSON.stringify([f.milestoneId]),
      });
    for (const c of demandConditions('i', 'issueId', f))
      qb.andWhere(c.sql, c.params);
    applyProjectScope(qb, 'i', 'projectId');
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
    if (!row || projectHidden(currentAccess(), row.projectId))
      throw notFound('Issue', idOrKey);
    return row;
  }

  /**
   * Milestones must exist and belong to the issue's project; an issue may be
   * in at most one milestone per project.
   */
  private async assertMilestones(
    workspaceId: string,
    milestoneIds: readonly string[],
    projectId: string | null,
  ) {
    if (!milestoneIds.length) return;
    const rows = await this.ds
      .getRepository(MilestoneEntity)
      .findBy({ workspaceId, id: In(milestoneIds) });
    if (rows.length !== milestoneIds.length)
      throw new BadRequestException(
        `Unknown milestone in: ${milestoneIds.join(', ')}`,
      );
    const projects = new Set(projectId ? [projectId] : []);
    const seen = new Set<string>();
    for (const m of rows) {
      if (!projects.has(m.projectId))
        throw new BadRequestException(
          `Milestone "${m.name}" does not belong to this issue's project`,
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
    assertCanUseProject(input.projectId ?? null);
    await this.refs.teams(
      workspaceId,
      [input.teamId].filter((x): x is string => !!x),
    );
    await this.refs.projects(
      workspaceId,
      [input.projectId].filter((x): x is string => !!x),
    );
    const resolved = await this.resolveIssueStatus(
      workspaceId,
      input.status ?? 'backlog',
    );
    const status = resolved.id as IssueStatus;
    const assigneeId = claimAssignee(
      actor,
      null,
      resolved.type,
      input.assigneeId ?? null,
      input.assigneeId !== undefined,
    );
    await this.refs.users(workspaceId, [assigneeId]);
    await this.uploads?.assertAttachable(workspaceId, input.body);
    const facts: Pick<IssueEntity, 'startedAt' | 'completedAt'> = {
      startedAt: null,
      completedAt: null,
    };
    applyStatusFacts(facts, resolved.type);
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
          goal: input.goal ?? null,
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
          labels:
            (await this.labels.assign(workspaceId, input.labels, 'issue')) ??
            [],
        }),
      );
    });
    await this.uploads?.retained(workspaceId, null, row.body);
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
    if (patch.projectId !== undefined) assertCanUseProject(patch.projectId);
    const previousBody = row.body;
    const prepared = await this.prepareUpdate(workspaceId, actor, row, patch);
    if (patch.body !== undefined)
      await this.uploads?.assertAttachable(workspaceId, row.body);
    await this.ds.transaction(async (m) => {
      await this.rekey(m, workspaceId, prepared);
      await m.save(row);
    });
    if (patch.body !== undefined)
      await this.uploads?.retained(workspaceId, previousBody, row.body);
    await this.recordUpdate(workspaceId, actor, prepared);
    return row;
  }

  /**
   * Resolve ids / keys / aliases to issue rows of this workspace (input order, duplicates folded).
   * 404 naming every reference that does not exist, so nothing is half-applied.
   */
  async getMany(
    workspaceId: string,
    refs: readonly string[],
  ): Promise<IssueEntity[]> {
    const wanted = unique(refs);
    const rows: IssueEntity[] = [];
    const missing: string[] = [];
    for (const ref of wanted) {
      try {
        rows.push(await this.get(workspaceId, ref));
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
        missing.push(ref);
      }
    }
    if (missing.length)
      throw new NotFoundException(`Issue not found: ${missing.join(', ')}`);
    return unique(rows.map((r) => r.id)).map((id) =>
      rows.find((r) => r.id === id)!,
    );
  }

  /**
   * Apply one patch to many issues all-or-nothing: every issue is validated first, the writes
   * happen in one transaction, and the events are recorded once it committed (a failure leaves
   * nothing behind). Labels are added / removed, not replaced.
   */
  async updateMany(
    workspaceId: string,
    actor: ActorRef,
    rows: readonly IssueEntity[],
    patch: BulkIssuePatch,
  ): Promise<IssueEntity[]> {
    const touchesAnything = Object.values(patch).some((v) => v !== undefined);
    if (!touchesAnything)
      throw new BadRequestException('patch must change at least one field');
    const addLabels = unique(patch.addLabels);
    const removeLabels = unique(patch.removeLabels);
    if (addLabels.some((id) => removeLabels.includes(id)))
      throw new BadRequestException('A label cannot be both added and removed');
    // One lookup per reference for the whole batch instead of one per issue.
    await this.refs.teams(
      workspaceId,
      [patch.teamId].filter((x): x is string => !!x),
    );
    await this.refs.users(workspaceId, [patch.assigneeId]);
    await this.refs.projects(
      workspaceId,
      [patch.projectId].filter((x): x is string => !!x),
    );
    await this.labels.assign(
      workspaceId,
      [...addLabels, ...removeLabels],
      'issue',
      removeLabels,
    );

    const prepared: PreparedUpdate[] = [];
    for (const row of rows) {
      const next: IssueInput = {};
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.priority !== undefined) next.priority = patch.priority;
      if (patch.assigneeId !== undefined) next.assigneeId = patch.assigneeId;
      if (patch.teamId !== undefined) next.teamId = patch.teamId;
      if (patch.projectId !== undefined) next.projectId = patch.projectId;
      if (addLabels.length || removeLabels.length)
        next.labels = unique([...row.labels, ...addLabels]).filter(
          (l) => !removeLabels.includes(l),
        );
      prepared.push(
        await this.prepareUpdate(workspaceId, actor, row, next, true),
      );
    }
    await this.ds.transaction(async (m) => {
      await m.save(rows.map((r) => r));
    });
    for (const p of prepared) await this.recordUpdate(workspaceId, actor, p);
    return [...rows];
  }

  /** Validates the patch and applies it to `row` in memory; nothing is persisted yet. */
  private async prepareUpdate(
    workspaceId: string,
    actor: ActorRef,
    row: IssueEntity,
    patch: IssueInput,
    refsChecked = false,
  ): Promise<PreparedUpdate> {
    const previousAssigneeId = row.assigneeId;
    if (!refsChecked) {
      await this.refs.teams(
        workspaceId,
        [patch.teamId].filter((x): x is string => !!x),
      );
      await this.refs.users(workspaceId, [patch.assigneeId]);
      await this.refs.projects(
        workspaceId,
        [patch.projectId].filter((x): x is string => !!x),
      );
    }
    const from = row.status;
    const fromKey = row.key;
    const fromKind = row.kind;
    let duplicateOfId = row.duplicateOfId;
    if (patch.duplicateOfId !== undefined) {
      if (patch.duplicateOfId === null) {
        duplicateOfId = null;
      } else {
        if (
          patch.status !== undefined &&
          (await this.resolveIssueStatus(workspaceId, patch.status)).type !==
            'canceled'
        )
          throw new BadRequestException(
            'Marking an issue as a duplicate sets its status to "canceled"',
          );
        const target = await this.get(workspaceId, patch.duplicateOfId);
        if (target.id === row.id)
          throw new BadRequestException('An issue cannot duplicate itself');
        duplicateOfId = target.id;
        patch = { ...patch, status: 'canceled' };
      }
    }

    const nextProjectId =
      patch.projectId !== undefined ? patch.projectId : row.projectId;
    let nextMilestoneIds =
      patch.milestoneIds !== undefined
        ? unique(patch.milestoneIds)
        : row.milestoneIds;
    if (patch.milestoneIds !== undefined) {
      await this.assertMilestones(
        workspaceId,
        nextMilestoneIds,
        nextProjectId,
      );
    } else if (
      patch.projectId !== undefined &&
      row.milestoneIds.length
    ) {
      const projects = new Set(nextProjectId ? [nextProjectId] : []);
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
    if (patch.goal !== undefined) row.goal = patch.goal;
    if (patch.assigneeId !== undefined) row.assigneeId = patch.assigneeId;
    if (patch.teamId !== undefined) row.teamId = patch.teamId;
    if (patch.projectId !== undefined) row.projectId = patch.projectId;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.externalUrl !== undefined) row.externalUrl = patch.externalUrl;
    if (patch.labels !== undefined)
      row.labels =
        (await this.labels.assign(
          workspaceId,
          patch.labels,
          'issue',
          row.labels,
        )) ?? [];
    const fromType = await this.issueStatusType(workspaceId, from);
    let toType = fromType;
    if (patch.status !== undefined) {
      const resolved = await this.resolveIssueStatus(workspaceId, patch.status);
      row.status = resolved.id as IssueStatus;
      toType = resolved.type;
      if (resolved.id !== from) applyStatusFacts(row, resolved.type);
    }
    const claimed = claimAssignee(
      actor,
      fromType,
      toType,
      row.assigneeId,
      patch.assigneeId !== undefined,
    );
    if (claimed !== row.assigneeId) {
      await this.refs.users(workspaceId, [claimed]);
      row.assigneeId = claimed;
    }
    row.duplicateOfId = duplicateOfId;
    row.updatedAt = new Date();
    return {
      row,
      patch,
      from,
      fromKey,
      fromKind,
      previousAssigneeId,
      rekey: patch.kind !== undefined && patch.kind !== fromKind,
    };
  }

  /** The key prefix follows the kind: take the next number of the new kind, keep the old key as an alias. */
  private async rekey(
    m: EntityManager,
    workspaceId: string,
    p: PreparedUpdate,
  ) {
    if (!p.rekey) return;
    const { row, patch } = p;
    const number = await this.counters.next(
      m,
      workspaceId,
      `issue:${patch.kind}`,
    );
    row.aliases = unique([...row.aliases, p.fromKey]);
    row.kind = patch.kind!;
    row.number = number;
    row.key = `${ISSUE_KEY_PREFIX[row.kind]}-${number}`;
  }

  private async recordUpdate(
    workspaceId: string,
    actor: ActorRef,
    p: PreparedUpdate,
  ) {
    const { row, patch, from, fromKey, fromKind, previousAssigneeId } = p;
    const fields = Object.keys(patch)
      .filter((k) => (patch as Record<string, unknown>)[k] !== undefined)
      .filter((k) => k !== 'status' && k !== 'kind');
    if (row.assigneeId !== previousAssigneeId && !fields.includes('assigneeId'))
      fields.push('assigneeId');
    if (p.rekey)
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
        data: { key: row.key, from, to: row.status },
      });
  }

  /**
   * Attach (or, with `null`, detach) the external tracker issue this one mirrors. The pointer is a read-only
   * mirror: it never changes the status. One external issue belongs to one Trama issue (409 otherwise).
   */
  async setExternalRef(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    ref: ExternalRef | null,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    const previous = row.externalRef;
    row.externalRef = ref;
    if (ref && !row.externalUrl) row.externalUrl = ref.url;
    if (!ref && previous && row.externalUrl === previous.url)
      row.externalUrl = null;
    row.updatedAt = new Date();
    try {
      await this.repo.save(row);
    } catch (e) {
      if (isUniqueViolation(e) && ref) {
        const other = await this.ds
          .getRepository(IssueEntity)
          .createQueryBuilder('i')
          .where(
            `i."workspaceId" = :workspaceId AND i."externalRef"->>'provider' = :p AND i."externalRef"->>'id' = :id`,
            { workspaceId, p: ref.provider, id: ref.id },
          )
          .getOne();
        throw new ConflictException(
          `${ref.key ?? ref.id} is already ${other ? `linked to ${other.key}` : 'linked to another issue'}`,
        );
      }
      throw e;
    }
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.updated',
      subject: { type: 'issue', id: row.id },
      data: {
        key: row.key,
        fields: ['externalRef'],
        external: ref
          ? { provider: ref.provider, key: ref.key, origin: ref.origin }
          : null,
      },
    });
    return row;
  }

  /** Stores a freshly read external status. Quiet on purpose (no domain event): it is a mirror, not a change of the work. */
  async refreshExternalRef(
    workspaceId: string,
    idOrKey: string,
    patch: Pick<
      ExternalRef,
      'state' | 'stateType' | 'syncedAt' | 'key' | 'url'
    >,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    if (!row.externalRef)
      throw new BadRequestException(
        'This issue is not linked to an external issue',
      );
    row.externalRef = { ...row.externalRef, ...patch };
    await this.repo.save(row);
    this.events.publish(workspaceId, {
      type: 'updated',
      entity: 'issue',
      id: row.id,
    });
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const row = await this.get(workspaceId, idOrKey);
    const lost =
      (await this.uploads?.idsLostWith(workspaceId, { issueId: row.id }, [
        row.body,
      ])) ?? [];
    await this.ds.query(
      `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`,
      [workspaceId, row.id],
    );
    await this.ds.query(
      `UPDATE "issues" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = $2`,
      [workspaceId, row.id],
    );
    await this.repo.delete({ id: row.id });
    await this.uploads?.releaseIds(workspaceId, lost);
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.deleted',
      subject: { type: 'issue', id: row.id },
      data: { key: row.key, title: row.title },
    });
  }

  /** Delete many issues in one transaction; events follow the commit. */
  async removeMany(
    workspaceId: string,
    actor: ActorRef,
    rows: readonly IssueEntity[],
  ) {
    const ids = rows.map((r) => r.id);
    if (!ids.length) return;
    await this.ds.transaction(async (m) => {
      await m.query(
        `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`,
        [workspaceId, ids],
      );
      await m.query(
        `UPDATE "issues" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = ANY($2)`,
        [workspaceId, ids],
      );
      await m.delete(IssueEntity, { workspaceId, id: In(ids) });
    });
    for (const row of rows)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.deleted',
        subject: { type: 'issue', id: row.id },
        data: { key: row.key, title: row.title },
      });
  }
}
