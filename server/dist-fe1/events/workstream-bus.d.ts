export interface WorkstreamTouched {
    workspaceId: string;
    workstreamId: string;
    reason: string;
}
export type WorkstreamTouchedHandler = (event: WorkstreamTouched) => void | Promise<void>;
export declare class WorkstreamBus {
    private readonly logger;
    private readonly handlers;
    onTouched(handler: WorkstreamTouchedHandler): () => void;
    touch(workspaceId: string, workstreamId: string, reason: string): Promise<void>;
    touchMany(workspaceId: string, workstreamIds: Iterable<string>, reason: string): Promise<void>;
}
