import { type WorkspaceContext } from '../auth/request-context.js';
import { AttentionService } from './attention.service.js';
declare class AttentionQuery {
    scope?: 'mine' | 'all';
    state?: 'open' | 'snoozed' | 'dismissed' | 'active';
}
declare class SnoozeDto {
    until: string;
}
export declare class AttentionController {
    private readonly service;
    constructor(service: AttentionService);
    list(ctx: WorkspaceContext, q: AttentionQuery): Promise<import("../contracts/domain.js").AttentionItem[]>;
    dismiss(ctx: WorkspaceContext, id: string): Promise<import("../contracts/domain.js").AttentionItem>;
    snooze(ctx: WorkspaceContext, id: string, dto: SnoozeDto): Promise<import("../contracts/domain.js").AttentionItem>;
    restore(ctx: WorkspaceContext, id: string): Promise<import("../contracts/domain.js").AttentionItem>;
}
export {};
