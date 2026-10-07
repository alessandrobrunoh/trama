import { DataSource } from 'typeorm';
import { type WorkspaceContext } from '../auth/request-context.js';
import type { AttentionItem } from '../contracts/domain.js';
import { EventsService } from '../events/events.service.js';
import { type RawAttentionItem } from './attention-rules.js';
export interface AttentionOptions {
    scope?: 'mine' | 'all';
    state?: 'open' | 'snoozed' | 'dismissed' | 'active';
}
export declare class AttentionService {
    private readonly ds;
    private readonly events;
    constructor(ds: DataSource, events: EventsService);
    forUser(ctx: WorkspaceContext, opts?: AttentionOptions): Promise<AttentionItem[]>;
    private merge;
    private find;
    private notify;
    dismiss(ctx: WorkspaceContext, id: string): Promise<AttentionItem>;
    snooze(ctx: WorkspaceContext, id: string, until: string): Promise<AttentionItem>;
    restore(ctx: WorkspaceContext, id: string): Promise<AttentionItem>;
    compute(workspaceId: string): Promise<RawAttentionItem[]>;
}
