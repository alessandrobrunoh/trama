import { BadGatewayException, BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { In, type FindOptionsWhere, type Repository } from 'typeorm';
import {
  GIT_PROVIDER_META,
  connectionHost,
  type ActorRef,
  type GitProvider,
  type IntegrationConnection,
} from '../contracts/domain.js';
import { outboundUrlProblem } from '../common/safe-fetch.js';
import { notFound, uid } from '../common/util.js';
import { IntegrationConnectionEntity, UserEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { ExternalIdentitiesService } from '../external-identities/external-identities.service.js';
import { HttpClient, ProviderHttpError } from './http-client.js';
import { createGitClient, normalizeBaseUrl, type GitProviderClient } from './providers.js';
import { SecretsService } from './secrets.service.js';

export type ConnectionProvider = GitProvider | 'delta';

/**
 * Whose connections a call works on: a workspace's (managed by whoever has the integrations
 * permission) or one person's (only that person). Every lookup is filtered by it, so a personal
 * connection is simply "not found" for anyone else.
 */
export type ConnectionScope =
  | { type: 'workspace'; workspaceId: string }
  | { type: 'user'; userId: string };

export interface WebhookSetup {
  url: string;
  /** Plain text; only ever returned by create / rotate-webhook-secret. */
  secret: string;
  contentType: 'application/json';
  events: string[];
}

/** Contract connection plus the webhook URL and last delivery time. Never secrets. */
export type PresentedConnection = IntegrationConnection & {
  webhookUrl?: string;
  lastWebhookAt?: string;
};

export const WEBHOOK_EVENTS: Record<GitProvider, string[]> = {
  github: ['pull_request', 'issues', 'check_suite', 'check_run', 'status'],
  gitlab: ['merge_request', 'issue', 'pipeline'],
  bitbucket: ['pullrequest:created', 'pullrequest:updated', 'pullrequest:approved', 'pullrequest:unapproved', 'pullrequest:fulfilled', 'pullrequest:rejected', 'repo:commit_status_created', 'repo:commit_status_updated'],
};

const label = (provider: ConnectionProvider) => (provider === 'delta' ? 'Delta' : GIT_PROVIDER_META[provider].label);

const SECRET = (id: string) => `${id}:secret`;
const WEBHOOK = (id: string) => `${id}:webhook`;

const ownedBy = (scope: ConnectionScope): FindOptionsWhere<IntegrationConnectionEntity> =>
  scope.type === 'workspace'
    ? { ownerType: 'workspace', workspaceId: scope.workspaceId }
    : { ownerType: 'user', ownerUserId: scope.userId };

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly http: HttpClient,
    private readonly secrets: SecretsService,
    private readonly events: EventsService,
    @InjectRepository(IntegrationConnectionEntity) private readonly repo: Repository<IntegrationConnectionEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @Optional() private readonly identities?: ExternalIdentitiesService,
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

  /**
   * The contract `IntegrationConnection` of each row, with the owner's display name for personal ones.
   * Tokens and webhook secrets are never part of it (`secret` / `webhookSecret` are hidden on the entity).
   */
  async summarize(rows: IntegrationConnectionEntity[]): Promise<IntegrationConnection[]> {
    const ids = [...new Set(rows.map((r) => r.ownerUserId).filter((id): id is string => !!id))];
    const names = new Map<string, string>();
    if (ids.length) for (const u of await this.users.find({ where: { id: In(ids) }, select: { id: true, name: true } })) names.set(u.id, u.name);
    return rows.map((r) => ({
      ...(r.toJSON() as unknown as IntegrationConnection),
      ...(r.ownerUserId && names.has(r.ownerUserId) ? { ownerName: names.get(r.ownerUserId) } : {}),
    }));
  }

  /** `summarize` plus the webhook URL and the last delivery time (for the people who manage the connection). */
  async present(conn: IntegrationConnectionEntity, origin: string): Promise<PresentedConnection> {
    const [base] = await this.summarize([conn]);
    const config = conn.config as { lastWebhookAt?: string };
    return { ...base, webhookUrl: this.webhookUrl(conn, origin), lastWebhookAt: config.lastWebhookAt };
  }

  private async getRow(scope: ConnectionScope, id: string) {
    const row = await this.repo.findOneBy({ ...ownedBy(scope), id });
    if (!row) throw notFound('Integration', id);
    return row;
  }

  private publish(scope: ConnectionScope, type: 'created' | 'updated' | 'deleted', id: string) {
    // Personal connections have no workspace stream; the owner's page refetches after its own calls.
    if (scope.type === 'workspace') this.events.publish(scope.workspaceId, { type, entity: 'integration', id });
  }

  async list(scope: ConnectionScope, origin: string) {
    const rows = await this.repo.find({ where: ownedBy(scope), order: { createdAt: 'ASC' } });
    return Promise.all(rows.map((r) => this.present(r, origin)));
  }

  async get(scope: ConnectionScope, id: string, origin: string) {
    return this.present(await this.getRow(scope, id), origin);
  }

  private client(conn: IntegrationConnectionEntity, tokenOverride?: string): GitProviderClient {
    if (conn.provider === 'delta') throw new BadRequestException('Delta connections have no repository API yet');
    if (conn.status === 'revoked' && tokenOverride === undefined)
      throw new BadRequestException('This connection was revoked. Reconnect it with a new token.');
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

  /** Normalizes the base URL and refuses ones that point at internal addresses (SSRF), with a 400. */
  private async baseUrlOf(provider: ConnectionProvider, raw?: string | null): Promise<string | null> {
    let normalized: string | null;
    try {
      const url = normalizeBaseUrl(raw);
      if (provider === 'delta' && !url) throw new Error('baseUrl is required for Delta');
      if (provider !== 'delta' && url && !GIT_PROVIDER_META[provider].selfHosted)
        throw new Error(`${label(provider)} has no custom base URL`);
      normalized = url;
    } catch (e) {
      throw new BadRequestException(`Invalid baseUrl: ${(e as Error).message}`);
    }
    if (normalized) {
      const problem = await outboundUrlProblem(normalized);
      if (problem) throw new BadRequestException(`Invalid baseUrl: ${problem}`);
    }
    return normalized;
  }

  /** Display name of a new connection when the caller gives none: "GitHub · octo". */
  static defaultLabel(provider: ConnectionProvider, account: string): string {
    return `${label(provider)} · ${account}`;
  }

  async create(
    scope: ConnectionScope,
    _actor: ActorRef,
    input: { provider: ConnectionProvider; token: string; baseUrl?: string; label?: string },
    origin: string,
  ) {
    const baseUrl = await this.baseUrlOf(input.provider, input.baseUrl);
    const id = uid('ic');
    let account: string;
    if (input.provider === 'delta') account = new URL(baseUrl!).host; // stub: no validation call yet
    else {
      const client = createGitClient(input.provider, this.http, input.token, baseUrl);
      account = (await this.guard(label(input.provider), () => client.currentUser())).account;
    }
    const defaultBase = input.provider === 'delta' ? null : `https://${GIT_PROVIDER_META[input.provider].host}`;
    const stored = baseUrl && baseUrl !== defaultBase ? baseUrl : input.provider === 'delta' ? baseUrl : null;
    const host = connectionHost(input.provider, stored);
    // Several accounts per provider are fine; the same account on the same host twice for one owner is not.
    const clash = (await this.repo.findBy({ ...ownedBy(scope), provider: input.provider, account })).some((c) => c.host === host);
    if (clash) throw new ConflictException(`A ${input.provider} connection for "${account}" already exists`);

    const webhookSecret = input.provider === 'delta' ? null : SecretsService.generateWebhookSecret();
    const row = await this.repo.save(
      this.repo.create({
        id,
        ownerType: scope.type === 'workspace' ? 'workspace' : 'user',
        workspaceId: scope.type === 'workspace' ? scope.workspaceId : null,
        ownerUserId: scope.type === 'user' ? scope.userId : null,
        label: input.label?.trim() || IntegrationsService.defaultLabel(input.provider, account),
        provider: input.provider,
        account,
        host,
        baseUrl: stored,
        secret: this.secrets.encrypt(input.token, SECRET(id)),
        webhookSecret: webhookSecret ? this.secrets.encrypt(webhookSecret, WEBHOOK(id)) : null,
        status: 'connected',
        config: {},
      }),
    );
    this.publish(scope, 'created', id);
    // A personal connection proves its account login: record it as one of the owner's identities.
    if (scope.type === 'user' && input.provider !== 'delta') {
      await this.identities?.ensureFromConnection(scope.userId, input.provider, host, account);
    }
    return {
      connection: await this.present(row, origin),
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

  /**
   * Rename, and/or give a new token or base URL (which re-validates against the provider and brings a
   * revoked or failing connection back to `connected`).
   */
  async update(
    scope: ConnectionScope,
    id: string,
    patch: { token?: string; baseUrl?: string | null; label?: string },
    origin: string,
  ) {
    const row = await this.getRow(scope, id);
    if (patch.baseUrl !== undefined) {
      const base = await this.baseUrlOf(row.provider, patch.baseUrl);
      const next = row.provider !== 'delta' && !base ? null : base;
      // The stored token would be sent to the new host to validate it: never without the owner supplying it again.
      if (row.provider !== 'delta' && next !== (row.baseUrl ?? null) && patch.token === undefined)
        throw new BadRequestException('Enter the access token again when you change the base URL');
      row.baseUrl = next;
      row.host = connectionHost(row.provider, next);
    }
    // A revoked connection has no token left to re-check; only a new token brings it back.
    const revalidate = patch.token !== undefined || (patch.baseUrl !== undefined && row.status !== 'revoked');
    if (revalidate) {
      if (row.provider !== 'delta') {
        const token = patch.token ?? this.secrets.decrypt(row.secret ?? '', SECRET(id));
        const client = this.client(row, token);
        row.account = (await this.guard(label(row.provider), () => client.currentUser())).account;
        row.status = 'connected';
        row.lastError = null;
      }
      if (patch.token !== undefined) {
        row.secret = this.secrets.encrypt(patch.token, SECRET(id));
        if (row.provider === 'delta') {
          row.status = 'connected';
          row.lastError = null;
        }
      }
    }
    if (patch.label !== undefined) row.label = patch.label.trim();
    await this.repo.save(row);
    this.publish(scope, 'updated', id);
    return this.present(row, origin);
  }

  /**
   * Withdraws the credential on purpose: the token is wiped and the status becomes `revoked` with a
   * reason in `lastError`. The row stays, so whatever reads through it (routing rules) can show
   * "reconnect, or switch to another connection" instead of failing silently. A new token via
   * `update` brings it back.
   */
  async revoke(scope: ConnectionScope, id: string, origin: string) {
    const row = await this.getRow(scope, id);
    row.status = 'revoked';
    row.secret = null;
    row.lastError = 'Revoked';
    await this.repo.save(row);
    this.publish(scope, 'updated', id);
    return this.present(row, origin);
  }

  async remove(scope: ConnectionScope, id: string) {
    await this.getRow(scope, id);
    await this.repo.delete({ id });
    this.publish(scope, 'deleted', id);
  }

  async rotateWebhookSecret(scope: ConnectionScope, id: string, origin: string) {
    const row = await this.getRow(scope, id);
    if (row.provider === 'delta') throw new BadRequestException('Delta connections have no webhook');
    const secret = SecretsService.generateWebhookSecret();
    row.webhookSecret = this.secrets.encrypt(secret, WEBHOOK(id));
    await this.repo.save(row);
    this.publish(scope, 'updated', id);
    return { connection: await this.present(row, origin), webhook: this.webhookSetup(row, origin, secret) };
  }

  async remoteRepositories(scope: ConnectionScope, id: string, page: number, perPage: number) {
    const row = await this.getRow(scope, id);
    const client = this.client(row); // a revoked or Delta connection is a 400 here, not a provider failure
    return this.guard(label(row.provider), () => client.listRepositories(page, perPage));
  }
}
