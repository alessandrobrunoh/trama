import { OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WorkstreamStatus } from '../contracts/domain.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export interface StatusChange {
    workstreamId: string;
    key: string;
    from: WorkstreamStatus;
    to: WorkstreamStatus;
}
export declare class StatusService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
    private readonly ds;
    private readonly events;
    private readonly bus;
    private readonly logger;
    private unsubscribe?;
    constructor(ds: DataSource, events: EventsService, bus: WorkstreamBus);
    onModuleInit(): void;
    onModuleDestroy(): void;
    onApplicationBootstrap(): Promise<void>;
    private onTouched;
    recomputeAll(workspaceId?: string): Promise<StatusChange[]>;
    recompute(workstreamId: string, changes?: StatusChange[], visited?: Set<string>, forceDependents?: boolean): Promise<StatusChange | null>;
    private incoming;
    private dependents;
}
