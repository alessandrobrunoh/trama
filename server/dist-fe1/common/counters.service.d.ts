import type { EntityManager } from 'typeorm';
export declare class CountersService {
    next(m: EntityManager, workspaceId: string, name: string): Promise<number>;
    bumpTo(m: EntityManager, workspaceId: string, name: string, value: number): Promise<void>;
}
