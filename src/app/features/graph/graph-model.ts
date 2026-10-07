import type { Artifact, Dependency, Execution, ID, Workstream } from '../../core';

/**
 * Execution-graph data model, derived client-side from the NablaStore collections (so it is always in
 * sync with the live snapshot and needs no extra request). Edges always point in "flow" direction
 * (left to right): hierarchy goes parent -> child, and a dependency goes blocker -> blocked.
 */
export type GraphNodeKind = 'workstream' | 'execution' | 'artifact';
export type GraphEdgeKind = 'contains' | 'subthread' | 'produces' | 'depends_on';

interface NodeBase {
  id: ID;
  /** Pulled in only because a dependency crosses the current filter (rendered muted). */
  external?: boolean;
}
export interface WorkstreamGraphNode extends NodeBase {
  kind: 'workstream';
  entity: Workstream;
}
export interface ExecutionGraphNode extends NodeBase {
  kind: 'execution';
  entity: Execution;
}
export interface ArtifactGraphNode extends NodeBase {
  kind: 'artifact';
  entity: Artifact;
}
export type GraphNode = WorkstreamGraphNode | ExecutionGraphNode | ArtifactGraphNode;

export interface GraphEdge {
  id: string;
  /** Node id the edge leaves (the blocker for `depends_on`). */
  source: ID;
  /** Node id the edge enters (the blocked node for `depends_on`). */
  target: ID;
  kind: GraphEdgeKind;
  /** `depends_on` only: the blocker is still unresolved (workstream not shipped / execution not completed). */
  blocking?: boolean;
}

export interface ExecutionGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The slice of the store the builder reads (all readonly arrays). */
export interface GraphSource {
  workstreams: readonly Workstream[];
  executions: readonly Execution[];
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
  const exById = new Map(src.executions.map((e) => [e.id, e]));

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
  const addExecution = (e: Execution, external: boolean): void => {
    if (!nodes.has(e.id)) nodes.set(e.id, { kind: 'execution', id: e.id, entity: e, ...(external ? { external } : {}) });
    // hierarchy edge
    if (e.parentExecutionId && exById.has(e.parentExecutionId)) addEdge(e.parentExecutionId, e.id, 'subthread');
    else addEdge(e.workstreamId, e.id, 'contains');
  };

  // 2. selected workstreams with their executions and artifacts
  for (const w of src.workstreams) {
    if (!selected.has(w.id)) continue;
    addWorkstream(w, false);
  }
  for (const e of src.executions) {
    if (!selected.has(e.workstreamId)) continue;
    addExecution(e, false);
  }
  if (includeArtifacts) {
    for (const a of src.artifacts) {
      if (!selected.has(a.workstreamId)) continue;
      nodes.set(a.id, { kind: 'artifact', id: a.id, entity: a });
      if (a.executionId && exById.has(a.executionId)) addEdge(a.executionId, a.id, 'produces');
      else addEdge(a.workstreamId, a.id, 'contains');
    }
  }

  // 3. dependency edges; an endpoint outside the selection is pulled in as an "external" node
  const hasNode = (type: 'workstream' | 'execution', id: ID): boolean => nodes.has(id) && nodes.get(id)!.kind === type;
  const pullIn = (type: 'workstream' | 'execution', id: ID): boolean => {
    if (hasNode(type, id)) return true;
    if (type === 'workstream') {
      const w = wsById.get(id);
      if (!w || (opts.hideShipped && w.status === 'shipped') || (hideCanceled && w.status === 'canceled')) return false;
      addWorkstream(w, true);
      return true;
    }
    const e = exById.get(id);
    if (!e) return false;
    const w = wsById.get(e.workstreamId);
    if (!w || (opts.hideShipped && w.status === 'shipped') || (hideCanceled && w.status === 'canceled')) return false;
    addWorkstream(w, true);
    addExecution(e, true);
    return true;
  };

  const resolved = (type: 'workstream' | 'execution', id: ID): boolean => {
    if (type === 'workstream') return wsById.get(id)?.status === 'shipped';
    const e = exById.get(id);
    return !e || e.state === 'completed';
  };

  const consider: { type: 'workstream' | 'execution'; from: ID; to: ID }[] = [];
  for (const d of src.dependencies) {
    if (d.fromType !== d.toType) continue; // contract: workstream<->workstream or execution<->execution
    consider.push({ type: d.fromType, from: d.fromId, to: d.toId });
  }
  // execution.dependsOnExecutionIds is the same relation as a dependency row; include it when no row exists
  for (const e of src.executions) {
    for (const dep of e.dependsOnExecutionIds) consider.push({ type: 'execution', from: dep, to: e.id });
  }

  const nodeInSelection = (type: 'workstream' | 'execution', id: ID): boolean => {
    if (type === 'workstream') return selected.has(id);
    const e = exById.get(id);
    return !!e && selected.has(e.workstreamId);
  };
  for (const c of consider) {
    if (c.from === c.to) continue;
    const inFrom = nodeInSelection(c.type, c.from);
    const inTo = nodeInSelection(c.type, c.to);
    if (!inFrom && !inTo) continue;
    // an unfiltered graph never needs external nodes; a filtered one pulls the other end in
    if (!pullIn(c.type, c.from) || !pullIn(c.type, c.to)) continue;
    addEdge(c.from, c.to, 'depends_on', !resolved(c.type, c.from));
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Summary counts for headers. */
export function graphStats(g: ExecutionGraphData): { workstreams: number; executions: number; artifacts: number; dependencies: number } {
  let workstreams = 0;
  let executions = 0;
  let artifacts = 0;
  for (const n of g.nodes) {
    if (n.kind === 'workstream') workstreams++;
    else if (n.kind === 'execution') executions++;
    else artifacts++;
  }
  return { workstreams, executions, artifacts, dependencies: g.edges.filter((e) => e.kind === 'depends_on').length };
}
