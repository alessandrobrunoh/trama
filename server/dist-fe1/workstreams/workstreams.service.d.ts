import { DataSource, type EntityManager, type Repository } from 'typeorm';
import type { ActorRef, CriterionState, Priority, WorkstreamStatus } from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export interface CriterionInput {
    id?: string;
    text: string;
    state?: CriterionState;
}
export interface WorkstreamInput {
    title?: string;
    objective?: string;
    context?: string | null;
    ownerTeamId?: string;
    participatingTeamIds?: string[];
    accountableUserId?: string | null;
    repositoryIds?: string[];
    acceptanceCriteria?: CriterionInput[];
    priority?: Priority;
    labels?: string[];
    statusOverride?: 'draft' | 'canceled' | null;
    targetDate?: string | null;
}
export interface WorkstreamFilter {
    status?: WorkstreamStatus;
    ownerTeamId?: string;
    teamId?: string;
    accountableUserId?: string;
    priority?: Priority;
    repositoryId?: string;
    label?: string;
    q?: string;
}
export declare class WorkstreamsService {
    private readonly ds;
    private readonly refs;
    private readonly counters;
    private readonly events;
    private readonly bus;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, counters: CountersService, events: EventsService, bus: WorkstreamBus, repo: Repository<WorkstreamEntity>);
    list(workspaceId: string, f?: WorkstreamFilter): Promise<WorkstreamEntity[]>;
    get(workspaceId: string, idOrKey: string, manager?: EntityManager): Promise<WorkstreamEntity>;
    create(workspaceId: string, actor: ActorRef, input: WorkstreamInput & {
        title: string;
        ownerTeamId: string;
    }, options?: {
        manager?: EntityManager;
        data?: Record<string, unknown>;
    }): Promise<WorkstreamEntity & {
        after?: () => Promise<void>;
    }>;
    update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: WorkstreamInput): Promise<WorkstreamEntity>;
    remove(workspaceId: string, actor: ActorRef, idOrKey: string): Promise<void>;
    addCriterion(workspaceId: string, actor: ActorRef, idOrKey: string, input: CriterionInput): Promise<WorkstreamEntity>;
    updateCriterion(workspaceId: string, actor: ActorRef, idOrKey: string, criterionId: string, patch: Partial<CriterionInput>): Promise<WorkstreamEntity>;
    removeCriterion(workspaceId: string, actor: ActorRef, idOrKey: string, criterionId: string): Promise<WorkstreamEntity>;
    private saveCriteria;
}
