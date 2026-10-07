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
import { BadGatewayException, BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { notFound, uid } from '../common/util.js';
import { IntegrationConnectionEntity, RepositoryEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { RepositoriesService } from '../repositories/repositories.service.js';
import { HttpClient, ProviderHttpError } from './http-client.js';
import { createGitClient, normalizeBaseUrl } from './providers.js';
import { SecretsService } from './secrets.service.js';
export const WEBHOOK_EVENTS = {
    github: ['pull_request', 'check_suite', 'check_run', 'status'],
    gitlab: ['merge_request', 'pipeline'],
};
const SECRET = (id) => `${id}:secret`;
const WEBHOOK = (id) => `${id}:webhook`;
let IntegrationsService = class IntegrationsService {
    http;
    secrets;
    events;
    repositories;
    repo;
    repos;
    constructor(http, secrets, events, repositories, repo, repos) {
        this.http = http;
        this.secrets = secrets;
        this.events = events;
        this.repositories = repositories;
        this.repo = repo;
        this.repos = repos;
    }
    static publicUrl(req) {
        const env = process.env.PUBLIC_URL?.trim();
        if (env)
            return env.replace(/\/+$/, '');
        if (req)
            return `${req.protocol}://${req.get('host')}`;
        return `http://localhost:${process.env.PORT ?? 3000}`;
    }
    webhookUrl(conn, origin) {
        return conn.provider === 'delta' ? undefined : `${origin}/api/webhooks/${conn.provider}/${conn.id}`;
    }
    present(conn, origin) {
        const config = conn.config;
        return {
            ...conn.toJSON(),
            webhookUrl: this.webhookUrl(conn, origin),
            repositoryIds: config.repositoryIds ?? [],
            lastWebhookAt: config.lastWebhookAt,
        };
    }
    async getRow(workspaceId, id) {
        const row = await this.repo.findOneBy({ workspaceId, id });
        if (!row)
            throw notFound('Integration', id);
        return row;
    }
    async list(workspaceId, origin) {
        const rows = await this.repo.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
        return rows.map((r) => this.present(r, origin));
    }
    async get(workspaceId, id, origin) {
        return this.present(await this.getRow(workspaceId, id), origin);
    }
    client(conn, tokenOverride) {
        if (conn.provider === 'delta')
            throw new BadRequestException('Delta connections have no repository API yet');
        const token = tokenOverride ?? this.secrets.decrypt(conn.secret ?? '', SECRET(conn.id));
        return createGitClient(conn.provider, this.http, token, conn.baseUrl);
    }
    async guard(label, fn) {
        try {
            return await fn();
        }
        catch (e) {
            if (e instanceof ProviderHttpError) {
                if (e.status === 401 || e.status === 403 || e.status === 404)
                    throw new BadRequestException(`${label} rejected the request (${e.message})`);
                throw new BadGatewayException(`${label} failed: ${e.message}`);
            }
            throw new BadGatewayException(`${label} is unreachable: ${e.message}`);
        }
    }
    baseUrlOf(provider, raw) {
        try {
            const url = normalizeBaseUrl(raw);
            if (provider === 'delta' && !url)
                throw new Error('baseUrl is required for Delta');
            return url;
        }
        catch (e) {
            throw new BadRequestException(`Invalid baseUrl: ${e.message}`);
        }
    }
    async create(workspaceId, _actor, input, origin) {
        const baseUrl = this.baseUrlOf(input.provider, input.baseUrl);
        const id = uid('ic');
        let account;
        if (input.provider === 'delta')
            account = new URL(baseUrl).host;
        else {
            const client = createGitClient(input.provider, this.http, input.token, baseUrl);
            account = (await this.guard(input.provider === 'github' ? 'GitHub' : 'GitLab', () => client.currentUser())).account;
        }
        const defaultBase = input.provider === 'github' ? 'https://github.com' : input.provider === 'gitlab' ? 'https://gitlab.com' : null;
        const stored = baseUrl && baseUrl !== defaultBase ? baseUrl : input.provider === 'delta' ? baseUrl : null;
        const clash = (await this.repo.findBy({ workspaceId, provider: input.provider, account })).some((c) => (c.baseUrl ?? null) === stored);
        if (clash)
            throw new ConflictException(`A ${input.provider} connection for "${account}" already exists`);
        const webhookSecret = input.provider === 'delta' ? null : SecretsService.generateWebhookSecret();
        const row = await this.repo.save(this.repo.create({
            id,
            workspaceId,
            provider: input.provider,
            account,
            baseUrl: stored,
            secret: this.secrets.encrypt(input.token, SECRET(id)),
            webhookSecret: webhookSecret ? this.secrets.encrypt(webhookSecret, WEBHOOK(id)) : null,
            status: 'connected',
            config: { repositoryIds: [] },
        }));
        this.events.publish(workspaceId, { type: 'created', entity: 'integration', id });
        return {
            connection: this.present(row, origin),
            webhook: webhookSecret ? this.webhookSetup(row, origin, webhookSecret) : undefined,
        };
    }
    webhookSetup(conn, origin, secret) {
        return {
            url: this.webhookUrl(conn, origin),
            secret,
            contentType: 'application/json',
            events: WEBHOOK_EVENTS[conn.provider],
        };
    }
    async update(workspaceId, id, patch, origin) {
        const row = await this.getRow(workspaceId, id);
        if (patch.baseUrl !== undefined) {
            const base = this.baseUrlOf(row.provider, patch.baseUrl);
            if (row.provider !== 'delta' && !base)
                row.baseUrl = null;
            else
                row.baseUrl = base;
        }
        if (patch.token !== undefined || patch.baseUrl !== undefined) {
            if (row.provider !== 'delta') {
                const token = patch.token ?? this.secrets.decrypt(row.secret ?? '', SECRET(id));
                const client = this.client(row, token);
                row.account = (await this.guard(row.provider === 'github' ? 'GitHub' : 'GitLab', () => client.currentUser())).account;
                row.status = 'connected';
                row.lastError = null;
            }
            if (patch.token !== undefined)
                row.secret = this.secrets.encrypt(patch.token, SECRET(id));
        }
        await this.repo.save(row);
        this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
        return this.present(row, origin);
    }
    async remove(workspaceId, id) {
        await this.getRow(workspaceId, id);
        await this.repo.delete({ id });
        this.events.publish(workspaceId, { type: 'deleted', entity: 'integration', id });
    }
    async rotateWebhookSecret(workspaceId, id, origin) {
        const row = await this.getRow(workspaceId, id);
        if (row.provider === 'delta')
            throw new BadRequestException('Delta connections have no webhook');
        const secret = SecretsService.generateWebhookSecret();
        row.webhookSecret = this.secrets.encrypt(secret, WEBHOOK(id));
        await this.repo.save(row);
        this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
        return { connection: this.present(row, origin), webhook: this.webhookSetup(row, origin, secret) };
    }
    async remoteRepositories(workspaceId, id, page, perPage) {
        const row = await this.getRow(workspaceId, id);
        const result = await this.guard(row.provider === 'github' ? 'GitHub' : 'GitLab', () => this.client(row).listRepositories(page, perPage));
        const local = await this.repos.findBy({ workspaceId, provider: row.provider });
        const byName = new Map(local.map((r) => [r.fullName.toLowerCase(), r.id]));
        return {
            ...result,
            items: result.items.map((r) => ({ ...r, repositoryId: byName.get(r.fullName.toLowerCase()), linked: byName.has(r.fullName.toLowerCase()) })),
        };
    }
    async linkRepository(workspaceId, actor, id, input) {
        const row = await this.getRow(workspaceId, id);
        if (row.provider === 'delta')
            throw new BadRequestException('Delta connections cannot link repositories');
        const provider = row.provider;
        const remote = await this.guard(provider === 'github' ? 'GitHub' : 'GitLab', () => this.client(row).getRepository(input.fullName));
        const existing = await this.repos
            .createQueryBuilder('r')
            .where('r.workspaceId = :workspaceId AND r.provider = :provider AND lower(r.fullName) = lower(:n)', { workspaceId, provider, n: remote.fullName })
            .getOne();
        let created = false;
        let repository;
        if (existing)
            repository = existing;
        else {
            repository = await this.repositories.create(workspaceId, actor, {
                provider,
                fullName: remote.fullName,
                url: remote.url,
                defaultBranch: remote.defaultBranch,
                teamIds: input.teamIds,
            });
            created = true;
        }
        const config = row.config;
        const ids = new Set(config.repositoryIds ?? []);
        ids.add(repository.id);
        row.config = { ...row.config, repositoryIds: [...ids] };
        await this.repo.save(row);
        this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
        return { repository, created };
    }
    async unlinkRepository(workspaceId, id, repositoryId) {
        const row = await this.getRow(workspaceId, id);
        const config = row.config;
        row.config = { ...row.config, repositoryIds: (config.repositoryIds ?? []).filter((r) => r !== repositoryId) };
        await this.repo.save(row);
        this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
    }
};
IntegrationsService = __decorate([
    Injectable(),
    __param(4, InjectRepository(IntegrationConnectionEntity)),
    __param(5, InjectRepository(RepositoryEntity)),
    __metadata("design:paramtypes", [HttpClient,
        SecretsService,
        EventsService,
        RepositoriesService, Function, Function])
], IntegrationsService);
export { IntegrationsService };
//# sourceMappingURL=integrations.service.js.map