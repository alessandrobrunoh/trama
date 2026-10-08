import { randomBytes } from 'node:crypto';
import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Or, type Repository } from 'typeorm';
import { DEFAULT_TOKEN_LIMITS, MAX_TOKEN_LIMITS } from '../contracts/domain.js';
import type { ActorRef, ApiPermission, TokenLimits, TokenScope } from '../contracts/domain.js';
import { ApiTokenEntity } from '../database/entities/index.js';
import { sha256 } from '../common/crypto.js';
import { uid } from '../common/util.js';

export const TOKEN_PREFIX = 'nbl_';

/** Clamps a partial limits object to the allowed range, filling gaps with the defaults. */
export function resolveLimits(input?: Partial<TokenLimits> | null): TokenLimits {
  const out = { ...DEFAULT_TOKEN_LIMITS };
  for (const key of Object.keys(out) as (keyof TokenLimits)[]) {
    const v = input?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(Math.max(Math.floor(v), 1), MAX_TOKEN_LIMITS[key]);
  }
  return out;
}

@Injectable()
export class TokensService {
  /** Per-minute counters, per process (like the AI limits); the daily write cap is persisted. */
  private readonly minute = new Map<string, { at: number; requests: number; writes: number }>();

  constructor(
    @InjectRepository(ApiTokenEntity)
    private readonly repo: Repository<ApiTokenEntity>,
  ) {}

  /**
   * Enforces a token's request/write budget (HTTP 429). Reads count as requests, mutations as
   * requests and writes; the daily write counter lives in Postgres so it survives restarts.
   */
  async enforceLimits(token: ApiTokenEntity, mutating: boolean): Promise<void> {
    const limits = resolveLimits(token.limits);
    const now = Date.now();
    for (const [id, w] of this.minute) if (now - w.at >= 60_000) this.minute.delete(id);
    const w = this.minute.get(token.id) ?? { at: now, requests: 0, writes: 0 };
    if (w.requests >= limits.requestsPerMinute)
      throw new HttpException(`Token limit reached: ${limits.requestsPerMinute} requests per minute. Slow down.`, 429);
    if (mutating && w.writes >= limits.writesPerMinute)
      throw new HttpException(`Token limit reached: ${limits.writesPerMinute} writes per minute. Slow down.`, 429);
    if (mutating) {
      const rows = await this.repo.manager.query<{ writes: number }[]>(
        `INSERT INTO api_token_usage ("tokenId", "day", "writes") VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT ("tokenId", "day") DO UPDATE SET "writes" = api_token_usage."writes" + 1 RETURNING "writes"`,
        [token.id],
      );
      if (rows[0].writes > limits.writesPerDay)
        throw new HttpException(`Token limit reached: ${limits.writesPerDay} writes per day. Try again tomorrow or raise the limit in Settings.`, 429);
      w.writes++;
    }
    w.requests++;
    this.minute.set(token.id, w);
  }

  /** Creates a token; the plaintext `secret` is returned ONCE and only its sha256 is stored. */
  async create(input: {
    workspaceId: string;
    name: string;
    actor: ActorRef;
    scope?: TokenScope;
    permissions?: ApiPermission[] | null;
    limits?: Partial<TokenLimits>;
    createdByUserId?: string;
    expiresAt?: Date | null;
  }): Promise<{ token: ApiTokenEntity; secret: string }> {
    const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const token = await this.repo.save(
      this.repo.create({
        id: uid('tk'),
        workspaceId: input.workspaceId,
        name: input.name,
        prefix: `${secret.slice(0, 8)}…`,
        tokenHash: sha256(secret),
        actor: input.actor,
        scope: input.scope ?? 'write',
        permissions: input.scope === 'custom' ? (input.permissions ?? []) : null,
        limits: resolveLimits(input.limits),
        createdByUserId: input.createdByUserId ?? null,
        expiresAt: input.expiresAt ?? null,
      }),
    );
    return { token, secret };
  }

  /** Resolves a bearer secret to its (unexpired) token row, touching `lastUsedAt` at most once a minute. */
  async authenticate(secret: string): Promise<ApiTokenEntity | null> {
    if (!secret.startsWith(TOKEN_PREFIX)) return null;
    const token = await this.repo.findOne({
      where: {
        tokenHash: sha256(secret),
        expiresAt: Or(IsNull(), MoreThan(new Date())),
      },
    });
    if (!token) return null;
    if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > 60_000) {
      token.lastUsedAt = new Date();
      await this.repo.update({ id: token.id }, { lastUsedAt: token.lastUsedAt });
    }
    return token;
  }
}
