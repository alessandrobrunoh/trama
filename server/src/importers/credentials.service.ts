import { BadGatewayException, BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { ActorRef, ExternalProvider, ImportCredentialRef } from '../contracts/domain.js';
import { outboundUrlProblem } from '../common/safe-fetch.js';
import { notFound, uid } from '../common/util.js';
import { IntegrationConnectionEntity } from '../database/entities/index.js';
import { HttpClient, ProviderHttpError } from '../integrations/http-client.js';
import { createGitClient, normalizeBaseUrl } from '../integrations/providers.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { GithubAdapter } from './github-adapter.js';
import { LinearAdapter } from './linear-adapter.js';
import { TrackerCredentialEntity } from './entities.js';
import { redactSecrets } from './mapping.js';
import type { ImportSourceAdapter } from './types.js';

const TRACKER = (id: string) => `${id}:tracker`;
/** Same additional data the integrations module binds a connection's token to. */
const CONNECTION_SECRET = (id: string) => `${id}:secret`;

export interface ResolvedCredential {
  /** `null` = unauthenticated (public GitHub only). */
  token: string | null;
  baseUrl: string | null;
}

/** Turns a failed provider call into the HTTP error the caller should see. The message never carries a token. */
export function providerFailure(label: string, e: unknown, secrets: readonly (string | null)[] = []): HttpException {
  if (e instanceof HttpException) return e;
  if (e instanceof ProviderHttpError) {
    const message = redactSecrets(e.message, secrets);
    if (e.rateLimited) return new HttpException(`${label} rate limit reached; try again after ${e.rateLimitedUntil!.toISOString()}`, 429);
    if (e.status === 401 || e.status === 403 || e.status === 404) return new BadRequestException(`${label} rejected the request (${message})`);
    return new BadGatewayException(`${label} failed: ${message}`);
  }
  return new BadGatewayException(`${label} is unreachable: ${redactSecrets((e as Error).message ?? String(e), secrets)}`);
}

export function createAdapter(
  http: HttpClient,
  provider: ExternalProvider,
  cred: ResolvedCredential,
  source: { repository?: string; teamIds?: string[] },
): ImportSourceAdapter {
  if (provider === 'github') {
    if (!source.repository) throw new BadRequestException('source.repository is required (owner/name)');
    return new GithubAdapter(http, cred.token, source.repository, cred.baseUrl);
  }
  if (!cred.token) throw new BadRequestException('A Linear API key is required');
  return new LinearAdapter(http, cred.token, source.teamIds ?? []);
}

/** Tracker credentials of a workspace: encrypted at rest, scoped by workspace, never returned. */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly http: HttpClient,
    private readonly secrets: SecretsService,
    @InjectRepository(TrackerCredentialEntity) private readonly repo: Repository<TrackerCredentialEntity>,
    @InjectRepository(IntegrationConnectionEntity) private readonly connections: Repository<IntegrationConnectionEntity>,
  ) {}

  list(workspaceId: string) {
    return this.repo.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
  }

  async create(
    workspaceId: string,
    actor: ActorRef,
    input: { provider: ExternalProvider; token: string; baseUrl?: string },
  ) {
    const token = input.token.trim();
    let baseUrl: string | null = null;
    if (input.provider === 'github') {
      try {
        const url = normalizeBaseUrl(input.baseUrl);
        baseUrl = url && !/^https?:\/\/(www\.)?github\.com$/.test(url) ? url : null;
      } catch (e) {
        throw new BadRequestException(`Invalid baseUrl: ${(e as Error).message}`);
      }
      if (baseUrl) {
        const problem = await outboundUrlProblem(baseUrl);
        if (problem) throw new BadRequestException(`Invalid baseUrl: ${problem}`);
      }
    } else if (input.baseUrl) throw new BadRequestException('Linear has no custom base URL');

    let account: string;
    try {
      account =
        input.provider === 'github'
          ? (await createGitClient('github', this.http, token, baseUrl).currentUser()).account
          : (await new LinearAdapter(this.http, token).whoami()).account;
    } catch (e) {
      throw providerFailure(input.provider === 'github' ? 'GitHub' : 'Linear', e, [token]);
    }

    const same = (await this.repo.findBy({ workspaceId, provider: input.provider, account })).find((c) => (c.baseUrl ?? null) === baseUrl);
    const id = same?.id ?? uid('tcr');
    return this.repo.save(
      this.repo.create({
        id,
        workspaceId,
        provider: input.provider,
        account,
        baseUrl,
        secret: this.secrets.encrypt(token, TRACKER(id)),
        createdBy: same?.createdBy ?? actor,
        createdAt: same?.createdAt,
        lastUsedAt: same?.lastUsedAt ?? null,
      }),
    );
  }

  async remove(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Credential', id);
    await this.repo.delete({ id: row.id, workspaceId });
  }

  /** The token behind a reference, checked against the workspace. Linear needs one; GitHub may go without. */
  async resolve(workspaceId: string, provider: ExternalProvider, ref: ImportCredentialRef = {}): Promise<ResolvedCredential> {
    if (ref.credentialId && ref.connectionId) throw new BadRequestException('Pass credentialId or connectionId, not both');
    if (ref.credentialId) {
      const row = await this.repo.findOneBy({ workspaceId, id: ref.credentialId, provider });
      if (!row) throw new BadRequestException(`Unknown ${provider} credential "${ref.credentialId}"`);
      await this.repo.update({ id: row.id }, { lastUsedAt: new Date() });
      return { token: this.secrets.decrypt(row.secret, TRACKER(row.id)), baseUrl: row.baseUrl };
    }
    if (ref.connectionId) {
      if (provider !== 'github') throw new BadRequestException('connectionId is only for GitHub');
      const conn = await this.connections.findOneBy({ workspaceId, id: ref.connectionId, provider: 'github' });
      if (!conn?.secret) throw new BadRequestException(`Unknown GitHub connection "${ref.connectionId}"`);
      return { token: this.secrets.decrypt(conn.secret, CONNECTION_SECRET(conn.id)), baseUrl: conn.baseUrl };
    }
    if (provider === 'linear') throw new BadRequestException('A Linear API key is required: add a credential first');
    return { token: null, baseUrl: null };
  }

  /**
   * The credential to read an issue at `host` with, for linking and refreshing. A stored credential
   * or GitHub connection of that host wins; github.com falls back to unauthenticated reads. Any other
   * host is refused: only hosts an admin configured are ever contacted.
   */
  async forHost(workspaceId: string, provider: ExternalProvider, host: string): Promise<ResolvedCredential> {
    const hostOf = (baseUrl: string | null) => (baseUrl ? new URL(baseUrl).hostname.toLowerCase() : provider === 'github' ? 'github.com' : 'linear.app');
    const creds = (await this.repo.find({ where: { workspaceId, provider }, order: { lastUsedAt: { direction: 'DESC', nulls: 'LAST' }, createdAt: 'DESC' } })).filter(
      (c) => hostOf(c.baseUrl) === host,
    );
    if (creds[0]) return this.resolve(workspaceId, provider, { credentialId: creds[0].id });
    if (provider === 'github') {
      const conns = (await this.connections.findBy({ workspaceId, provider: 'github' })).filter((c) => !!c.secret && hostOf(c.baseUrl) === host);
      if (conns[0]) return this.resolve(workspaceId, provider, { connectionId: conns[0].id });
      if (host === 'github.com') return { token: null, baseUrl: null };
      throw new BadRequestException(`No GitHub credential is configured for ${host}`);
    }
    throw new BadRequestException('Add a Linear API key under Settings → Import to link Linear issues');
  }
}
