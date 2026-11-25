import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import {
  EXTERNAL_IDENTITIES_MAX,
  EXTERNAL_IDENTITY_PROVIDERS,
  EXTERNAL_IDENTITY_PROVIDER_META,
  normalizeIdentityHost,
  normalizeIdentityLogin,
  type ExternalIdentityInput,
  type ExternalIdentityProvider,
} from '../contracts/domain.js';
import { isUniqueViolation, notFound, uid } from '../common/util.js';
import { ExternalIdentityEntity } from './external-identity.entity.js';

/** A (provider, host, login) triple in the form the table compares: lower-case host, trimmed login. */
export interface IdentityKey {
  provider: ExternalIdentityProvider;
  host: string;
  login: string;
}

/**
 * Normalizes a triple. `host` may be a bare host, a URL, or empty (the provider's public host).
 * Returns `null` when the provider is unknown, the host cannot be derived or is malformed, or the
 * login is empty or unusable. Lookups use this and treat `null` as "nobody".
 */
export function identityKey(
  provider: string,
  host: string | null | undefined,
  login: string | null | undefined,
): IdentityKey | null {
  if (!(EXTERNAL_IDENTITY_PROVIDERS as string[]).includes(provider)) return null;
  const p = provider as ExternalIdentityProvider;
  const h = host?.trim()
    ? normalizeIdentityHost(host)
    : (EXTERNAL_IDENTITY_PROVIDER_META[p].defaultHost ?? null);
  const l = login ? normalizeIdentityLogin(login) : null;
  return h && l ? { provider: p, host: h, login: l } : null;
}

/** What each external login resolves to, and the one place that decides it. */
export interface LoginResolver {
  resolveUserByLogin(
    provider: string,
    host: string | null | undefined,
    login: string | null | undefined,
    opts?: ResolveOptions,
  ): Promise<string | null>;
}

export interface ResolveOptions {
  /** Only identities that came from a connection (proven with a token), not typed in by hand. */
  verifiedOnly?: boolean;
}

@Injectable()
export class ExternalIdentitiesService implements LoginResolver {
  private readonly logger = new Logger(ExternalIdentitiesService.name);

  constructor(
    @InjectRepository(ExternalIdentityEntity)
    private readonly repo: Repository<ExternalIdentityEntity>,
    private readonly ds: DataSource,
  ) {}

  // ───────────── a person's own list ─────────────

  list(userId: string): Promise<ExternalIdentityEntity[]> {
    return this.repo.find({
      where: { userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /** Adds a login by hand. 409 when anyone (including this person) already has it. */
  async add(
    userId: string,
    input: ExternalIdentityInput,
  ): Promise<ExternalIdentityEntity> {
    const key = identityKey(input.provider, input.host, input.login);
    if (!key) {
      if (!(EXTERNAL_IDENTITY_PROVIDERS as string[]).includes(input.provider))
        throw new BadRequestException('Unknown provider');
      if (!normalizeIdentityLogin(input.login ?? ''))
        throw new BadRequestException('login is not a valid login');
      if (input.host?.trim() && !normalizeIdentityHost(input.host))
        throw new BadRequestException('host is not a valid host name');
      throw new BadRequestException('host is required for this provider');
    }
    if ((await this.repo.countBy({ userId })) >= EXTERNAL_IDENTITIES_MAX)
      throw new BadRequestException(
        `At most ${EXTERNAL_IDENTITIES_MAX} external identities per account`,
      );
    const existing = await this.find(key);
    if (existing)
      throw new ConflictException(
        existing.userId === userId
          ? 'You already have this identity'
          : 'This login is already linked to another account',
      );
    try {
      return await this.repo.save(
        this.repo.create({ id: uid('xid'), userId, ...key, source: 'manual' }),
      );
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ConflictException(
          'This login is already linked to another account',
        );
      throw e;
    }
  }

  /** Removing someone else's identity is a 404, not a 403: its existence is not revealed. */
  async remove(userId: string, id: string): Promise<void> {
    const row = await this.repo.findOneBy({ id, userId });
    if (!row) throw notFound('External identity', id);
    await this.repo.delete({ id, userId });
  }

  // ───────────── for other modules ─────────────

  /**
   * Called when a personal connection is created: its account login becomes an identity of the
   * owner (`source: 'connection'`). Never throws on a conflict (the connection must still be
   * created): a login that belongs to someone else, a malformed one, or a full list returns `null`.
   * An identity the person had typed in by hand becomes a connection one (it is proven now).
   */
  async ensureFromConnection(
    userId: string,
    provider: string,
    host: string | null | undefined,
    login: string | null | undefined,
  ): Promise<ExternalIdentityEntity | null> {
    const key = identityKey(provider, host, login);
    if (!key) return null;
    const existing = await this.find(key);
    if (existing) {
      if (existing.userId !== userId) {
        this.logger.warn(
          `Login ${key.provider}/${key.host}/${key.login} is linked to another account; not added to ${userId}`,
        );
        return null;
      }
      if (existing.source !== 'connection') {
        existing.source = 'connection';
        return this.repo.save(existing);
      }
      return existing;
    }
    if ((await this.repo.countBy({ userId })) >= EXTERNAL_IDENTITIES_MAX)
      return null;
    try {
      return await this.repo.save(
        this.repo.create({
          id: uid('xid'),
          userId,
          ...key,
          source: 'connection',
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) return null; // a concurrent add won
      throw e;
    }
  }

  /**
   * The Trama account that owns this external login, or `null`. The single resolver for assignees,
   * review requests, mentions and activity: every login of one person resolves to that person.
   */
  async resolveUserByLogin(
    provider: string,
    host: string | null | undefined,
    login: string | null | undefined,
    opts: ResolveOptions = {},
  ): Promise<string | null> {
    const key = identityKey(provider, host, login);
    if (!key) return null;
    const row = await this.find(key);
    if (!row || (opts.verifiedOnly && row.source !== 'connection')) return null;
    return row.userId;
  }

  /** Like {@link resolveUserByLogin}, but `null` unless that account is a member of the workspace. */
  async resolveMemberByLogin(
    workspaceId: string,
    provider: string,
    host: string | null | undefined,
    login: string | null | undefined,
    opts: ResolveOptions = {},
  ): Promise<string | null> {
    const found = await this.resolveMembersByLogins(
      workspaceId,
      provider,
      host,
      login ? [login] : [],
      opts,
    );
    const key = identityKey(provider, host, login);
    return key ? (found.get(key.login.toLowerCase()) ?? null) : null;
  }

  /**
   * Resolves many logins of one provider and host at once. The result maps the lower-cased login
   * to the user id, and only holds accounts that are members of the workspace.
   */
  async resolveMembersByLogins(
    workspaceId: string,
    provider: string,
    host: string | null | undefined,
    logins: readonly string[],
    opts: ResolveOptions = {},
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const keys = logins
      .map((l) => identityKey(provider, host, l))
      .filter((k): k is IdentityKey => !!k);
    if (!keys.length) return found;
    const rows: { login: string; userId: string }[] = await this.ds.query(
      `SELECT e."login", e."userId"
         FROM "external_identities" e
         JOIN "memberships" m ON m."userId" = e."userId" AND m."workspaceId" = $1
        WHERE e."provider" = $2 AND e."host" = $3 AND lower(e."login") = ANY($4)
          ${opts.verifiedOnly ? `AND e."source" = 'connection'` : ''}`,
      [
        workspaceId,
        keys[0].provider,
        keys[0].host,
        [...new Set(keys.map((k) => k.login.toLowerCase()))],
      ],
    );
    for (const r of rows) found.set(r.login.toLowerCase(), r.userId);
    return found;
  }

  /** Every login this person has at a provider (and host, when given), as stored. */
  async loginsOf(
    userId: string,
    provider?: string,
    host?: string | null,
  ): Promise<ExternalIdentityEntity[]> {
    const rows = await this.list(userId);
    const h = host ? normalizeIdentityHost(host) : null;
    return rows.filter(
      (r) => (!provider || r.provider === provider) && (!h || r.host === h),
    );
  }

  private find(key: IdentityKey): Promise<ExternalIdentityEntity | null> {
    return this.repo
      .createQueryBuilder('e')
      .where(
        'e.provider = :p AND e.host = :h AND lower(e.login) = :l',
        { p: key.provider, h: key.host, l: key.login.toLowerCase() },
      )
      .getOne();
  }
}
