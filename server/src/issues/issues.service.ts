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
  statusIdsForTypes,
  UNASSIGNED_ISSUE_KEY_PREFIX,
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
  DocumentEntity,
  IssueEntity,
  MilestoneEntity,
  ReleaseEntity,
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
import { allocateIssueNumbers, issueKeyPrefix, type IssueKeyChange } from './issue-keys.js';

export interface IssueInput {
  title?: string;
  /** Issue classification; it does not affect the issue key. */
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
  /** Id or key of the parent issue. `null` makes this issue a root issue. */
  parentId?: string | null;
  priority?: Priority;
  /** Catalog id, or a legacy enum (the seeded status of that type). */
  status?: string;
  externalUrl?: string | null;
  milestoneIds?: string[];
  /** Draft release in this workspace. `null` clears it. */
  releaseId?: string | null;
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
  releaseId?: string | null;
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
  fromProjectId: string | null;
  previousAssigneeId: string | null;
  projectChanged: boolean;
  keyChange?: IssueKeyChange;
}

type IssueTeamRef = Pick<
  IssueEntity,
  'id' | 'teamId' | 'projectId' | 'parentId' | 'key' | 'number' | 'aliases'
>;
type IssueTeamAuthorizer = (affectedIssues: readonly IssueTeamRef[]) => Promise<void>;

const KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
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
      releaseId?: string;
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
    if (f.releaseId) qb.andWhere('i.releaseId = :releaseId', { releaseId: f.releaseId });
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

  /** Current revision number of each Trama document, for plan approval checks. */
  async documentVersions(
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.ds.getRepository(DocumentEntity).find({
      where: { workspaceId, id: In(ids) },
      select: { id: true, version: true },
    });
    return new Map(rows.map((d) => [d.id, d.version]));
  }

  /** `idOrKey`: id (`in_…`), key (`AUTH-142`) or a previous project key alias. */
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

  /** Parent ids may be returned only when the caller can also see the referenced issue. */
  async visibleParentIds(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const parents = await this.repo.find({
      where: { workspaceId, id: In([...ids]) },
      select: { id: true, projectId: true },
    });
    return new Set(
      parents
        .filter((parent) => !projectHidden(currentAccess(), parent.projectId))
        .map((parent) => parent.id),
    );
  }

  private async hideInvisibleParent<T extends { parentId?: string | null }>(
    workspaceId: string,
    issue: T,
  ): Promise<T> {
    if (issue.parentId) {
      const visible = await this.visibleParentIds(workspaceId, [issue.parentId]);
      if (!visible.has(issue.parentId)) issue.parentId = null;
    }
    return issue;
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

  /**
   * A release must exist in this workspace. Issues may only join a draft;
   * `null` clears the assignment.
   */
  private async assertRelease(
    workspaceId: string,
    releaseId: string | null,
  ): Promise<string | null> {
    if (!releaseId) return null;
    const row = await this.ds
      .getRepository(ReleaseEntity)
      .findOneBy({ workspaceId, id: releaseId });
    if (!row)
      throw new BadRequestException(
        `Unknown release "${releaseId}" in this workspace`,
      );
    if (row.status !== 'draft')
      throw new BadRequestException('Issues can only join a draft release');
    return row.id;
  }

  /** Resolve a parent in this workspace and enforce the same project visibility as issue reads. */
  private async resolveParentId(
    workspaceId: string,
    childId: string | null,
    parentRef: string | null,
  ): Promise<string | null> {
    if (parentRef === null) return null;
    const parent = await this.get(workspaceId, parentRef);
    if (parent.id === childId)
      throw new BadRequestException('An issue cannot be its own parent');
    return parent.id;
  }

  /** Locking the workspace serializes all parent-link changes with each other and with deletion. */
  private async lockIssueHierarchy(
    manager: EntityManager,
    workspaceId: string,
  ): Promise<void> {
    await manager.query(
      `SELECT "id" FROM "workspaces" WHERE "id" = $1 FOR UPDATE`,
      [workspaceId],
    );
  }

  /** Read the current relationship before locking the complete, id-sorted set of related rows. */
  private async readIssueRelation(
    manager: EntityManager,
    workspaceId: string,
    issueId: string,
  ): Promise<IssueTeamRef> {
    const [row] = (await manager.query(
      `SELECT "id", "teamId", "projectId", "parentId", "key", "number", "aliases"
         FROM "issues" WHERE "workspaceId" = $1 AND "id" = $2`,
      [workspaceId, issueId],
    )) as IssueTeamRef[];
    if (!row) throw notFound('Issue', issueId);
    return row;
  }

  private async lockIssueRelations(
    manager: EntityManager,
    workspaceId: string,
    ids: readonly string[],
  ): Promise<Map<string, IssueTeamRef>> {
    if (!ids.length) return new Map();
    const rows = (await manager.query(
      `SELECT "id", "teamId", "projectId", "parentId", "key", "number", "aliases" FROM "issues"
       WHERE "workspaceId" = $1 AND "id" = ANY($2::varchar[])
       ORDER BY "id" FOR UPDATE`,
      [workspaceId, unique(ids)],
    )) as IssueTeamRef[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Serialize parent changes in a workspace and reject links to descendants. The recursive query
   * walks upward from the proposed parent, so depth is not bounded by application code.
   */
  private async assertParentLink(
    manager: EntityManager,
    workspaceId: string,
    childId: string,
    parentId: string,
  ): Promise<void> {
    await this.lockIssueHierarchy(manager, workspaceId);
    await this.assertParentLinkLocked(manager, workspaceId, childId, parentId);
  }

  /** Parent graph lock must already be held. */
  private async assertParentLinkLocked(
    manager: EntityManager,
    workspaceId: string,
    childId: string,
    parentId: string,
  ): Promise<void> {
    const [state] = (await manager.query(
      `WITH RECURSIVE parent_chain ("id", "parentId", "path", "cycle") AS (
        SELECT i."id", i."parentId", ARRAY[i."id"]::character varying[], false
        FROM "issues" i
        WHERE i."workspaceId" = $1 AND i."id" = $2
        UNION ALL
        SELECT p."id", p."parentId", c."path" || p."id",
               p."id" = ANY(c."path")
        FROM "issues" p
        JOIN parent_chain c ON p."id" = c."parentId"
        WHERE p."workspaceId" = $1 AND NOT c."cycle"
      )
      SELECT count(*) > 0 AS "found",
             COALESCE(bool_or("id" = $3), false) AS "includesChild",
             COALESCE(bool_or("cycle"), false) AS "containsCycle"
      FROM parent_chain`,
      [workspaceId, parentId, childId],
    )) as {
      found: boolean;
      includesChild: boolean;
      containsCycle: boolean;
    }[];
    if (!state?.found) throw notFound('Issue', parentId);
    if (state.includesChild || state.containsCycle)
      throw new BadRequestException('Issue hierarchy cannot contain cycles');
  }

  async create(
    workspaceId: string,
    actor: ActorRef,
    input: IssueInput & { kind: IssueKind; title: string },
    authorizeParent: IssueTeamAuthorizer,
  ) {
    assertCanUseProject(input.projectId ?? null);
    const parentId =
      input.parentId == null
        ? null
        : await this.resolveParentId(workspaceId, null, input.parentId);
    await this.refs.teams(
      workspaceId,
      [input.teamId].filter((x): x is string => !!x),
    );
    await this.refs.projects(
      workspaceId,
      [input.projectId].filter((x): x is string => !!x),
    );
    const releaseId = await this.assertRelease(
      workspaceId,
      input.releaseId ?? null,
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
      const id = uid('in');
      let parent: IssueTeamRef | undefined;
      if (parentId !== null) {
        await this.assertParentLink(m, workspaceId, id, parentId);
        parent = (
          await this.lockIssueRelations(m, workspaceId, [parentId])
        ).get(parentId);
        if (!parent || projectHidden(currentAccess(), parent.projectId))
          throw notFound('Issue', parentId);
      }
      await authorizeParent(parent ? [parent] : []);
      const prefix = await issueKeyPrefix(
        m,
        workspaceId,
        input.projectId ?? null,
      );
      const [number] = await allocateIssueNumbers(
        m,
        this.counters,
        workspaceId,
        prefix,
        1,
      );
      return m.save(
        m.create(IssueEntity, {
          id,
          workspaceId,
          key: `${prefix}-${number}`,
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
          releaseId,
          parentId,
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
    authorizeParents: IssueTeamAuthorizer,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    if (patch.projectId !== undefined) assertCanUseProject(patch.projectId);
    if (patch.parentId !== undefined) {
      patch = {
        ...patch,
        parentId: await this.resolveParentId(workspaceId, row.id, patch.parentId),
      };
    }
    const previousBody = row.body;
    const prepared = await this.prepareUpdate(workspaceId, actor, row, patch);
    if (patch.body !== undefined)
      await this.uploads?.assertAttachable(workspaceId, row.body);
    await this.ds.transaction(async (m) => {
      const targetPrefix =
        prepared.patch.projectId !== undefined
          ? await issueKeyPrefix(m, workspaceId, prepared.patch.projectId)
          : undefined;
      let relation: IssueTeamRef | undefined;
      if (prepared.patch.parentId !== undefined) {
        await this.lockIssueHierarchy(m, workspaceId);
        const observed = await this.readIssueRelation(m, workspaceId, row.id);
        const relationIds = unique([
          row.id,
          ...(observed.parentId ? [observed.parentId] : []),
          ...(prepared.patch.parentId ? [prepared.patch.parentId] : []),
        ]);
        const relations = await this.lockIssueRelations(
          m,
          workspaceId,
          relationIds,
        );
        const current = relations.get(row.id);
        if (!current || projectHidden(currentAccess(), current.projectId))
          throw notFound('Issue', row.id);
        relation = current;
        if (current.parentId !== observed.parentId)
          throw new ConflictException('Issue hierarchy changed; retry the update');

        const affected: IssueTeamRef[] = [current];
        if (current.parentId) {
          const previousParent = relations.get(current.parentId);
          if (!previousParent) throw notFound('Issue', current.parentId);
          // The controller conceals the team-policy error if this old parent is project-hidden.
          affected.push(previousParent);
        }
        if (prepared.patch.parentId) {
          const nextParent = relations.get(prepared.patch.parentId);
          if (!nextParent || projectHidden(currentAccess(), nextParent.projectId))
            throw notFound('Issue', prepared.patch.parentId);
          await this.assertParentLinkLocked(
            m,
            workspaceId,
            row.id,
            prepared.patch.parentId,
          );
          affected.push(nextParent);
        }
        await authorizeParents(affected);
        if (prepared.patch.teamId === undefined) row.teamId = current.teamId;
        if (prepared.patch.projectId === undefined)
          row.projectId = current.projectId;
        row.parentId = prepared.patch.parentId;
      } else {
        const current = await this.lockIssueRelations(m, workspaceId, [row.id]);
        const lockedRelation = current.get(row.id);
        if (!lockedRelation || projectHidden(currentAccess(), lockedRelation.projectId))
          throw notFound('Issue', row.id);
        relation = lockedRelation;
        if (prepared.patch.teamId === undefined)
          row.teamId = lockedRelation.teamId;
        if (prepared.patch.projectId === undefined)
          row.projectId = lockedRelation.projectId;
        row.parentId = lockedRelation.parentId;
      }
      if (!relation) throw notFound('Issue', row.id);
      prepared.fromKey = relation.key;
      prepared.fromProjectId = relation.projectId;
      row.key = relation.key;
      row.number = relation.number;
      row.aliases = relation.aliases;
      prepared.projectChanged =
        prepared.patch.projectId !== undefined &&
        row.projectId !== relation.projectId;
      prepared.keyChange = prepared.projectChanged
        ? await this.rekey(
            m,
            workspaceId,
            prepared,
            targetPrefix ?? UNASSIGNED_ISSUE_KEY_PREFIX,
          )
        : undefined;
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
    if (patch.projectId !== undefined) assertCanUseProject(patch.projectId);
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
      if (patch.releaseId !== undefined) next.releaseId = patch.releaseId;
      if (addLabels.length || removeLabels.length)
        next.labels = unique([...row.labels, ...addLabels]).filter(
          (l) => !removeLabels.includes(l),
        );
      prepared.push(
        await this.prepareUpdate(workspaceId, actor, row, next, true),
      );
    }
    await this.ds.transaction(async (m) => {
      const ids = rows.map((row) => row.id);
      const targetPrefix =
        patch.projectId !== undefined
          ? await issueKeyPrefix(m, workspaceId, patch.projectId)
          : undefined;
      const relations = await this.lockIssueRelations(m, workspaceId, ids);
      if (relations.size !== ids.length)
        throw new NotFoundException('An issue in the batch no longer exists');
      for (const p of prepared) {
        const relation = relations.get(p.row.id)!;
        p.fromKey = relation.key;
        p.fromProjectId = relation.projectId;
        p.row.key = relation.key;
        p.row.number = relation.number;
        p.row.aliases = relation.aliases;
        if (p.patch.teamId === undefined) p.row.teamId = relation.teamId;
        if (p.patch.projectId === undefined) p.row.projectId = relation.projectId;
        p.row.parentId = relation.parentId;
        p.projectChanged =
          p.patch.projectId !== undefined &&
          p.row.projectId !== relation.projectId;
        p.keyChange = p.projectChanged
          ? await this.rekey(
              m,
              workspaceId,
              p,
              targetPrefix ?? UNASSIGNED_ISSUE_KEY_PREFIX,
            )
          : undefined;
      }
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
    const fromProjectId = row.projectId;
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
    if (patch.kind !== undefined) row.kind = patch.kind;
    if (patch.estimate !== undefined) row.estimate = patch.estimate;
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.reporterName !== undefined) row.reporterName = patch.reporterName;
    if (patch.goal !== undefined) row.goal = patch.goal;
    if (patch.assigneeId !== undefined) row.assigneeId = patch.assigneeId;
    if (patch.teamId !== undefined) row.teamId = patch.teamId;
    if (patch.projectId !== undefined) row.projectId = patch.projectId;
    if (patch.releaseId !== undefined)
      row.releaseId = await this.assertRelease(workspaceId, patch.releaseId);
    if (patch.parentId !== undefined) row.parentId = patch.parentId;
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
      fromProjectId,
      previousAssigneeId,
      projectChanged:
        patch.projectId !== undefined && patch.projectId !== fromProjectId,
    };
  }

  /** The key prefix follows the project; keep the previous key as an alias. */
  private async rekey(
    m: EntityManager,
    workspaceId: string,
    p: PreparedUpdate,
    prefix: string,
  ): Promise<IssueKeyChange> {
    const { row } = p;
    const [number] = await allocateIssueNumbers(
      m,
      this.counters,
      workspaceId,
      prefix,
      1,
    );
    const from = p.fromKey;
    const to = `${prefix}-${number}`;
    row.aliases = unique([...row.aliases, from]);
    row.number = number;
    row.key = to;
    return {
      issueId: row.id,
      from,
      to,
      fromProjectId: p.fromProjectId,
      toProjectId: row.projectId,
      reason: 'project_changed',
    };
  }

  private async recordUpdate(
    workspaceId: string,
    actor: ActorRef,
    p: PreparedUpdate,
  ) {
    const { row, patch, from, fromKind, previousAssigneeId } = p;
    const fields = Object.keys(patch)
      .filter((k) => (patch as Record<string, unknown>)[k] !== undefined)
      .filter((k) => k !== 'status' && (k !== 'kind' || patch.kind !== fromKind));
    if (row.assigneeId !== previousAssigneeId && !fields.includes('assigneeId'))
      fields.push('assigneeId');
    if (p.keyChange)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.rekeyed',
        subject: { type: 'issue', id: row.id },
        data: {
          key: row.key,
          from: p.keyChange.from,
          to: row.key,
          fromProjectId: p.keyChange.fromProjectId,
          toProjectId: p.keyChange.toProjectId,
          reason: p.keyChange.reason,
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
      await this.repo.update(
        { workspaceId, id: row.id },
        {
          externalRef: row.externalRef,
          externalUrl: row.externalUrl,
          updatedAt: row.updatedAt,
        },
      );
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
    const updated = await this.hideInvisibleParent(
      workspaceId,
      await this.get(workspaceId, row.id),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.updated',
      subject: { type: 'issue', id: updated.id },
      data: {
        key: updated.key,
        fields: ['externalRef'],
        external: ref
          ? { provider: ref.provider, key: ref.key, origin: ref.origin }
          : null,
      },
    });
    return updated;
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
    await this.repo.update(
      { workspaceId, id: row.id },
      { externalRef: row.externalRef },
    );
    const updated = await this.hideInvisibleParent(
      workspaceId,
      await this.get(workspaceId, row.id),
    );
    this.events.publish(workspaceId, {
      type: 'updated',
      entity: 'issue',
      id: updated.id,
    });
    return updated;
  }

  async remove(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    authorize: IssueTeamAuthorizer,
  ) {
    const row = await this.get(workspaceId, idOrKey);
    let lost: string[] = [];
    const { removed: [removed], detached } = await this.ds.transaction(async (manager) =>
      this.deleteRows(manager, workspaceId, [row.id], idOrKey, authorize, async (targets) => {
        const target = targets[0];
        lost =
          (await this.uploads?.idsLostWith(workspaceId, { issueId: target.id }, [
            target.body,
          ])) ?? [];
      }),
    );
    await this.uploads?.releaseIds(workspaceId, lost);
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.deleted',
      subject: { type: 'issue', id: removed.id },
      data: { key: removed.key, title: removed.title },
    });
    for (const issue of detached)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.updated',
        subject: { type: 'issue', id: issue.id },
        data: { key: issue.key, fields: ['parentId'] },
      });
  }

  /**
   * Delete many issues in one transaction. Authorize every parent/child whose relationship will
   * change while the workspace hierarchy and affected issue rows are locked.
   */
  async removeMany(
    workspaceId: string,
    actor: ActorRef,
    rows: readonly IssueEntity[],
    authorize: IssueTeamAuthorizer,
  ) {
    const ids = rows.map((r) => r.id);
    if (!ids.length) return;
    const { removed, detached } = await this.ds.transaction((manager) =>
      this.deleteRows(manager, workspaceId, ids, ids[0], authorize),
    );
    for (const row of removed)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.deleted',
        subject: { type: 'issue', id: row.id },
        data: { key: row.key, title: row.title },
      });
    for (const issue of detached)
      await this.events.record({
        workspaceId,
        actor,
        type: 'issue.updated',
        subject: { type: 'issue', id: issue.id },
        data: { key: issue.key, fields: ['parentId'] },
      });
  }

  private async deleteRows(
    manager: EntityManager,
    workspaceId: string,
    ids: readonly string[],
    issueRef: string,
    authorize: IssueTeamAuthorizer,
    beforeDelete?: (targets: readonly IssueEntity[]) => Promise<void>,
  ): Promise<{ removed: IssueEntity[]; detached: IssueEntity[] }> {
    await this.lockIssueHierarchy(manager, workspaceId);
    const targetRelations = (await manager.query(
      `SELECT "id", "parentId" FROM "issues" WHERE "workspaceId" = $1 AND "id" = ANY($2::varchar[])`,
      [workspaceId, ids],
    )) as Pick<IssueEntity, 'id' | 'parentId'>[];
    if (targetRelations.length !== ids.length)
      throw notFound('Issue', issueRef);

    const parentIds = unique(
      targetRelations.flatMap((target) =>
        target.parentId ? [target.parentId] : [],
      ),
    );
    const affected = (await manager.query(
      `SELECT * FROM "issues"
       WHERE "workspaceId" = $1
         AND ("id" = ANY($2::varchar[]) OR "parentId" = ANY($2::varchar[]) OR "id" = ANY($3::varchar[]))
       ORDER BY "id" FOR UPDATE`,
      [workspaceId, ids, parentIds],
    )) as IssueEntity[];
    const targetIds = new Set(ids);
    const targets = affected.filter((issue) => targetIds.has(issue.id));
    if (targets.length !== ids.length) throw notFound('Issue', issueRef);
    const observedParentById = new Map(
      targetRelations.map((target) => [target.id, target.parentId]),
    );
    if (targets.some((target) => observedParentById.get(target.id) !== target.parentId))
      throw new ConflictException('Issue hierarchy changed; retry the delete');
    if (affected.some((issue) => projectHidden(currentAccess(), issue.projectId)))
      throw notFound('Issue', issueRef);

    await authorize(affected);
    await beforeDelete?.(targets);
    const detached = affected.filter(
      (issue) => !!issue.parentId && targetIds.has(issue.parentId) && !targetIds.has(issue.id),
    );
    if (detached.length) {
      const updatedAt = new Date();
      await manager.update(
        IssueEntity,
        { workspaceId, id: In(detached.map((issue) => issue.id)) },
        { parentId: null, updatedAt },
      );
      for (const issue of detached) {
        issue.parentId = null;
        issue.updatedAt = updatedAt;
      }
    }
    await manager.query(
      `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`,
      [workspaceId, ids],
    );
    await manager.query(
      `UPDATE "issues" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = ANY($2)`,
      [workspaceId, ids],
    );
    await manager.delete(IssueEntity, { workspaceId, id: In([...ids]) });
    return { removed: targets, detached };
  }
}
