import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { notFound } from '../common/util.js';
import {
  ArtifactEntity,
  DependencyEntity,
  RepositoryEntity,
  TeamEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import type { Graph, GraphEdge, GraphEdgeKind, GraphNode } from './graph.types.js';

export interface GraphOptions {
  teamId?: string;
  workstreamId?: string;
  /** default true */
  includeArtifacts?: boolean;
  /** users, agents and teams (default true) */
  includeActors?: boolean;
  /** default true */
  includeRepositories?: boolean;
}

@Injectable()
export class GraphService {
  constructor(private readonly ds: DataSource) {}

  async build(workspaceId: string, opts: GraphOptions = {}): Promise<Graph> {
    const where = { workspaceId };
    const [allWs, artifacts, deps, teams, repos] = await Promise.all([
      this.ds.getRepository(WorkstreamEntity).find({ where }),
      opts.includeArtifacts === false ? [] : this.ds.getRepository(ArtifactEntity).find({ where, order: { createdAt: 'ASC' } }),
      this.ds.getRepository(DependencyEntity).find({ where }),
      this.ds.getRepository(TeamEntity).find({ where }),
      this.ds.getRepository(RepositoryEntity).find({ where }),
    ]);

    const wsById = new Map(allWs.map((w) => [w.id, w]));
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const repoById = new Map(repos.map((r) => [r.id, r]));

    if (opts.workstreamId && !wsById.has(opts.workstreamId)) throw notFound('Workstream', opts.workstreamId);

    const included = allWs.filter((w) =>
      opts.workstreamId
        ? w.id === opts.workstreamId
        : opts.teamId
          ? w.ownerTeamId === opts.teamId || w.participatingTeamIds.includes(opts.teamId)
          : true,
    );

    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const node = (n: GraphNode) => {
      if (!nodes.has(n.id)) nodes.set(n.id, n);
    };
    const edge = (kind: GraphEdgeKind, source: string, target: string) => {
      const id = `${kind}:${source}>${target}`;
      if (!edges.has(id)) edges.set(id, { id, source, target, kind });
    };
    const actors = opts.includeActors !== false;
    const withRepos = opts.includeRepositories !== false;

    const addWorkstream = (w: WorkstreamEntity, external = false) => {
      node({
        id: w.id,
        type: 'workstream',
        label: `${w.key} ${w.title}`,
        status: w.status,
        parentId: actors ? w.ownerTeamId : undefined,
        data: {
          key: w.key,
          title: w.title,
          priority: w.priority,
          derivedStatus: w.derivedStatus,
          ownerTeamId: w.ownerTeamId,
          participatingTeamIds: w.participatingTeamIds,
          accountableUserId: w.accountableUserId ?? undefined,
          targetDate: w.targetDate?.toISOString(),
          ...(external ? { external: true } : {}),
        },
      });
      if (actors) {
        const t = teamById.get(w.ownerTeamId);
        if (t) {
          node(teamNode(t));
          edge('contains', t.id, w.id);
        }
      }
      if (withRepos) for (const r of w.repositoryIds) addRepo(w.id, r);
    };
    const teamNode = (t: TeamEntity): GraphNode => ({
      id: t.id,
      type: 'team',
      label: t.name,
      data: { key: t.key, color: t.color },
    });
    const addRepo = (from: string, repoId: string) => {
      const r = repoById.get(repoId);
      if (!r) return;
      node({ id: r.id, type: 'repository', label: r.fullName, data: { fullName: r.fullName, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch } });
      edge('targets', from, r.id);
    };
    const includedIds = new Set(included.map((w) => w.id));
    for (const w of included) addWorkstream(w);
    for (const a of artifacts) {
      if (!includedIds.has(a.workstreamId)) continue;
      node({
        id: a.id,
        type: 'artifact',
        label: a.externalId ? `${a.title} (${a.externalId})` : a.title,
        state: a.state,
        parentId: a.workstreamId,
        data: {
          kind: a.kind,
          workstreamId: a.workstreamId,
          url: a.url ?? undefined,
          externalId: a.externalId ?? undefined,
          ci: a.ci ?? undefined,
          review: a.review ?? undefined,
          hasConflicts: a.hasConflicts ?? undefined,
          environment: a.environment ?? undefined,
        },
      });
      edge('contains', a.workstreamId, a.id);
    }

    for (const d of deps) {
      if (d.fromType !== 'workstream' || d.toType !== 'workstream') continue;
      if (!(includedIds.has(d.fromId) || includedIds.has(d.toId))) continue;
      for (const id of [d.fromId, d.toId]) {
        if (includedIds.has(id) || nodes.has(id)) continue;
        const w = wsById.get(id);
        if (w) addWorkstream(w, true);
      }
      edge('depends_on', d.toId, d.fromId);
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }
}
