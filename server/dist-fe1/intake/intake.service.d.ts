import { DataSource, type Repository } from 'typeorm';
import { type ActorRef, type IntakeKind, type IntakeSource, type IntakeState, type Priority } from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { IntakeItemEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { WorkstreamsService, type WorkstreamInput } from '../workstreams/workstreams.service.js';
export interface IntakeInput {
    title?: string;
    body?: string | null;
    source?: IntakeSource;
    reporterName?: string | null;
    teamId?: string | null;
    priority?: Priority;
    externalUrl?: string | null;
    workstreamIds?: string[];
}
export interface TriageInput {
    state: IntakeState;
    workstreamIds?: string[];
    createWorkstream?: WorkstreamInput & {
        title: string;
        ownerTeamId: string;
    };
    duplicateOfId?: string;
    teamId?: string | null;
    priority?: Priority;
}
export declare class IntakeService {
    private readonly ds;
    private readonly refs;
    private readonly counters;
    private readonly events;
    private readonly bus;
    private readonly workstreams;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, counters: CountersService, events: EventsService, bus: WorkstreamBus, workstreams: WorkstreamsService, repo: Repository<IntakeItemEntity>);
    list(workspaceId: string, f?: {
        kind?: IntakeKind;
        state?: IntakeState;
        teamId?: string;
        workstreamId?: string;
        q?: string;
    }): Promise<IntakeItemEntity[]>;
    get(workspaceId: string, idOrKey: string): Promise<IntakeItemEntity>;
    create(workspaceId: string, actor: ActorRef, input: IntakeInput & {
        kind: IntakeKind;
        title: string;
    }): Promise<IntakeItemEntity>;
    update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: IntakeInput): Promise<IntakeItemEntity>;
    triage(workspaceId: string, actor: ActorRef, idOrKey: string, input: TriageInput): Promise<IntakeItemEntity>;
    remove(workspaceId: string, actor: ActorRef, idOrKey: string): Promise<void>;
}
