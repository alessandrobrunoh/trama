import { DataSource, type Repository } from 'typeorm';
import type { GitProvider } from '../contracts/domain.js';
import { IntegrationConnectionEntity } from '../database/entities/index.js';
import { ArtifactLinkerService } from '../integrations/artifact-linker.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
export interface WebhookResult {
    httpStatus: 200 | 202;
    body: Record<string, unknown>;
}
export interface WebhookInput {
    provider: GitProvider;
    connectionId: string;
    rawBody: Buffer | undefined;
    payload: unknown;
    headers: Record<string, string | string[] | undefined>;
}
export declare class WebhooksService {
    private readonly ds;
    private readonly secrets;
    private readonly linker;
    private readonly connections;
    private readonly logger;
    constructor(ds: DataSource, secrets: SecretsService, linker: ArtifactLinkerService, connections: Repository<IntegrationConnectionEntity>);
    handle(input: WebhookInput): Promise<WebhookResult>;
    private parse;
    private apply;
    private claimDelivery;
    private touchConnection;
}
