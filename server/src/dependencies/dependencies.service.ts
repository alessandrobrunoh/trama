import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, DependencyNodeType } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import { DependencyEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

export interface Node {
  type: DependencyNodeType;
  id: string;
}

const key = (n: Node) => `${n.type}:${n.id}`;

@Injectable()
export class DependenciesService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(DependencyEntity) private readonly repo: Repository<DependencyEntity>,
  ) {}

  list(workspaceId: string, f: { fromId?: string; toId?: string; id?: string } = {}) {
    const where: Record<string, string> = { workspaceId };
    if (f.fromId) where.fromId = f.fromId;
    if (f.toId) where.toId = f.toId;
    return this.repo.find({ where, order: { createdAt: 'ASC' } });
  }

  async get(workspaceId: string, id: string) {
    const d = await this.repo.findOneBy({ workspaceId, id });
    if (!d) throw notFound('Dependency', id);
    return d;
  }

  /** The workstream a node belongs to (or is), `undefined` when the node does not exist in the workspace. */
  async workstreamOf(workspaceId: string, node: Node): Promise<string | undefined> {
    const w = await this.ds.getRepository(WorkstreamEntity).findOne({ where: { workspaceId, id: node.id }, select: { id: true } });
    return w?.id;
  }

  /** True when adding `from → to` would close a loop (i.e. `from` is already reachable from `to`). */
  private async wouldCycle(workspaceId: string, from: Node, to: Node, extra: Node[][] = []): Promise<boolean> {
    const edges = await this.repo.find({ where: { workspaceId } });
    const adj = new Map<string, string[]>();
    const add = (a: string, b: string) => adj.set(a, [...(adj.get(a) ?? []), b]);
    for (const e of edges) add(`${e.fromType}:${e.fromId}`, `${e.toType}:${e.toId}`);
    for (const [a, b] of extra) add(key(a), key(b));
    const target = key(from);
    const seen = new Set<string>();
    const stack = [key(to)];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(adj.get(cur) ?? []));
    }
    return false;
  }

  async create(workspaceId: string, actor: ActorRef, from: Node, to: Node): Promise<DependencyEntity> {
    if (from.type === to.type && from.id === to.id) throw new BadRequestException('A node cannot depend on itself');
    const fromWs = await this.workstreamOf(workspaceId, from);
    const toWs = await this.workstreamOf(workspaceId, to);
    if (!fromWs) throw new BadRequestException(`Unknown ${from.type} "${from.id}"`);
    if (!toWs) throw new BadRequestException(`Unknown ${to.type} "${to.id}"`);
    if (await this.repo.existsBy({ workspaceId, fromType: from.type, fromId: from.id, toType: to.type, toId: to.id }))
      throw new ConflictException('Dependency already exists');
    if (await this.wouldCycle(workspaceId, from, to))
      throw new ConflictException('This dependency would create a cycle');
    const dep = await this.repo.save(
      this.repo.create({ id: uid('dp'), workspaceId, fromType: from.type, fromId: from.id, toType: to.type, toId: to.id }),
    );
    await this.events.record(
      {
        workspaceId,
        actor,
        type: 'dependency.added',
        subject: { type: to.type, id: to.id },
        workstreamId: toWs,
        data: { dependencyId: dep.id, from, to, fromWorkstreamId: fromWs },
      },
      { type: 'created', entity: 'dependency', id: dep.id },
    );
    await this.bus.touchMany(workspaceId, [fromWs, toWs], 'dependency.added');
    return dep;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string): Promise<void> {
    const dep = await this.get(workspaceId, id);
    await this.repo.delete({ id });
    const from: Node = { type: dep.fromType, id: dep.fromId };
    const to: Node = { type: dep.toType, id: dep.toId };
    const fromWs = await this.workstreamOf(workspaceId, from);
    const toWs = await this.workstreamOf(workspaceId, to);
    await this.events.record(
      {
        workspaceId,
        actor,
        type: 'dependency.removed',
        subject: { type: to.type, id: to.id },
        workstreamId: toWs,
        data: { dependencyId: id, from, to },
      },
      { type: 'deleted', entity: 'dependency', id },
    );
    await this.bus.touchMany(workspaceId, [fromWs, toWs].filter((x): x is string => !!x), 'dependency.removed');
  }
}
