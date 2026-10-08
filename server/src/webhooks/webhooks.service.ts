import { BadRequestException, HttpException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { GitProvider } from '../contracts/domain.js';
import { IntegrationConnectionEntity, RepositoryEntity } from '../database/entities/index.js';
import { ArtifactLinkerService } from '../integrations/artifact-linker.service.js';
import { WebhookDeliveryEntity } from '../integrations/entities.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { PayloadError, parseBitbucketEvent, parseGithubEvent, parseGitlabEvent, type ParsedEvent } from './events.js';
import { verifyBitbucketSignature, verifyGithubSignature, verifyGitlabToken } from './signatures.js';

export interface WebhookResult {
  /** HTTP status to answer with: 200 handled / duplicate, 202 accepted but nothing to do. */
  httpStatus: 200 | 202;
  body: Record<string, unknown>;
}

export interface WebhookInput {
  provider: GitProvider;
  connectionId: string;
  rawBody: Buffer | undefined;
  payload: unknown;
  /** lower-cased request headers */
  headers: Record<string, string | string[] | undefined>;
}

/** Header carrying a per-delivery id, used to ignore redeliveries. */
const DELIVERY_HEADER: Record<GitProvider, string> = {
  github: 'x-github-delivery',
  gitlab: 'x-gitlab-event-uuid',
  bitbucket: 'x-request-uuid',
};

const header = (h: WebhookInput['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly secrets: SecretsService,
    private readonly linker: ArtifactLinkerService,
    @InjectRepository(IntegrationConnectionEntity) private readonly connections: Repository<IntegrationConnectionEntity>,
  ) {}

  async handle(input: WebhookInput): Promise<WebhookResult> {
    const conn = await this.connections.findOneBy({ id: input.connectionId, provider: input.provider });
    if (!conn) throw new NotFoundException('Unknown webhook endpoint');
    if (!conn.webhookSecret) throw new UnauthorizedException('Webhook secret not configured');

    let secret: string;
    try {
      secret = this.secrets.decrypt(conn.webhookSecret, `${conn.id}:webhook`);
    } catch {
      this.logger.error(`Cannot decrypt the webhook secret of ${conn.id} (TRAMA_ENCRYPTION_KEY changed?)`);
      throw new UnauthorizedException('Webhook secret unavailable');
    }
    const valid = this.verify(input, secret);
    if (!valid) throw new UnauthorizedException('Invalid webhook signature');

    const deliveryId = header(input.headers, DELIVERY_HEADER[input.provider]);
    if (deliveryId && !(await this.claimDelivery(conn.id, deliveryId))) return { httpStatus: 200, body: { status: 'duplicate' } };

    try {
      const parsed = this.parse(input);
      const result = await this.apply(conn, parsed);
      void this.touchConnection(conn);
      return result;
    } catch (e) {
      if (deliveryId && !(e instanceof PayloadError || (e instanceof HttpException && e.getStatus() < 500)))
        await this.ds.getRepository(WebhookDeliveryEntity).delete({ id: `${conn.id}:${deliveryId}` }); // let the provider retry
      if (e instanceof PayloadError) throw new BadRequestException(`Malformed webhook payload: ${e.message}`);
      throw e;
    }
  }

  private parse(input: WebhookInput): ParsedEvent {
    if (input.payload === undefined || input.payload === null || typeof input.payload !== 'object')
      throw new PayloadError('body must be a JSON object');
    if (input.provider === 'github') {
      const event = header(input.headers, 'x-github-event');
      if (!event) throw new PayloadError('missing X-GitHub-Event header');
      return parseGithubEvent(event, input.payload);
    }
    if (input.provider === 'bitbucket') {
      const event = header(input.headers, 'x-event-key');
      if (!event) throw new PayloadError('missing X-Event-Key header');
      return parseBitbucketEvent(event, input.payload);
    }
    return parseGitlabEvent(input.payload);
  }

  /** Each host proves authenticity differently: an HMAC of the raw body (GitHub, Bitbucket) or the secret itself (GitLab). */
  private verify(input: WebhookInput, secret: string): boolean {
    switch (input.provider) {
      case 'github':
        return !!input.rawBody && verifyGithubSignature(secret, input.rawBody, header(input.headers, 'x-hub-signature-256'));
      case 'bitbucket':
        return !!input.rawBody && verifyBitbucketSignature(secret, input.rawBody, header(input.headers, 'x-hub-signature'));
      case 'gitlab':
        return verifyGitlabToken(secret, header(input.headers, 'x-gitlab-token'));
    }
  }

  private async apply(conn: IntegrationConnectionEntity, parsed: ParsedEvent): Promise<WebhookResult> {
    if (parsed.kind === 'ping') return { httpStatus: 200, body: { status: 'pong' } };
    if (parsed.kind === 'ignored') return { httpStatus: 202, body: { status: 'ignored', reason: parsed.reason } };

    const repo = await this.ds
      .getRepository(RepositoryEntity)
      .createQueryBuilder('r')
      .where('r.workspaceId = :w AND r.provider = :p AND lower(r.fullName) = lower(:n)', { w: conn.workspaceId, p: conn.provider, n: parsed.repo.fullName })
      .getOne();
    if (!repo) return { httpStatus: 202, body: { status: 'ignored', reason: `repository ${parsed.repo.fullName} is not linked` } };

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

  /** True when this delivery id is new. Also prunes old ids now and then. */
  private async claimDelivery(connectionId: string, deliveryId: string): Promise<boolean> {
    const rows: unknown[] = await this.ds.query(
      `INSERT INTO "webhook_deliveries" ("id","connectionId") VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING "id"`,
      [`${connectionId}:${deliveryId}`, connectionId],
    );
    if (Math.random() < 0.02)
      void this.ds.query(`DELETE FROM "webhook_deliveries" WHERE "receivedAt" < now() - interval '7 days'`).catch(() => undefined);
    return rows.length > 0;
  }

  /** Remembers the last delivery (shown in settings so admins can see that the webhook works). Throttled to once a minute. */
  private async touchConnection(conn: IntegrationConnectionEntity): Promise<void> {
    try {
      const last = (conn.config as { lastWebhookAt?: string }).lastWebhookAt;
      if (last && Date.now() - Date.parse(last) < 60_000) return;
      await this.ds.query(
        `UPDATE "integration_connections" SET "config" = "config" || jsonb_build_object('lastWebhookAt', $2::text) WHERE "id" = $1`,
        [conn.id, new Date().toISOString()],
      );
    } catch (e) {
      this.logger.warn(`lastWebhookAt update failed: ${(e as Error).message}`);
    }
  }
}
