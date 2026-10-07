import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, IntakeKind, IntakeSource, IntakeState, Priority } from '../contracts/domain.js';
import { CreateWorkstreamDto } from '../workstreams/workstreams.controller.js';
import { IntakeService } from './intake.service.js';
declare class CreateIntakeDto {
    kind: IntakeKind;
    title: string;
    body?: string;
    source?: IntakeSource;
    reporterName?: string;
    teamId?: string;
    priority?: Priority;
    externalUrl?: string;
}
declare class UpdateIntakeDto {
    title?: string;
    body?: string | null;
    reporterName?: string | null;
    teamId?: string | null;
    priority?: Priority;
    externalUrl?: string | null;
    workstreamIds?: string[];
}
declare class TriageDto {
    state: IntakeState;
    workstreamIds?: string[];
    createWorkstream?: CreateWorkstreamDto;
    duplicateOfId?: string;
    teamId?: string | null;
    priority?: Priority;
}
declare class ListIntakeQuery {
    kind?: IntakeKind;
    state?: IntakeState;
    teamId?: string;
    workstreamId?: string;
    q?: string;
}
export declare class IntakeController {
    private readonly service;
    constructor(service: IntakeService);
    list(ctx: WorkspaceContext, q: ListIntakeQuery): Promise<import("../database/entities/index.js").IntakeItemEntity[]>;
    get(ctx: WorkspaceContext, idOrKey: string): Promise<import("../database/entities/index.js").IntakeItemEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateIntakeDto): Promise<import("../database/entities/index.js").IntakeItemEntity>;
    update(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, dto: UpdateIntakeDto): Promise<import("../database/entities/index.js").IntakeItemEntity>;
    triage(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, dto: TriageDto): Promise<import("../database/entities/index.js").IntakeItemEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string): Promise<void>;
}
export {};
