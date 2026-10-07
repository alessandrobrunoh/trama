import type { Request } from 'express';
import type { Repository } from 'typeorm';
import type { ActorRef, GitProvider } from '../contracts/domain.js';
import { IntegrationConnectionEntity, RepositoryEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { RepositoriesService } from '../repositories/repositories.service.js';
import { HttpClient } from './http-client.js';
import { SecretsService } from './secrets.service.js';
export type ConnectionProvider = GitProvider | 'delta';
export interface WebhookSetup {
    url: string;
    secret: string;
    contentType: 'application/json';
    events: string[];
}
export declare const WEBHOOK_EVENTS: Record<GitProvider, string[]>;
export declare class IntegrationsService {
    private readonly http;
    private readonly secrets;
    private readonly events;
    private readonly repositories;
    private readonly repo;
    private readonly repos;
    constructor(http: HttpClient, secrets: SecretsService, events: EventsService, repositories: RepositoriesService, repo: Repository<IntegrationConnectionEntity>, repos: Repository<RepositoryEntity>);
    static publicUrl(req?: Request): string;
    webhookUrl(conn: IntegrationConnectionEntity, origin: string): string | undefined;
    present(conn: IntegrationConnectionEntity, origin: string): {
        webhookUrl: string | undefined;
        repositoryIds: string[];
        lastWebhookAt: string | undefined;
    };
    private getRow;
    list(workspaceId: string, origin: string): Promise<{
        webhookUrl: string | undefined;
        repositoryIds: string[];
        lastWebhookAt: string | undefined;
    }[]>;
    get(workspaceId: string, id: string, origin: string): Promise<{
        webhookUrl: string | undefined;
        repositoryIds: string[];
        lastWebhookAt: string | undefined;
    }>;
    private client;
    private guard;
    private baseUrlOf;
    create(workspaceId: string, _actor: ActorRef, input: {
        provider: ConnectionProvider;
        token: string;
        baseUrl?: string;
    }, origin: string): Promise<{
        connection: {
            webhookUrl: string | undefined;
            repositoryIds: string[];
            lastWebhookAt: string | undefined;
        };
        webhook: WebhookSetup | undefined;
    }>;
    private webhookSetup;
    update(workspaceId: string, id: string, patch: {
        token?: string;
        baseUrl?: string | null;
    }, origin: string): Promise<{
        webhookUrl: string | undefined;
        repositoryIds: string[];
        lastWebhookAt: string | undefined;
    }>;
    remove(workspaceId: string, id: string): Promise<void>;
    rotateWebhookSecret(workspaceId: string, id: string, origin: string): Promise<{
        connection: {
            webhookUrl: string | undefined;
            repositoryIds: string[];
            lastWebhookAt: string | undefined;
        };
        webhook: WebhookSetup;
    }>;
    remoteRepositories(workspaceId: string, id: string, page: number, perPage: number): Promise<{
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
    linkRepository(workspaceId: string, actor: ActorRef, id: string, input: {
        fullName: string;
        teamIds?: string[];
    }): Promise<{
        repository: RepositoryEntity;
        created: boolean;
    }>;
    unlinkRepository(workspaceId: string, id: string, repositoryId: string): Promise<void>;
}
