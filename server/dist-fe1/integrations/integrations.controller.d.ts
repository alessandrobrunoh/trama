import type { Request, Response } from 'express';
import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef } from '../contracts/domain.js';
import { IntegrationsService, type ConnectionProvider } from './integrations.service.js';
declare class CreateIntegrationDto {
    provider: ConnectionProvider;
    token: string;
    baseUrl?: string;
}
declare class UpdateIntegrationDto {
    token?: string;
    baseUrl?: string | null;
}
declare class RemoteReposQuery {
    page?: number;
    perPage?: number;
}
declare class LinkRepositoryDto {
    fullName: string;
    teamIds?: string[];
}
export declare class IntegrationsController {
    private readonly service;
    constructor(service: IntegrationsService);
    list(ctx: WorkspaceContext, req: Request): Promise<{
        webhookUrl: string | undefined;
        repositoryIds: string[];
        lastWebhookAt: string | undefined;
    }[]>;
    get(ctx: WorkspaceContext, id: string, req: Request): Promise<{
        webhookUrl: string | undefined;
        repositoryIds: string[];
        lastWebhookAt: string | undefined;
    }>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateIntegrationDto, req: Request): Promise<{
        connection: {
            webhookUrl: string | undefined;
            repositoryIds: string[];
            lastWebhookAt: string | undefined;
        };
        webhook: import("./integrations.service.js").WebhookSetup | undefined;
    }>;
    update(ctx: WorkspaceContext, id: string, dto: UpdateIntegrationDto, req: Request): Promise<{
        webhookUrl: string | undefined;
        repositoryIds: string[];
        lastWebhookAt: string | undefined;
    }>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
    rotate(ctx: WorkspaceContext, id: string, req: Request): Promise<{
        connection: {
            webhookUrl: string | undefined;
            repositoryIds: string[];
            lastWebhookAt: string | undefined;
        };
        webhook: import("./integrations.service.js").WebhookSetup;
    }>;
    remote(ctx: WorkspaceContext, id: string, q: RemoteReposQuery): Promise<{
        items: {
            repositoryId: string | undefined;
            linked: boolean;
            fullName: string;
            url: string;
            defaultBranch: string;
            private?: boolean;
            description?: string;
        }[];
        page: number;
        perPage: number;
        hasMore: boolean;
    }>;
    link(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: LinkRepositoryDto, res: Response): Promise<import("../database/entities/index.js").RepositoryEntity>;
    unlink(ctx: WorkspaceContext, id: string, repositoryId: string): Promise<void>;
}
export {};
