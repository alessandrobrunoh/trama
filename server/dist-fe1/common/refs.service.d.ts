import { DataSource } from 'typeorm';
import type { SubjectRef } from '../contracts/domain.js';
export declare class RefsService {
    private readonly ds;
    constructor(ds: DataSource);
    private assertAll;
    teams(workspaceId: string, ids?: readonly string[] | null): Promise<void>;
    repositories(workspaceId: string, ids?: readonly string[] | null): Promise<void>;
    workstreams(workspaceId: string, ids?: readonly string[] | null): Promise<void>;
    executions(workspaceId: string, ids?: readonly string[] | null): Promise<void>;
    users(workspaceId: string, ids?: readonly (string | null | undefined)[] | null): Promise<void>;
    resolveSubject(workspaceId: string, subject: SubjectRef): Promise<{
        exists: boolean;
        workstreamId?: string;
    }>;
}
