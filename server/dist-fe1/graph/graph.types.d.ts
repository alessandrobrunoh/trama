export type GraphNodeType = 'workstream' | 'execution' | 'artifact' | 'agent' | 'user' | 'team' | 'repository';
export type GraphEdgeKind = 'contains' | 'subthread' | 'depends_on' | 'produces' | 'performed_by' | 'targets';
export interface GraphNode {
    id: string;
    type: GraphNodeType;
    label: string;
    status?: string;
    state?: string;
    parentId?: string;
    data: Record<string, unknown>;
}
export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    kind: GraphEdgeKind;
}
export interface Graph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}
