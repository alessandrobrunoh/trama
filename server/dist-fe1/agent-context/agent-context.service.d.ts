import { DataSource } from 'typeorm';
import type { AcceptanceCriterion, ArtifactKind, CiState, ReviewState } from '../contracts/domain.js';
import { WorkstreamsService } from '../workstreams/workstreams.service.js';
export declare const RECENT_PROGRESS = 10;
export interface AgentContext {
    key: string;
    id: string;
    title: string;
    status: string;
    priority: string;
    targetDate?: string;
    objective: string;
    context?: string;
    acceptanceCriteria: AcceptanceCriterion[];
    accountable?: string;
    teams: {
        owner: {
            key: string;
            name: string;
        };
        participating: {
            key: string;
            name: string;
        }[];
    };
    repositories: {
        fullName: string;
        url: string;
        defaultBranch: string;
        provider: string;
    }[];
    dependencies: {
        blockedBy: {
            type: 'workstream' | 'execution';
            key?: string;
            title: string;
            state: string;
            resolved: boolean;
        }[];
        blocking: {
            type: 'workstream' | 'execution';
            key?: string;
            title: string;
            state: string;
        }[];
    };
    decisions: {
        key: string;
        title: string;
        status: string;
        relation: 'origin' | 'related';
        statement: string;
        rationale?: string;
        supersededBy?: string;
    }[];
    intake: {
        key: string;
        title: string;
        kind: string;
        state: string;
    }[];
    artifacts: {
        kind: ArtifactKind;
        title: string;
        externalId?: string;
        url?: string;
        state: string;
        ci?: CiState;
        review?: ReviewState;
        hasConflicts?: boolean;
        environment?: string;
    }[];
    executions: {
        id: string;
        title: string;
        state: string;
        provider: string;
        parentExecutionId?: string;
        progressNote?: string;
    }[];
    openInputRequests: {
        id: string;
        question: string;
        options?: string[];
        executionId?: string;
    }[];
    recentProgress: {
        at: string;
        by: string;
        text: string;
        execution?: string;
    }[];
}
export declare class AgentContextService {
    private readonly ds;
    private readonly workstreams;
    constructor(ds: DataSource, workstreams: WorkstreamsService);
    build(workspaceId: string, idOrKey: string): Promise<AgentContext>;
    static toMarkdown(c: AgentContext): string;
}
