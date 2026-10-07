import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { ExecutionState, WorkstreamStatus } from '../contracts/domain.js';
import {
  ArtifactEntity,
  DecisionEntity,
  DependencyEntity,
  ExecutionEntity,
  InputRequestEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus, type WorkstreamTouched } from '../events/workstream-bus.js';
import { deriveStatus, type StatusDependency } from './derive-status.js';

export interface StatusChange {
  workstreamId: string;
  key: string;
  from: WorkstreamStatus;
  to: WorkstreamStatus;
}

/**
 * Keeps `status` / `derivedStatus` / `shippedAt` of workstreams in sync with their
 * executions, input requests, artifacts, decisions and dependencies (PLAN.md §2).
 * Subscribed to {@link WorkstreamBus}; also re-derives dependents.
 */
@Injectable()
export class StatusService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StatusService.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.onTouched((e) => this.onTouched(e));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const changes = await this.recomputeAll();
      if (changes.length) this.logger.log(`Boot recompute changed ${changes.length} workstream status(es)`);
    } catch (error) {
      this.logger.error(`Boot recompute failed: ${(error as Error).message}`);
    }
  }

  private async onTouched(e: WorkstreamTouched): Promise<void> {
    const changes: StatusChange[] = [];
    await this.recompute(e.workstreamId, changes, new Set(), true);
    // Cheap: any underlying change may alter someone's attention list.
    this.events.publish(e.workspaceId, { type: 'attention', entity: 'workstream', id: e.workstreamId });
  }

  /** Recomputes every workstream (boot, after seed / admin reset). Returns the changes. */
  async recomputeAll(workspaceId?: string): Promise<StatusChange[]> {
    const rows = await this.ds
      .getRepository(WorkstreamEntity)
      .find({ where: workspaceId ? { workspaceId } : {}, select: { id: true } });
    const changes: StatusChange[] = [];
    for (const r of rows) await this.recompute(r.id, changes, new Set(), false);
    return changes;
  }

  /**
   * Re-derives one workstream. Dependents are re-derived when this workstream's
   * status changed, or always for the touched root (an execution may have completed).
   */
  async recompute(
    workstreamId: string,
    changes: StatusChange[] = [],
    visited: Set<string> = new Set(),
    forceDependents = false,
  ): Promise<StatusChange | null> {
    if (visited.has(workstreamId)) return null;
    visited.add(workstreamId);
    const ws = await this.ds.getRepository(WorkstreamEntity).findOneBy({ id: workstreamId });
    if (!ws) return null;
    const { workspaceId } = ws;

    const [executions, inputRequests, artifacts, decisions] = await Promise.all([
      this.ds.getRepository(ExecutionEntity).find({ where: { workstreamId } }),
      this.ds.getRepository(InputRequestEntity).find({ where: { workstreamId, state: 'open' } }),
      this.ds.getRepository(ArtifactEntity).find({ where: { workstreamId } }),
      this.ds.getRepository(DecisionEntity).find({ where: { workspaceId, originWorkstreamId: workstreamId, status: 'proposed' } }),
    ]);
    const incomingDependencies = await this.incoming(workspaceId, ws.id, executions);

    const result = deriveStatus({ workstream: ws, executions, inputRequests, artifacts, decisions, incomingDependencies });

    let change: StatusChange | null = null;
    const dirty =
      ws.derivedStatus !== result.derivedStatus ||
      ws.status !== result.status ||
      (result.derivedStatus === 'shipped' && !ws.shippedAt);
    if (dirty) {
      const from = ws.status;
      const patch: Partial<WorkstreamEntity> = { derivedStatus: result.derivedStatus, status: result.status };
      if (result.derivedStatus === 'shipped' && !ws.shippedAt) patch.shippedAt = new Date();
      if (from !== result.status) patch.updatedAt = new Date();
      await this.ds.getRepository(WorkstreamEntity).update({ id: ws.id }, patch);
      if (from !== result.status) {
        change = { workstreamId: ws.id, key: ws.key, from, to: result.status };
        changes.push(change);
        await this.events.record({
          workspaceId,
          actor: { type: 'system' },
          type: 'workstream.status_changed',
          subject: { type: 'workstream', id: ws.id },
          workstreamId: ws.id,
          data: { key: ws.key, title: ws.title, from, to: result.status, derivedStatus: result.derivedStatus },
        });
      }
    }

    if (change || forceDependents) {
      for (const id of await this.dependents(workspaceId, ws.id, executions.map((e) => e.id)))
        await this.recompute(id, changes, visited, false);
    }
    return change;
  }

  /** Edges pointing into the workstream or its executions, with source states. */
  private async incoming(workspaceId: string, workstreamId: string, executions: ExecutionEntity[]): Promise<StatusDependency[]> {
    const execState = new Map<string, ExecutionState>(executions.map((e) => [e.id, e.state]));
    const targets = [workstreamId, ...execState.keys()];
    const edges = await this.ds.getRepository(DependencyEntity).find({ where: { workspaceId, toId: In(targets) } });
    if (!edges.length) return [];
    const wsIds = edges.filter((e) => e.fromType === 'workstream').map((e) => e.fromId);
    const exIds = edges.filter((e) => e.fromType === 'execution').map((e) => e.fromId);
    const [wss, exs] = await Promise.all([
      wsIds.length ? this.ds.getRepository(WorkstreamEntity).find({ where: { id: In(wsIds) }, select: { id: true, status: true } }) : [],
      exIds.length ? this.ds.getRepository(ExecutionEntity).find({ where: { id: In(exIds) }, select: { id: true, state: true } }) : [],
    ]);
    const wsStatus = new Map<string, string>(wss.map((w) => [w.id, w.status]));
    const exStateMap = new Map<string, string>(exs.map((e) => [e.id, e.state]));
    const out: StatusDependency[] = [];
    for (const e of edges) {
      const sourceState = e.fromType === 'workstream' ? wsStatus.get(e.fromId) : exStateMap.get(e.fromId);
      if (!sourceState) continue; // dangling edge
      out.push({
        sourceType: e.fromType,
        sourceState,
        targetExecutionState: e.toType === 'execution' ? execState.get(e.toId) : undefined,
      });
    }
    return out;
  }

  /** Workstreams that wait on this workstream or on any of its executions. */
  private async dependents(workspaceId: string, workstreamId: string, executionIds: string[]): Promise<string[]> {
    const edges = await this.ds
      .getRepository(DependencyEntity)
      .find({ where: { workspaceId, fromId: In([workstreamId, ...executionIds]) } });
    const out = new Set<string>();
    const exTargets: string[] = [];
    for (const e of edges) {
      if (e.toType === 'workstream') out.add(e.toId);
      else exTargets.push(e.toId);
    }
    if (exTargets.length) {
      const rows = await this.ds.getRepository(ExecutionEntity).find({ where: { id: In(exTargets) }, select: { id: true, workstreamId: true } });
      for (const r of rows) out.add(r.workstreamId);
    }
    out.delete(workstreamId);
    return [...out];
  }
}
