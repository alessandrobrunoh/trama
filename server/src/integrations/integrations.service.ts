import { BadGatewayException, BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import type { Repository } from 'typeorm';
import { GIT_PROVIDER_META, type ActorRef, type GitProvider } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import { IntegrationConnectionEntity, RepositoryEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { RepositoriesService } from '../repositories/repositories.service.js';
import { HttpClient, ProviderHttpError } from './http-client.js';
import { createGitClient, normalizeBaseUrl, type GitProviderClient } from './providers.js';
import { SecretsService } from './secrets.service.js';

export type ConnectionProvider = GitProvider | 'delta';

export interface WebhookSetup {
  url: string;
  /** Plain text; only ever returned by create / rotate-webhook-secret. */
  secret: string;
  contentType: 'application/json';
  events: string[];
}

export const WEBHOOK_EVENTS: Record<GitProvider, string[]> = {
  github: ['pull_request', 'check_suite', 'check_run', 'status'],
  gitlab: ['merge_request', 'pipeline'],
  bitbucket: ['pullrequest:created', 'pullrequest:updated', 'pullrequest:approved', 'pullrequest:unapproved', 'pullrequest:fulfilled', 'pullrequest:rejected', 'repo:commit_status_created', 'repo:commit_status_updated'],
};

const label = (provider: ConnectionProvider) => (provider === 'delta' ? 'Delta' : GIT_PROVIDER_META[provider].label);

const SECRET = (id: string) => `${id}:secret`;
const WEBHOOK = (id: string) => `${id}:webhook`;

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly http: HttpClient,
    private readonly secrets: SecretsService,
    private readonly events: EventsService,
    private readonly repositories: RepositoriesService,
    @InjectRepository(IntegrationConnectionEntity) private readonly repo: Repository<IntegrationConnectionEntity>,
    @InjectRepository(RepositoryEntity) private readonly repos: Repository<RepositoryEntity>,
  ) {}

  /** Public base URL for webhook URLs: `PUBLIC_URL`, else derived from the request. */
  static publicUrl(req?: Request): string {
    const env = process.env.PUBLIC_URL?.trim();
    if (env) return env.replace(/\/+$/, '');
    if (req) return `${req.protocol}://${req.get('host')}`;
    return `http://localhost:${process.env.PORT ?? 3000}`;
  }

  webhookUrl(conn: IntegrationConnectionEntity, origin: string): string | undefined {
    return conn.provider === 'delta' ? undefined : `${origin}/api/webhooks/${conn.provider}/${conn.id}`;
  }

  /** Contract IntegrationConnection plus webhookUrl, linked repository ids and the last webhook delivery time. Never secrets. */
  present(conn: IntegrationConnectionEntity, origin: string) {
    const config = conn.config as { repositoryIds?: string[]; lastWebhookAt?: string };
    return {
      ...conn.toJSON(),
      webhookUrl: this.webhookUrl(conn, origin),
      repositoryIds: config.repositoryIds ?? [],
      lastWebhookAt: config.lastWebhookAt,
    };
  }

  private async getRow(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Integration', id);
    return row;
  }

  async list(workspaceId: string, origin: string) {
    const rows = await this.repo.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
    return rows.map((r) => this.present(r, origin));
  }

  async get(workspaceId: string, id: string, origin: string) {
    return this.present(await this.getRow(workspaceId, id), origin);
  }

  private client(conn: IntegrationConnectionEntity, tokenOverride?: string): GitProviderClient {
    if (conn.provider === 'delta') throw new BadRequestException('Delta connections have no repository API yet');
    const token = tokenOverride ?? this.secrets.decrypt(conn.secret ?? '', SECRET(conn.id));
    return createGitClient(conn.provider, this.http, token, conn.baseUrl);
  }

  /** Calls the provider and maps failures to 400 (bad credential) / 502 (provider unreachable). */
  private async guard<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderHttpError) {
        if (e.status === 401 || e.status === 403 || e.status === 404)
          throw new BadRequestException(`${label} rejected the request (${e.message})`);
        throw new BadGatewayException(`${label} failed: ${e.message}`);
      }
      throw new BadGatewayException(`${label} is unreachable: ${(e as Error).message}`);
    }
  }

  private baseUrlOf(provider: ConnectionProvider, raw?: string | null): string | null {
    try {
      const url = normalizeBaseUrl(raw);
      if (provider === 'delta' && !url) throw new Error('baseUrl is required for Delta');
      if (provider !== 'delta' && url && !GIT_PROVIDER_META[provider].selfHosted)
        throw new Error(`${label(provider)} has no custom base URL`);
      return url;
    } catch (e) {
      throw new BadRequestException(`Invalid baseUrl: ${(e as Error).message}`);
    }
  }

  async create(
    workspaceId: string,
    _actor: ActorRef,
    input: { provider: ConnectionProvider; token: string; baseUrl?: string },
    origin: string,
  ) {
    const baseUrl = this.baseUrlOf(input.provider, input.baseUrl);
    const id = uid('ic');
    let account: string;
    if (input.provider === 'delta') account = new URL(baseUrl!).host; // stub: no validation call yet
    else {
      const client = createGitClient(input.provider, this.http, input.token, baseUrl);
      account = (await this.guard(label(input.provider), () => client.currentUser())).account;
    }
    const defaultBase = input.provider === 'delta' ? null : `https://${GIT_PROVIDER_META[input.provider].host}`;
    const stored = baseUrl && baseUrl !== defaultBase ? baseUrl : input.provider === 'delta' ? baseUrl : null;
    const clash = (await this.repo.findBy({ workspaceId, provider: input.provider, account })).some((c) => (c.baseUrl ?? null) === stored);
    if (clash) throw new ConflictException(`A ${input.provider} connection for "${account}" already exists`);

    const webhookSecret = input.provider === 'delta' ? null : SecretsService.generateWebhookSecret();
    const row = await this.repo.save(
      this.repo.create({
        id,
        workspaceId,
        provider: input.provider,
        account,
        baseUrl: stored,
        secret: this.secrets.encrypt(input.token, SECRET(id)),
        webhookSecret: webhookSecret ? this.secrets.encrypt(webhookSecret, WEBHOOK(id)) : null,
        status: 'connected',
        config: { repositoryIds: [] },
      }),
    );
    this.events.publish(workspaceId, { type: 'created', entity: 'integration', id });
    return {
      connection: this.present(row, origin),
      webhook: webhookSecret ? this.webhookSetup(row, origin, webhookSecret) : undefined,
    };
  }

  private webhookSetup(conn: IntegrationConnectionEntity, origin: string, secret: string): WebhookSetup {
    return {
      url: this.webhookUrl(conn, origin)!,
      secret,
      contentType: 'application/json',
      events: WEBHOOK_EVENTS[conn.provider as GitProvider],
    };
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { token?: string; baseUrl?: string | null },
    origin: string,
  ) {
    const row = await this.getRow(workspaceId, id);
    if (patch.baseUrl !== undefined) {
      const base = this.baseUrlOf(row.provider, patch.baseUrl);
      if (row.provider !== 'delta' && !base) row.baseUrl = null;
      else row.baseUrl = base;
    }
    if (patch.token !== undefined || patch.baseUrl !== undefined) {
      if (row.provider !== 'delta') {
        const token = patch.token ?? this.secrets.decrypt(row.secret ?? '', SECRET(id));
        const client = this.client(row, token);
        row.account = (await this.guard(label(row.provider), () => client.currentUser())).account;
        row.status = 'connected';
        row.lastError = null;
      }
      if (patch.token !== undefined) row.secret = this.secrets.encrypt(patch.token, SECRET(id));
    }
    await this.repo.save(row);
    this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
    return this.present(row, origin);
  }

  async remove(workspaceId: string, id: string) {
    await this.getRow(workspaceId, id);
    await this.repo.delete({ id });
    this.events.publish(workspaceId, { type: 'deleted', entity: 'integration', id });
  }

  async rotateWebhookSecret(workspaceId: string, id: string, origin: string) {
    const row = await this.getRow(workspaceId, id);
    if (row.provider === 'delta') throw new BadRequestException('Delta connections have no webhook');
    const secret = SecretsService.generateWebhookSecret();
    row.webhookSecret = this.secrets.encrypt(secret, WEBHOOK(id));
    await this.repo.save(row);
    this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
    return { connection: this.present(row, origin), webhook: this.webhookSetup(row, origin, secret) };
  }

  async remoteRepositories(workspaceId: string, id: string, page: number, perPage: number) {
    const row = await this.getRow(workspaceId, id);
    const result = await this.guard(label(row.provider), () => this.client(row).listRepositories(page, perPage));
    const local = await this.repos.findBy({ workspaceId, provider: row.provider as GitProvider });
    const byName = new Map(local.map((r) => [r.fullName.toLowerCase(), r.id]));
    return {
      ...result,
      items: result.items.map((r) => ({ ...r, repositoryId: byName.get(r.fullName.toLowerCase()), linked: byName.has(r.fullName.toLowerCase()) })),
    };
  }

  /** Verifies the repository is visible to the token, creates (or adopts) the Repository row and attaches it to this connection. */
  async linkRepository(workspaceId: string, actor: ActorRef, id: string, input: { fullName: string; teamIds?: string[] }) {
    const row = await this.getRow(workspaceId, id);
    if (row.provider === 'delta') throw new BadRequestException('Delta connections cannot link repositories');
    const provider = row.provider;
    const remote = await this.guard(label(provider), () => this.client(row).getRepository(input.fullName));
    const existing = await this.repos
      .createQueryBuilder('r')
      .where('r.workspaceId = :workspaceId AND r.provider = :provider AND lower(r.fullName) = lower(:n)', { workspaceId, provider, n: remote.fullName })
      .getOne();
    let created = false;
    let repository: RepositoryEntity;
    if (existing) repository = existing;
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
    const config = row.config as { repositoryIds?: string[] };
    const ids = new Set(config.repositoryIds ?? []);
    ids.add(repository.id);
    row.config = { ...row.config, repositoryIds: [...ids] };
    await this.repo.save(row);
    this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
    return { repository, created };
  }

  async unlinkRepository(workspaceId: string, id: string, repositoryId: string) {
    const row = await this.getRow(workspaceId, id);
    const config = row.config as { repositoryIds?: string[] };
    row.config = { ...row.config, repositoryIds: (config.repositoryIds ?? []).filter((r) => r !== repositoryId) };
    await this.repo.save(row);
    this.events.publish(workspaceId, { type: 'updated', entity: 'integration', id });
  }
}
