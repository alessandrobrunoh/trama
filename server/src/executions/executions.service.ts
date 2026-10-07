import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import {
  TERMINAL_EXECUTION_STATES,
  type ActorRef,
  type ExecutionProvider,
  type ExecutionState,
} from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { AgentEntity, ExecutionEntity, WorkstreamEntity } from '../database/entities/index.js';
import { DependenciesService } from '../dependencies/dependencies.service.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

export interface ExecutionInput {
  workstreamId?: string;
  parentExecutionId?: string | null;
  title?: string;
  description?: string | null;
  teamId?: string | null;
  repositoryIds?: string[];
  performers?: ActorRef[];
  provider?: ExecutionProvider;
  state?: ExecutionState;
  dependsOnExecutionIds?: string[];
  sessionUrl?: string | null;
  branch?: string | null;
  progressNote?: string | null;
}

export interface ExecutionFilter {
  workstreamId?: string;
  state?: ExecutionState;
  parentExecutionId?: string;
  teamId?: string;
}

const isTerminal = (s: ExecutionState) => TERMINAL_EXECUTION_STATES.includes(s);

@Injectable()
export class ExecutionsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    private readonly deps: DependenciesService,
    @InjectRepository(ExecutionEntity) private readonly repo: Repository<ExecutionEntity>,
  ) {}

  /** Fills `dependsOnExecutionIds` (derived from the dependencies table). */
  async attach<T extends ExecutionEntity | ExecutionEntity[]>(workspaceId: string, rows: T): Promise<T> {
    const list = Array.isArray(rows) ? rows : [rows];
    const map = await this.deps.executionDeps(workspaceId, list.map((r) => r.id));
    for (const r of list) r.dependsOnExecutionIds = map.get(r.id) ?? [];
    return rows;
  }

  async list(workspaceId: string, f: ExecutionFilter = {}) {
    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.workspaceId = :workspaceId', { workspaceId })
      .orderBy('e.createdAt', 'ASC');
    if (f.workstreamId) qb.andWhere('e.workstreamId = :w', { w: f.workstreamId });
    if (f.state) qb.andWhere('e.state = :s', { s: f.state });
    if (f.parentExecutionId) qb.andWhere('e.parentExecutionId = :p', { p: f.parentExecutionId });
    if (f.teamId) qb.andWhere('e.teamId = :t', { t: f.teamId });
    return this.attach(workspaceId, await qb.getMany());
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Execution', id);
    return this.attach(workspaceId, row);
  }

  private async validate(workspaceId: string, input: ExecutionInput) {
    if (input.teamId) await this.refs.teams(workspaceId, [input.teamId]);
    await this.refs.repositories(workspaceId, input.repositoryIds);
    await this.refs.executions(workspaceId, input.dependsOnExecutionIds);
    for (const p of input.performers ?? []) {
      if (!p.id) throw new BadRequestException('performers need an id');
      if (p.type === 'user') await this.refs.users(workspaceId, [p.id]);
      else if (p.type === 'team') await this.refs.teams(workspaceId, [p.id]);
      else if (p.type === 'agent') {
        if (!(await this.ds.getRepository(AgentEntity).existsBy({ id: p.id, workspaceId })))
          throw new BadRequestException(`Unknown agent "${p.id}"`);
      } else throw new BadRequestException('performer type must be user, agent or team');
    }
  }

  private async inferProvider(performers: ActorRef[]): Promise<ExecutionProvider> {
    const agentId = performers.find((p) => p.type === 'agent')?.id;
    if (!agentId) return 'human';
    const agent = await this.ds.getRepository(AgentEntity).findOneBy({ id: agentId });
    return agent?.provider ?? 'other';
  }

  async create(workspaceId: string, actor: ActorRef, input: ExecutionInput & { workstreamId: string; title: string }) {
    const ws = await this.ds.getRepository(WorkstreamEntity).findOneBy({ id: input.workstreamId, workspaceId });
    if (!ws) throw new BadRequestException(`Unknown workstream "${input.workstreamId}"`);
    await this.validate(workspaceId, input);
    if (input.parentExecutionId) {
      const parent = await this.repo.findOneBy({ id: input.parentExecutionId, workspaceId });
      if (!parent || parent.workstreamId !== input.workstreamId)
        throw new BadRequestException('parentExecutionId must be an execution of the same workstream');
    }
    const performers = input.performers ?? (actor.id && actor.type !== 'system' ? [actor] : []);
    const state = input.state ?? 'queued';
    const row = await this.repo.save(
      this.repo.create({
        id: uid('ex'),
        workspaceId,
        workstreamId: input.workstreamId,
        parentExecutionId: input.parentExecutionId ?? null,
        title: input.title.trim(),
        description: input.description ?? null,
        teamId: input.teamId ?? null,
        repositoryIds: unique(input.repositoryIds),
        performers,
        provider: input.provider ?? (await this.inferProvider(performers)),
        state,
        sessionUrl: input.sessionUrl ?? null,
        branch: input.branch ?? null,
        progressNote: input.progressNote ?? null,
        startedAt: state === 'queued' ? null : new Date(),
        completedAt: isTerminal(state) ? new Date() : null,
      }),
    );
    if (input.dependsOnExecutionIds?.length) {
      try {
        await this.deps.syncExecutionDeps(workspaceId, actor, row.id, unique(input.dependsOnExecutionIds));
      } catch (error) {
        await this.repo.delete({ id: row.id });
        throw error;
      }
    }
    await this.events.record({
      workspaceId,
      actor,
      type: 'execution.created',
      subject: { type: 'execution', id: row.id },
      workstreamId: row.workstreamId,
      data: { title: row.title, provider: row.provider, state: row.state },
    });
    await this.bus.touch(workspaceId, row.workstreamId, 'execution.created');
    return this.get(workspaceId, row.id);
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: ExecutionInput) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Execution', id);
    await this.validate(workspaceId, patch);
    if (patch.parentExecutionId) {
      let cursor: string | null = patch.parentExecutionId;
      for (let depth = 0; cursor && depth < 100; depth++) {
        if (cursor === id) throw new BadRequestException('An execution cannot be its own ancestor');
        const parent: ExecutionEntity | null = await this.repo.findOneBy({ id: cursor, workspaceId });
        if (!parent) throw new BadRequestException('Unknown parentExecutionId');
        if (!parent.parentExecutionId && parent.workstreamId !== row.workstreamId)
          throw new BadRequestException('parentExecutionId must be an execution of the same workstream');
        cursor = parent.parentExecutionId;
      }
    }
    const fields: string[] = [];
    const fromState = row.state;
    const set = (k: keyof ExecutionEntity, v: unknown) => {
      if (JSON.stringify(row[k]) !== JSON.stringify(v)) {
        (row as unknown as Record<string, unknown>)[k] = v;
        fields.push(k);
      }
    };
    if (patch.title !== undefined) set('title', patch.title.trim());
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.teamId !== undefined) set('teamId', patch.teamId);
    if (patch.repositoryIds !== undefined) set('repositoryIds', unique(patch.repositoryIds));
    if (patch.performers !== undefined) set('performers', patch.performers);
    if (patch.provider !== undefined) set('provider', patch.provider);
    if (patch.parentExecutionId !== undefined) set('parentExecutionId', patch.parentExecutionId);
    if (patch.sessionUrl !== undefined) set('sessionUrl', patch.sessionUrl);
    if (patch.branch !== undefined) set('branch', patch.branch);
    if (patch.progressNote !== undefined) set('progressNote', patch.progressNote);
    if (patch.state !== undefined) this.applyState(row, patch.state, fields);
    const depsChange = patch.dependsOnExecutionIds !== undefined;
    if (!fields.length && !depsChange) return this.attach(workspaceId, row);
    row.updatedAt = new Date();
    await this.repo.save(row);
    if (depsChange) await this.deps.syncExecutionDeps(workspaceId, actor, id, unique(patch.dependsOnExecutionIds));
    const other = fields.filter((f) => f !== 'state' && f !== 'startedAt' && f !== 'completedAt');
    if (fields.includes('state'))
      await this.events.record({
        workspaceId,
        actor,
        type: 'execution.state_changed',
        subject: { type: 'execution', id },
        workstreamId: row.workstreamId,
        data: { title: row.title, from: fromState, to: row.state },
      });
    if (other.length || depsChange)
      await this.events.record({
        workspaceId,
        actor,
        type: 'execution.updated',
        subject: { type: 'execution', id },
        workstreamId: row.workstreamId,
        data: { title: row.title, fields: other },
      });
    await this.bus.touch(workspaceId, row.workstreamId, 'execution.updated');
    return this.get(workspaceId, id);
  }

  /** Sets state + startedAt/completedAt bookkeeping. */
  private applyState(row: ExecutionEntity, state: ExecutionState, fields: string[]) {
    if (row.state === state) return;
    row.state = state;
    fields.push('state');
    if (state !== 'queued' && !row.startedAt) row.startedAt = new Date();
    row.completedAt = isTerminal(state) ? new Date() : null;
  }

  /** Performer reports progress (a note, optionally moving the state). */
  async progress(workspaceId: string, actor: ActorRef, id: string, input: { note: string; state?: ExecutionState }) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Execution', id);
    const fromState = row.state;
    const fields: string[] = [];
    row.progressNote = input.note;
    if (input.state) this.applyState(row, input.state, fields);
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'execution.progress',
      subject: { type: 'execution', id },
      workstreamId: row.workstreamId,
      data: { title: row.title, note: input.note },
    });
    if (fields.includes('state'))
      await this.events.record({
        workspaceId,
        actor,
        type: 'execution.state_changed',
        subject: { type: 'execution', id },
        workstreamId: row.workstreamId,
        data: { title: row.title, from: fromState, to: row.state },
      });
    await this.bus.touch(workspaceId, row.workstreamId, 'execution.progress');
    return this.get(workspaceId, id);
  }

  complete(workspaceId: string, actor: ActorRef, id: string, input: { note?: string }) {
    return this.progress(workspaceId, actor, id, { note: input.note ?? 'Completed', state: 'completed' });
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Execution', id);
    await this.ds.transaction(async (m) => {
      // children cascade by FK; clean polymorphic rows for this execution and its descendants
      const ids = (
        await m.query<{ id: string }[]>(
          `WITH RECURSIVE tree AS (SELECT "id" FROM "executions" WHERE "id" = $1
             UNION ALL SELECT e."id" FROM "executions" e JOIN tree t ON e."parentExecutionId" = t."id")
           SELECT "id" FROM tree`,
          [id],
        )
      ).map((r) => r.id);
      await m.query(`DELETE FROM "dependencies" WHERE "workspaceId" = $1 AND ("fromId" = ANY($2) OR "toId" = ANY($2))`, [workspaceId, ids]);
      await m.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`, [workspaceId, ids]);
      await m.delete(ExecutionEntity, { id });
    });
    await this.events.record({
      workspaceId,
      actor,
      type: 'execution.deleted',
      subject: { type: 'execution', id },
      workstreamId: row.workstreamId,
      data: { title: row.title },
    });
    await this.bus.touch(workspaceId, row.workstreamId, 'execution.deleted');
  }
}
