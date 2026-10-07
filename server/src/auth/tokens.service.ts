import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Or, type Repository } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { ApiTokenEntity } from '../database/entities/index.js';
import { sha256 } from '../common/crypto.js';
import { uid } from '../common/util.js';

export const TOKEN_PREFIX = 'nbl_';

@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(ApiTokenEntity)
    private readonly repo: Repository<ApiTokenEntity>,
  ) {}

  /** Creates a token; the plaintext `secret` is returned ONCE and only its sha256 is stored. */
  async create(input: {
    workspaceId: string;
    name: string;
    actor: ActorRef;
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
