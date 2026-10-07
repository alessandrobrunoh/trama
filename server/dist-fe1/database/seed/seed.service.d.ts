import { OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkstreamBus } from '../../events/workstream-bus.js';
export declare class SeedService implements OnApplicationBootstrap {
    private readonly ds;
    private readonly bus;
    private readonly logger;
    constructor(ds: DataSource, bus: WorkstreamBus);
    onApplicationBootstrap(): Promise<void>;
    reset(): Promise<void>;
}
