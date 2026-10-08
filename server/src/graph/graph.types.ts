export type GraphNodeType = 'workstream' | 'artifact' | 'agent' | 'user' | 'team' | 'repository';
export type GraphEdgeKind = 'contains' | 'depends_on' | 'targets';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** workstreams only: the effective WorkstreamStatus */
  status?: string;
  /** artifacts: ArtifactState */
  state?: string;
  /** artifact → workstream; workstream → owner team */
  parentId?: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  /** `depends_on`: source depends on (waits for) target. All other kinds point from owner to owned. */
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
