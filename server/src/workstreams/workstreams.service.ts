import { BadRequestException, Injectable } from '@nestjs/common';
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
import { notFound, toDate, uid, unique } from '../common/util.js';
import { TeamEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

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
  repositoryIds?: string[];
  acceptanceCriteria?: CriterionInput[];
  priority?: Priority;
  labels?: string[];
  statusOverride?: 'draft' | 'canceled' | null;
  targetDate?: string | null;
}

export interface WorkstreamFilter {
  status?: WorkstreamStatus;
  ownerTeamId?: string;
  teamId?: string;
  accountableUserId?: string;
  priority?: Priority;
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
    @InjectRepository(WorkstreamEntity) private readonly repo: Repository<WorkstreamEntity>,
  ) {}

  list(workspaceId: string, f: WorkstreamFilter = {}) {
    const qb = this.repo
      .createQueryBuilder('w')
      .where('w.workspaceId = :workspaceId', { workspaceId })
      .orderBy('w.updatedAt', 'DESC');
    if (f.status) qb.andWhere('w.status = :status', { status: f.status });
    if (f.ownerTeamId) qb.andWhere('w.ownerTeamId = :ot', { ot: f.ownerTeamId });
    if (f.teamId)
      qb.andWhere(`(w.ownerTeamId = :tid OR w.participatingTeamIds @> :tidj::jsonb)`, {
        tid: f.teamId,
        tidj: JSON.stringify([f.teamId]),
      });
    if (f.accountableUserId) qb.andWhere('w.accountableUserId = :au', { au: f.accountableUserId });
    if (f.priority) qb.andWhere('w.priority = :p', { p: f.priority });
    if (f.repositoryId)
      qb.andWhere('w.repositoryIds @> :rid::jsonb', { rid: JSON.stringify([f.repositoryId]) });
    if (f.label) qb.andWhere('w.labels @> :lb::jsonb', { lb: JSON.stringify([f.label]) });
    if (f.q) qb.andWhere('(w.title ILIKE :q OR w.key ILIKE :q)', { q: `%${f.q}%` });
    return qb.getMany();
  }

  /** `idOrKey`: a workstream id (`wk_…`) or a key (`AUTH-42`, case-insensitive). */
  async get(workspaceId: string, idOrKey: string, manager?: EntityManager): Promise<WorkstreamEntity> {
    const repo = manager ? manager.getRepository(WorkstreamEntity) : this.repo;
    const row = await repo.findOne({
      where: KEY_RE.test(idOrKey) ? { workspaceId, key: idOrKey.toUpperCase() } : { workspaceId, id: idOrKey },
    });
    if (!row) throw notFound('Workstream', idOrKey);
    return row;
  }

  /**
   * Creates a workstream; its key is `${ownerTeam.key}-${n}` with `n` from the
   * owner team's counter. Pass `manager` to run inside a caller transaction
   * (linking an issue); events/bus then fire after the caller commits via the
   * returned `after()` callback — when no manager is passed they fire here.
   */
  async create(
    workspaceId: string,
    actor: ActorRef,
    input: WorkstreamInput & { title: string; ownerTeamId: string; deltaThreadUrl: string },
    options: { manager?: EntityManager; data?: Record<string, unknown> } = {},
  ): Promise<WorkstreamEntity & { after?: () => Promise<void> }> {
    await this.refs.teams(workspaceId, [input.ownerTeamId, ...(input.participatingTeamIds ?? [])]);
    await this.refs.users(workspaceId, [input.accountableUserId]);
    await this.refs.repositories(workspaceId, input.repositoryIds);
    const deltaThreadUrl = assertDeltaThreadUrl(input.deltaThreadUrl);
    const run = async (m: EntityManager) => {
      const team = await m.findOneByOrFail(TeamEntity, { id: input.ownerTeamId, workspaceId });
      const number = await this.counters.next(m, workspaceId, `ws:${team.id}`);
      const acceptanceCriteria = criteria(input.acceptanceCriteria);
      const derived: WorkstreamStatus = acceptanceCriteria.length ? 'planned' : 'draft';
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
          participatingTeamIds: unique(input.participatingTeamIds).filter((t) => t !== team.id),
          accountableUserId: input.accountableUserId ?? null,
          repositoryIds: unique(input.repositoryIds),
          acceptanceCriteria,
          priority: input.priority ?? 'none',
          labels: unique(input.labels),
          derivedStatus: derived,
          statusOverride: input.statusOverride ?? null,
          status: input.statusOverride ?? derived,
          targetDate: (toDate(input.targetDate) as Date | null | undefined) ?? null,
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
    if (options.manager) {
      const row = await run(options.manager);
      return Object.assign(row, { after: () => after(row) });
    }
    const row = await this.ds.transaction(run);
    await after(row);
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: WorkstreamInput) {
    const ws = await this.get(workspaceId, idOrKey);
    if (patch.ownerTeamId !== undefined) await this.refs.teams(workspaceId, [patch.ownerTeamId]);
    await this.refs.teams(workspaceId, patch.participatingTeamIds);
    await this.refs.users(workspaceId, [patch.accountableUserId]);
    await this.refs.repositories(workspaceId, patch.repositoryIds);
    const changed: string[] = [];
    const set = <K extends keyof WorkstreamEntity>(k: K, v: WorkstreamEntity[K]) => {
      if (JSON.stringify(ws[k]) !== JSON.stringify(v)) {
        ws[k] = v;
        changed.push(k);
      }
    };
    if (patch.title !== undefined) set('title', patch.title.trim());
    if (patch.description !== undefined) set('description', patch.description?.trim() || null);
    if (patch.objective !== undefined) set('objective', patch.objective);
    if (patch.context !== undefined) set('context', patch.context);
    if (patch.deltaThreadUrl !== undefined) set('deltaThreadUrl', assertDeltaThreadUrl(patch.deltaThreadUrl));
    // NOTE: changing the owner team does NOT rename the workstream: the key stays (AUTH-42 remains AUTH-42).
    if (patch.ownerTeamId !== undefined) set('ownerTeamId', patch.ownerTeamId);
    if (patch.participatingTeamIds !== undefined)
      set('participatingTeamIds', unique(patch.participatingTeamIds).filter((t) => t !== ws.ownerTeamId));
    if (patch.accountableUserId !== undefined) set('accountableUserId', patch.accountableUserId);
    if (patch.repositoryIds !== undefined) set('repositoryIds', unique(patch.repositoryIds));
    if (patch.acceptanceCriteria !== undefined) set('acceptanceCriteria', criteria(patch.acceptanceCriteria));
    if (patch.priority !== undefined) set('priority', patch.priority);
    if (patch.labels !== undefined) set('labels', unique(patch.labels));
    if (patch.targetDate !== undefined)
      set('targetDate', (toDate(patch.targetDate) as Date | null) ?? null);
    if (patch.statusOverride !== undefined) {
      set('statusOverride', patch.statusOverride);
      ws.status = ws.statusOverride ?? ws.derivedStatus;
    }
    if (!changed.length) return ws;
    ws.updatedAt = new Date();
    await this.repo.save(ws);
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
    await this.ds.transaction(async (m) => {
      const ids = (
        await m.query<{ id: string }[]>(
          `SELECT "id" FROM "artifacts" WHERE "workstreamId" = $1
           UNION SELECT "id" FROM "input_requests" WHERE "workstreamId" = $1`,
          [ws.id],
        )
      ).map((r) => r.id);
      ids.push(ws.id);
      await m.query(`DELETE FROM "dependencies" WHERE "workspaceId" = $1 AND ("fromId" = ANY($2) OR "toId" = ANY($2))`, [workspaceId, ids]);
      await m.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`, [workspaceId, ids]);
      await m.query(
        `UPDATE "issues" SET "workstreamIds" = "workstreamIds" - $2::text WHERE "workspaceId" = $1 AND "workstreamIds" ? $2::text`,
        [workspaceId, ws.id],
      );
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
  }

  // ───────── acceptance criteria

  async addCriterion(workspaceId: string, actor: ActorRef, idOrKey: string, input: CriterionInput) {
    const ws = await this.get(workspaceId, idOrKey);
    const criterion: AcceptanceCriterion = { id: uid('ac'), text: input.text.trim(), state: input.state ?? 'pending' };
    ws.acceptanceCriteria = [...ws.acceptanceCriteria, criterion];
    return this.saveCriteria(ws, actor, 'added', criterion);
  }

  async updateCriterion(workspaceId: string, actor: ActorRef, idOrKey: string, criterionId: string, patch: Partial<CriterionInput>) {
    const ws = await this.get(workspaceId, idOrKey);
    const current = ws.acceptanceCriteria.find((c) => c.id === criterionId);
    if (!current) throw notFound('Criterion', criterionId);
    const next: AcceptanceCriterion = {
      ...current,
      ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
    };
    ws.acceptanceCriteria = ws.acceptanceCriteria.map((c) => (c.id === criterionId ? next : c));
    return this.saveCriteria(ws, actor, 'updated', next, current.state);
  }

  async removeCriterion(workspaceId: string, actor: ActorRef, idOrKey: string, criterionId: string) {
    const ws = await this.get(workspaceId, idOrKey);
    const current = ws.acceptanceCriteria.find((c) => c.id === criterionId);
    if (!current) throw notFound('Criterion', criterionId);
    ws.acceptanceCriteria = ws.acceptanceCriteria.filter((c) => c.id !== criterionId);
    return this.saveCriteria(ws, actor, 'removed', current);
  }

  private async saveCriteria(
    ws: WorkstreamEntity,
    actor: ActorRef,
    change: 'added' | 'updated' | 'removed',
    criterion: AcceptanceCriterion,
    previousState?: CriterionState,
  ) {
    if (ws.acceptanceCriteria.length > 50) throw new BadRequestException('At most 50 acceptance criteria');
    ws.updatedAt = new Date();
    await this.repo.save(ws);
    await this.events.record(
      {
        workspaceId: ws.workspaceId,
        actor,
        type: 'criterion.updated',
        subject: { type: 'workstream', id: ws.id },
        workstreamId: ws.id,
        data: { change, criterionId: criterion.id, text: criterion.text, state: criterion.state, previousState },
      },
      { type: 'updated', entity: 'workstream', id: ws.id },
    );
    await this.bus.touch(ws.workspaceId, ws.id, 'criterion.updated');
    return this.get(ws.workspaceId, ws.id);
  }
}

function assertDeltaThreadUrl(value: string): string {
  const url = value.trim();
  if (!isDeltaThreadUrl(url)) {
    throw new BadRequestException('deltaThreadUrl must be an https link on delta.dev');
  }
  return url;
}
