var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var WebhooksService_1;
import { BadRequestException, HttpException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IntegrationConnectionEntity, RepositoryEntity } from '../database/entities/index.js';
import { ArtifactLinkerService } from '../integrations/artifact-linker.service.js';
import { WebhookDeliveryEntity } from '../integrations/entities.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { PayloadError, parseGithubEvent, parseGitlabEvent } from './events.js';
import { verifyGithubSignature, verifyGitlabToken } from './signatures.js';
const header = (h, name) => {
    const v = h[name];
    return Array.isArray(v) ? v[0] : v;
};
let WebhooksService = WebhooksService_1 = class WebhooksService {
    ds;
    secrets;
    linker;
    connections;
    logger = new Logger(WebhooksService_1.name);
    constructor(ds, secrets, linker, connections) {
        this.ds = ds;
        this.secrets = secrets;
        this.linker = linker;
        this.connections = connections;
    }
    async handle(input) {
        const conn = await this.connections.findOneBy({ id: input.connectionId, provider: input.provider });
        if (!conn)
            throw new NotFoundException('Unknown webhook endpoint');
        if (!conn.webhookSecret)
            throw new UnauthorizedException('Webhook secret not configured');
        let secret;
        try {
            secret = this.secrets.decrypt(conn.webhookSecret, `${conn.id}:webhook`);
        }
        catch {
            this.logger.error(`Cannot decrypt the webhook secret of ${conn.id} (NABLA_ENCRYPTION_KEY changed?)`);
            throw new UnauthorizedException('Webhook secret unavailable');
        }
        const valid = input.provider === 'github'
            ? !!input.rawBody && verifyGithubSignature(secret, input.rawBody, header(input.headers, 'x-hub-signature-256'))
            : verifyGitlabToken(secret, header(input.headers, 'x-gitlab-token'));
        if (!valid)
            throw new UnauthorizedException('Invalid webhook signature');
        const deliveryId = header(input.headers, input.provider === 'github' ? 'x-github-delivery' : 'x-gitlab-event-uuid');
        if (deliveryId && !(await this.claimDelivery(conn.id, deliveryId)))
            return { httpStatus: 200, body: { status: 'duplicate' } };
        try {
            const parsed = this.parse(input);
            const result = await this.apply(conn, parsed);
            void this.touchConnection(conn);
            return result;
        }
        catch (e) {
            if (deliveryId && !(e instanceof PayloadError || (e instanceof HttpException && e.getStatus() < 500)))
                await this.ds.getRepository(WebhookDeliveryEntity).delete({ id: `${conn.id}:${deliveryId}` });
            if (e instanceof PayloadError)
                throw new BadRequestException(`Malformed webhook payload: ${e.message}`);
            throw e;
        }
    }
    parse(input) {
        if (input.payload === undefined || input.payload === null || typeof input.payload !== 'object')
            throw new PayloadError('body must be a JSON object');
        if (input.provider === 'github') {
            const event = header(input.headers, 'x-github-event');
            if (!event)
                throw new PayloadError('missing X-GitHub-Event header');
            return parseGithubEvent(event, input.payload);
        }
        return parseGitlabEvent(input.payload);
    }
    async apply(conn, parsed) {
        if (parsed.kind === 'ping')
            return { httpStatus: 200, body: { status: 'pong' } };
        if (parsed.kind === 'ignored')
            return { httpStatus: 202, body: { status: 'ignored', reason: parsed.reason } };
        const repo = await this.ds
            .getRepository(RepositoryEntity)
            .createQueryBuilder('r')
            .where('r.workspaceId = :w AND r.provider = :p AND lower(r.fullName) = lower(:n)', { w: conn.workspaceId, p: conn.provider, n: parsed.repo.fullName })
            .getOne();
        if (!repo)
            return { httpStatus: 202, body: { status: 'ignored', reason: `repository ${parsed.repo.fullName} is not linked` } };
        if (parsed.kind === 'ci') {
            const updated = await this.linker.applyCi(conn.workspaceId, repo, parsed.patch);
            return updated
                ? { httpStatus: 200, body: { status: 'processed', artifactsUpdated: updated } }
                : { httpStatus: 202, body: { status: 'ignored', reason: 'no matching pull/merge request' } };
        }
        const res = await this.linker.upsert(conn.workspaceId, repo, parsed.candidate);
        if (!res.created && !res.updated && !res.workstreamKeys.length)
            return { httpStatus: 202, body: { status: 'ignored', reason: 'no workstream key found' } };
        return {
            httpStatus: 200,
            body: { status: 'processed', artifactsCreated: res.created, artifactsUpdated: res.updated, workstreams: res.workstreamKeys },
        };
    }
    async claimDelivery(connectionId, deliveryId) {
        const rows = await this.ds.query(`INSERT INTO "webhook_deliveries" ("id","connectionId") VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING "id"`, [`${connectionId}:${deliveryId}`, connectionId]);
        if (Math.random() < 0.02)
            void this.ds.query(`DELETE FROM "webhook_deliveries" WHERE "receivedAt" < now() - interval '7 days'`).catch(() => undefined);
        return rows.length > 0;
    }
    async touchConnection(conn) {
        try {
            const last = conn.config.lastWebhookAt;
            if (last && Date.now() - Date.parse(last) < 60_000)
                return;
            await this.ds.query(`UPDATE "integration_connections" SET "config" = "config" || jsonb_build_object('lastWebhookAt', $2::text) WHERE "id" = $1`, [conn.id, new Date().toISOString()]);
        }
        catch (e) {
            this.logger.warn(`lastWebhookAt update failed: ${e.message}`);
        }
    }
};
WebhooksService = WebhooksService_1 = __decorate([
    Injectable(),
    __param(3, InjectRepository(IntegrationConnectionEntity)),
    __metadata("design:paramtypes", [DataSource,
        SecretsService,
        ArtifactLinkerService, Function])
], WebhooksService);
export { WebhooksService };
//# sourceMappingURL=webhooks.service.js.map