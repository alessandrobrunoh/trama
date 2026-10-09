import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import {
  isDeltaThreadUrl,
  type AcceptanceCriterion,
  type ActorRef,
  type CriterionState,
  type Priority,
  type WorkstreamStatus,
} from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { isUniqueViolation, notFound, toDate, uid, unique } from '../common/util.js';
import { pruneIssueMilestones } from '../milestones/milestone-scope.js';
import { TeamEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { LabelsService } from '../workspaces/labels.service.js';

export interface CriterionInput {
  id?: string;
  text: string;
  state?: CriterionState;
}

export interface WorkstreamInput {
  title?: string;
  description?: string | null;
  objective?: string;
  context?: string | null;
  deltaThreadUrl?: string;
  ownerTeamId?: string;
  participatingTeamIds?: string[];
  accountableUserId?: string | null;
  projectId?: string | null;
  repositoryIds?: string[];
  acceptanceCriteria?: CriterionInput[];
  priority?: Priority;
  labels?: string[];
  statusOverride?: WorkstreamStatus | null;
  startDate?: string | null;
  targetDate?: string | null;
}

export interface WorkstreamFilter {
  status?: WorkstreamStatus;
  ownerTeamId?: string;
  teamId?: string;
  accountableUserId?: string;
  priority?: Priority;
  projectId?: string;
  repositoryId?: string;
  label?: string;
  q?: string;
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function criteria(items: CriterionInput[] | undefined): AcceptanceCriterion[] {
  return (items ?? []).map((c) => ({
    id: c.id ?? uid('ac'),
    text: c.text.trim(),
    state: c.state ?? 'pending',
  }));
}

@Injectable()
export class WorkstreamsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly counters: CountersService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    private readonly labels: LabelsService,
    @InjectRepository(WorkstreamEntity)
    private readonly repo: Repository<WorkstreamEntity>,
  ) {}

  list(workspaceId: string, f: WorkstreamFilter = {}) {
    const qb = this.repo
      .createQueryBuilder('w')
      .where('w.workspaceId = :workspaceId', { workspaceId })
      .orderBy('w.updatedAt', 'DESC');
    if (f.status) qb.andWhere('w.status = :status', { status: f.status });
    if (f.ownerTeamId)
      qb.andWhere('w.ownerTeamId = :ot', { ot: f.ownerTeamId });
    if (f.teamId)
      qb.andWhere(
        `(w.ownerTeamId = :tid OR w.participatingTeamIds @> :tidj::jsonb)`,
        {
          tid: f.teamId,
          tidj: JSON.stringify([f.teamId]),
        },
      );
    if (f.accountableUserId)
      qb.andWhere('w.accountableUserId = :au', { au: f.accountableUserId });
    if (f.priority) qb.andWhere('w.priority = :p', { p: f.priority });
    if (f.projectId) qb.andWhere('w.projectId = :pid', { pid: f.projectId });
    if (f.repositoryId)
      qb.andWhere('w.repositoryIds @> :rid::jsonb', {
        rid: JSON.stringify([f.repositoryId]),
      });
    if (f.label)
      qb.andWhere('w.labels @> :lb::jsonb', { lb: JSON.stringify([f.label]) });
    if (f.q)
      qb.andWhere('(w.title ILIKE :q OR w.key ILIKE :q)', { q: `%${f.q}%` });
    return qb.getMany();
  }

  /** `idOrKey`: a workstream id (`wk_…`) or a key (`AUTH-42`, case-insensitive). */
  async get(
    workspaceId: string,
    idOrKey: string,
    manager?: EntityManager,
  ): Promise<WorkstreamEntity> {
    const repo = manager ? manager.getRepository(WorkstreamEntity) : this.repo;
    const row = await repo.findOne({
      where: KEY_RE.test(idOrKey)
        ? { workspaceId, key: idOrKey.toUpperCase() }
        : { workspaceId, id: idOrKey },
    });
    if (!row) throw notFound('Workstream', idOrKey);
    return row;
  }

  /**
   * Creates a workstream; its key is `${ownerTeam.key}-${n}` with `n` from the
   * counter of that team key (not of the team row, so it survives deleting and
   * recreating a team) and always above the highest number the key already uses
   * (a workstream keeps its key when another team takes it over). Pass `manager` to run inside a caller transaction
   * (linking an issue); events/bus then fire after the caller commits via the
   * returned `after()` callback — when no manager is passed they fire here.
   */
  async create(
    workspaceId: string,
    actor: ActorRef,
    input: WorkstreamInput & {
      title: string;
      ownerTeamId: string;
    },
    options: { manager?: EntityManager; data?: Record<string, unknown> } = {},
  ): Promise<WorkstreamEntity & { after?: () => Promise<void> }> {
    await this.refs.teams(workspaceId, [
      input.ownerTeamId,
      ...(input.participatingTeamIds ?? []),
    ]);
    await this.refs.users(workspaceId, [input.accountableUserId]);
    await this.refs.repositories(workspaceId, input.repositoryIds);
    // A workstream of a project works in the project's repositories: inherit them unless it names some.
    let repositoryIds = unique(input.repositoryIds);
    if (input.projectId) {
      const project = await this.refs.projectRepositories(workspaceId, input.projectId, repositoryIds);
      if (input.repositoryIds === undefined) repositoryIds = [...project.repositoryIds];
    }
    // The Delta thread is optional: a workstream can exist before any execution thread does ("Delta-first,
    // not Delta-dependent"). A supplied URL is always validated.
    const deltaThreadUrl = optionalDeltaThreadUrl(input.deltaThreadUrl);
    const run = async (m: EntityManager) => {
      const team = await m.findOneByOrFail(TeamEntity, {
        id: input.ownerTeamId,
        workspaceId,
      });
      const [{ top }] = await m.query<{ top: number }[]>(
        `SELECT COALESCE(MAX("number"), 0)::int AS top FROM "workstreams" WHERE "workspaceId" = $1 AND "key" LIKE $2`,
        [workspaceId, `${team.key}-%`],
      );
      const number = await this.counters.nextAbove(m, workspaceId, `wskey:${team.key}`, top);
      const acceptanceCriteria = criteria(input.acceptanceCriteria);
      const derived: WorkstreamStatus = acceptanceCriteria.length
        ? 'planned'
        : 'draft';
      return m.save(
        m.create(WorkstreamEntity, {
          id: uid('wk'),
          workspaceId,
          key: `${team.key}-${number}`,
          number,
          title: input.title.trim(),
          description: input.description?.trim() || null,
          objective: input.objective ?? '',
          context: input.context ?? null,
          deltaThreadUrl,
          ownerTeamId: team.id,
          participatingTeamIds: unique(input.participatingTeamIds).filter(
            (t) => t !== team.id,
          ),
          accountableUserId: input.accountableUserId ?? null,
          projectId: input.projectId ?? null,
          repositoryIds,
          acceptanceCriteria,
          priority: input.priority ?? 'none',
          labels: (await this.labels.assign(workspaceId, input.labels)) ?? [],
          derivedStatus: derived,
          statusOverride: input.statusOverride ?? null,
          status: input.statusOverride ?? derived,
          startDate:
            (toDate(input.startDate) as Date | null | undefined) ?? null,
          targetDate:
            (toDate(input.targetDate) as Date | null | undefined) ?? null,
          createdById: actor.id ?? 'system',
        }),
      );
    };
    const after = async (row: WorkstreamEntity) => {
      await this.events.record({
        workspaceId,
        actor,
        type: 'workstream.created',
        subject: { type: 'workstream', id: row.id },
        workstreamId: row.id,
        data: { key: row.key, title: row.title, ...options.data },
      });
      await this.bus.touch(workspaceId, row.id, 'workstream.created');
    };
    // Allocation cannot collide, but a unique violation (key or anything else racing) is a 409, not a 500.
    const guarded = async (m: EntityManager) => {
      try {
        return await run(m);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Workstream key already exists; retry');
        throw e;
      }
    };
    if (options.manager) {
      const row = await guarded(options.manager);
      return Object.assign(row, { after: () => after(row) });
    }
    const row = await this.ds.transaction(guarded);
    await after(row);
    return row;
  }

  async update(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    patch: WorkstreamInput,
  ) {
    const ws = await this.get(workspaceId, idOrKey);
    if (patch.ownerTeamId !== undefined)
      await this.refs.teams(workspaceId, [patch.ownerTeamId]);
    await this.refs.teams(workspaceId, patch.participatingTeamIds);
    await this.refs.users(workspaceId, [patch.accountableUserId]);
    await this.refs.repositories(workspaceId, patch.repositoryIds);
    const projectId = patch.projectId !== undefined ? patch.projectId : ws.projectId;
    if (projectId && (patch.projectId !== undefined || patch.repositoryIds !== undefined))
      await this.refs.projectRepositories(workspaceId, projectId, patch.repositoryIds ?? ws.repositoryIds);
    const changed: string[] = [];
    const set = <K extends keyof WorkstreamEntity>(
      k: K,
      v: WorkstreamEntity[K],
    ) => {
      if (JSON.stringify(ws[k]) !== JSON.stringify(v)) {
        ws[k] = v;
        changed.push(k);
      }
    };
    if (patch.title !== undefined) set('title', patch.title.trim());
    if (patch.description !== undefined)
      set('description', patch.description?.trim() || null);
    if (patch.objective !== undefined) set('objective', patch.objective);
    if (patch.context !== undefined) set('context', patch.context);
    if (patch.deltaThreadUrl !== undefined)
      set('deltaThreadUrl', optionalDeltaThreadUrl(patch.deltaThreadUrl));
    // NOTE: changing the owner team does NOT rename the workstream: the key stays (AUTH-42 remains AUTH-42).
    if (patch.ownerTeamId !== undefined) set('ownerTeamId', patch.ownerTeamId);
    if (patch.participatingTeamIds !== undefined)
      set(
        'participatingTeamIds',
        unique(patch.participatingTeamIds).filter((t) => t !== ws.ownerTeamId),
      );
    if (patch.accountableUserId !== undefined)
      set('accountableUserId', patch.accountableUserId);
    if (patch.projectId !== undefined) set('projectId', patch.projectId);
    if (patch.repositoryIds !== undefined)
      set('repositoryIds', unique(patch.repositoryIds));
    if (patch.acceptanceCriteria !== undefined)
      set('acceptanceCriteria', criteria(patch.acceptanceCriteria));
    if (patch.priority !== undefined) set('priority', patch.priority);
    if (patch.labels !== undefined) set('labels', (await this.labels.assign(workspaceId, patch.labels)) ?? []);
    if (patch.startDate !== undefined)
      set('startDate', (toDate(patch.startDate) as Date | null) ?? null);
    if (patch.targetDate !== undefined)
      set('targetDate', (toDate(patch.targetDate) as Date | null) ?? null);
    if (patch.statusOverride !== undefined) {
      set('statusOverride', patch.statusOverride);
      ws.status = ws.statusOverride ?? ws.derivedStatus;
    }
    if (!changed.length) return ws;
    ws.updatedAt = new Date();
    await this.repo.save(ws);
    if (changed.includes('projectId')) await this.dropStaleMilestones(workspaceId, ws.id);
    await this.events.record({
      workspaceId,
      actor,
      type: 'workstream.updated',
      subject: { type: 'workstream', id: ws.id },
      workstreamId: ws.id,
      data: { key: ws.key, fields: changed },
    });
    await this.bus.touch(workspaceId, ws.id, 'workstream.updated');
    return this.get(workspaceId, ws.id);
  }

  async remove(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const ws = await this.get(workspaceId, idOrKey);
    let linked: string[] = [];
    let waiting: string[] = [];
    await this.ds.transaction(async (m) => {
      const ids = (
        await m.query<{ id: string }[]>(
          `SELECT "id" FROM "artifacts" WHERE "workstreamId" = $1 AND "projectId" IS NULL AND "issueId" IS NULL
           UNION SELECT "id" FROM "input_requests" WHERE "workstreamId" = $1`,
          [ws.id],
        )
      ).map((r) => r.id);
      ids.push(ws.id);
      // Workstreams that waited on this one (or on its artifacts / input requests) must be re-derived.
      waiting = (
        await m.query<{ toId: string }[]>(
          `SELECT DISTINCT "toId" FROM "dependencies" WHERE "workspaceId" = $1 AND "toType" = 'workstream' AND "fromId" = ANY($2)`,
          [workspaceId, ids],
        )
      )
        .map((r) => r.toId)
        .filter((id) => id !== ws.id);
      await m.query(
        `DELETE FROM "dependencies" WHERE "workspaceId" = $1 AND ("fromId" = ANY($2) OR "toId" = ANY($2))`,
        [workspaceId, ids],
      );
      await m.query(
        `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`,
        [workspaceId, ids],
      );
      linked = (
        await m.query<{ id: string }[]>(
          `SELECT "id" FROM "issues" WHERE "workspaceId" = $1 AND "workstreamIds" ? $2::text`,
          [workspaceId, ws.id],
        )
      ).map((r) => r.id);
      await m.query(
        `UPDATE "issues" SET "workstreamIds" = "workstreamIds" - $2::text WHERE "workspaceId" = $1 AND "workstreamIds" ? $2::text`,
        [workspaceId, ws.id],
      );
      // The project's milestones only stay on issues that still have a workstream in that project.
      await pruneIssueMilestones(m, workspaceId, linked);
      await m.query(
        `UPDATE "decisions" SET "relatedWorkstreamIds" = "relatedWorkstreamIds" - $2::text WHERE "workspaceId" = $1 AND "relatedWorkstreamIds" ? $2::text`,
        [workspaceId, ws.id],
      );
      await m.delete(WorkstreamEntity, { id: ws.id });
    });
    await this.events.record({
      workspaceId,
      actor,
      type: 'workstream.deleted',
      subject: { type: 'workstream', id: ws.id },
      data: { key: ws.key, title: ws.title },
    });
    for (const id of linked.slice(0, 200)) this.events.publish(workspaceId, { type: 'updated', entity: 'issue', id });
    if (waiting.length) await this.bus.touchMany(workspaceId, waiting, 'workstream.deleted');
  }

  /** Leaving (or switching) a project drops its milestones from this workstream's issues that no longer qualify. */
  private async dropStaleMilestones(workspaceId: string, workstreamId: string) {
    const issues = await this.ds.query<{ id: string }[]>(
      `SELECT "id" FROM "issues" WHERE "workspaceId" = $1 AND "workstreamIds" ? $2::text AND jsonb_array_length("milestoneIds") > 0`,
      [workspaceId, workstreamId],
    );
    const changed = await this.ds.transaction((m) =>
      pruneIssueMilestones(m, workspaceId, issues.map((r) => r.id)),
    );
    for (const id of changed.slice(0, 200)) this.events.publish(workspaceId, { type: 'updated', entity: 'issue', id });
  }

  // ───────── acceptance criteria

  async addCriterion(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    input: CriterionInput,
  ) {
    const ws = await this.get(workspaceId, idOrKey);
    const criterion: AcceptanceCriterion = {
      id: uid('ac'),
      text: input.text.trim(),
      state: input.state ?? 'pending',
    };
    ws.acceptanceCriteria = [...ws.acceptanceCriteria, criterion];
    return this.saveCriteria(ws, actor, 'added', criterion);
  }

  async updateCriterion(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    criterionId: string,
    patch: Partial<CriterionInput>,
  ) {
    const ws = await this.get(workspaceId, idOrKey);
    const current = ws.acceptanceCriteria.find((c) => c.id === criterionId);
    if (!current) throw notFound('Criterion', criterionId);
    const next: AcceptanceCriterion = {
      ...current,
      ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
    };
    ws.acceptanceCriteria = ws.acceptanceCriteria.map((c) =>
      c.id === criterionId ? next : c,
    );
    return this.saveCriteria(ws, actor, 'updated', next, current.state);
  }

  async removeCriterion(
    workspaceId: string,
    actor: ActorRef,
    idOrKey: string,
    criterionId: string,
  ) {
    const ws = await this.get(workspaceId, idOrKey);
    const current = ws.acceptanceCriteria.find((c) => c.id === criterionId);
    if (!current) throw notFound('Criterion', criterionId);
    ws.acceptanceCriteria = ws.acceptanceCriteria.filter(
      (c) => c.id !== criterionId,
    );
    return this.saveCriteria(ws, actor, 'removed', current);
  }

  private async saveCriteria(
    ws: WorkstreamEntity,
    actor: ActorRef,
    change: 'added' | 'updated' | 'removed',
    criterion: AcceptanceCriterion,
    previousState?: CriterionState,
  ) {
    if (ws.acceptanceCriteria.length > 50)
      throw new BadRequestException('At most 50 acceptance criteria');
    ws.updatedAt = new Date();
    await this.repo.save(ws);
    await this.events.record(
      {
        workspaceId: ws.workspaceId,
        actor,
        type: 'criterion.updated',
        subject: { type: 'workstream', id: ws.id },
        workstreamId: ws.id,
        data: {
          change,
          criterionId: criterion.id,
          text: criterion.text,
          state: criterion.state,
          previousState,
        },
      },
      { type: 'updated', entity: 'workstream', id: ws.id },
    );
    await this.bus.touch(ws.workspaceId, ws.id, 'criterion.updated');
    return this.get(ws.workspaceId, ws.id);
  }
}

/** Empty means "no thread (yet)"; anything else must be a Delta thread link. */
export function optionalDeltaThreadUrl(value: string | null | undefined): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return '';
  if (!isDeltaThreadUrl(url)) {
    throw new BadRequestException(
      'deltaThreadUrl must be an https link on delta.dev',
    );
  }
  return url;
}
