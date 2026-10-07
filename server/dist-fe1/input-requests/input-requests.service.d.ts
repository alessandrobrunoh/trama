import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, InputRequestState } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { InputRequestEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export interface InputRequestInput {
    workstreamId?: string;
    executionId?: string | null;
    question?: string;
    options?: string[] | null;
    assigneeUserId?: string | null;
}
export declare class InputRequestsService {
    private readonly ds;
    private readonly refs;
    private readonly events;
    private readonly bus;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, events: EventsService, bus: WorkstreamBus, repo: Repository<InputRequestEntity>);
    list(workspaceId: string, f?: {
        state?: InputRequestState;
        workstreamId?: string;
        executionId?: string;
        assigneeUserId?: string;
    }): Promise<InputRequestEntity[]>;
    get(workspaceId: string, id: string): Promise<InputRequestEntity>;
    create(workspaceId: string, actor: ActorRef, input: InputRequestInput & {
        question: string;
    }): Promise<InputRequestEntity>;
    update(workspaceId: string, actor: ActorRef, id: string, patch: InputRequestInput): Promise<InputRequestEntity>;
    answer(workspaceId: string, actor: ActorRef, id: string, answer: string): Promise<InputRequestEntity>;
    dismiss(workspaceId: string, actor: ActorRef, id: string): Promise<InputRequestEntity>;
    remove(workspaceId: string, actor: ActorRef, id: string): Promise<void>;
}
