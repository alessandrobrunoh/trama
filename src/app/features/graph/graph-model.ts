import type { Artifact, Dependency, ID, Workstream } from '../../core';

/**
 * Workstream graph, derived client-side from the NablaStore collections.
 * Edges point in flow direction: a dependency goes blocker -> blocked.
 */
export type GraphNodeKind = 'workstream' | 'artifact';
export type GraphEdgeKind = 'contains' | 'depends_on';

interface NodeBase {
  id: ID;
  /** Pulled in only because a dependency crosses the current filter (rendered muted). */
  external?: boolean;
}
export interface WorkstreamGraphNode extends NodeBase {
  kind: 'workstream';
  entity: Workstream;
}
export interface ArtifactGraphNode extends NodeBase {
  kind: 'artifact';
  entity: Artifact;
}
export type GraphNode = WorkstreamGraphNode | ArtifactGraphNode;

export interface GraphEdge {
  id: string;
  /** Node id the edge leaves (the blocker for `depends_on`). */
  source: ID;
  /** Node id the edge enters (the blocked node for `depends_on`). */
  target: ID;
  kind: GraphEdgeKind;
  /** `depends_on` only: the blocker workstream is not shipped yet. */
  blocking?: boolean;
}

export interface ExecutionGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The slice of the store the builder reads (all readonly arrays). */
export interface GraphSource {
  workstreams: readonly Workstream[];
  artifacts: readonly Artifact[];
  dependencies: readonly Dependency[];
}

export interface GraphOptions {
  /** Only workstreams owned by / participating the team (plus dependency neighbours). */
  teamId?: ID | null;
  /** Only this workstream (plus dependency neighbours). Takes precedence over `teamId`. */
  workstreamId?: ID | null;
  /** Several workstreams (e.g. a saved view's result). Combined with the others by intersection. */
  workstreamIds?: ReadonlySet<ID> | null;
  includeArtifacts?: boolean;
  /** Drop shipped workstreams (and everything under them). */
  hideShipped?: boolean;
  /** Also drop canceled workstreams (default true). */
  hideCanceled?: boolean;
}

/** Build the graph (nodes + edges) for the given store slice and filters. */
export function buildExecutionGraph(src: GraphSource, opts: GraphOptions = {}): ExecutionGraphData {
  const includeArtifacts = opts.includeArtifacts ?? true;
  const hideCanceled = opts.hideCanceled ?? true;
  const wsById = new Map(src.workstreams.map((w) => [w.id, w]));

  // 1. which workstreams are "in selection"
  const selected = new Set<ID>();
  for (const w of src.workstreams) {
    if (opts.hideShipped && w.status === 'shipped') continue;
    if (hideCanceled && w.status === 'canceled') continue;
    if (opts.workstreamIds && !opts.workstreamIds.has(w.id)) continue;
    if (opts.workstreamId) {
      if (w.id !== opts.workstreamId) continue;
    } else if (opts.teamId) {
      if (w.ownerTeamId !== opts.teamId && !w.participatingTeamIds.includes(opts.teamId)) continue;
    }
    selected.add(w.id);
  }

  const nodes = new Map<ID, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addEdge = (source: ID, target: ID, kind: GraphEdgeKind, blocking?: boolean): void => {
    const id = `${kind}:${source}>${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, kind, ...(blocking !== undefined ? { blocking } : {}) });
  };

  const addWorkstream = (w: Workstream, external: boolean): void => {
    if (!nodes.has(w.id)) nodes.set(w.id, { kind: 'workstream', id: w.id, entity: w, ...(external ? { external } : {}) });
  };
  for (const w of src.workstreams) {
    if (!selected.has(w.id)) continue;
    addWorkstream(w, false);
  }
  if (includeArtifacts) {
    for (const a of src.artifacts) {
      if (!selected.has(a.workstreamId)) continue;
      nodes.set(a.id, { kind: 'artifact', id: a.id, entity: a });
      addEdge(a.workstreamId, a.id, 'contains');
    }
  }

  const pullIn = (id: ID): boolean => {
    if (nodes.has(id) && nodes.get(id)!.kind === 'workstream') return true;
    const w = wsById.get(id);
    if (!w || (opts.hideShipped && w.status === 'shipped') || (hideCanceled && w.status === 'canceled')) return false;
    addWorkstream(w, true);
    return true;
  };

  for (const d of src.dependencies) {
    if (d.fromType !== 'workstream' || d.toType !== 'workstream') continue;
    if (d.fromId === d.toId) continue;
    if (!selected.has(d.fromId) && !selected.has(d.toId)) continue;
    if (!pullIn(d.fromId) || !pullIn(d.toId)) continue;
    addEdge(d.fromId, d.toId, 'depends_on', wsById.get(d.fromId)?.status !== 'shipped');
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Summary counts for headers. */
export function graphStats(g: ExecutionGraphData): { workstreams: number; artifacts: number; dependencies: number } {
  let workstreams = 0;
  let artifacts = 0;
  for (const n of g.nodes) {
    if (n.kind === 'workstream') workstreams++;
    else artifacts++;
  }
  return { workstreams, artifacts, dependencies: g.edges.filter((e) => e.kind === 'depends_on').length };
}
