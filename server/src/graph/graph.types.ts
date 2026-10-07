export type GraphNodeType = 'workstream' | 'execution' | 'artifact' | 'agent' | 'user' | 'team' | 'repository';
export type GraphEdgeKind = 'contains' | 'subthread' | 'depends_on' | 'produces' | 'performed_by' | 'targets';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** workstreams only: the effective WorkstreamStatus */
  status?: string;
  /** executions and artifacts: ExecutionState / ArtifactState */
  state?: string;
  /** execution → parent execution or workstream; artifact → execution or workstream; workstream → owner team */
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
