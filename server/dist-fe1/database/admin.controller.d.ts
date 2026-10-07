import { SeedService } from './seed/seed.service.js';
export declare class AdminController {
    private readonly seed;
    constructor(seed: SeedService);
    reset(): Promise<{
        ok: boolean;
    }>;
}
