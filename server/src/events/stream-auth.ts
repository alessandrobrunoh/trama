import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { catchError, defer, exhaustMap, filter, interval, of, take, takeUntil, type MonoTypeOperatorFunction } from 'rxjs';
import type { Repository } from 'typeorm';
import type { AuthInfo } from '../auth/request-context.js';
import {
  AgentEntity,
  ApiTokenEntity,
  MembershipEntity,
  SessionEntity,
} from '../database/entities/index.js';

export const DEFAULT_STREAM_RECHECK_MS = 30_000;

/** How often an open SSE stream re-checks its credential (`TRAMA_SSE_RECHECK_MS`, default 30 s). */
export function streamRecheckMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRAMA_SSE_RECHECK_MS);
  return Number.isInteger(n) && n >= 100 ? n : DEFAULT_STREAM_RECHECK_MS;
}

/**
 * An SSE stream is authenticated once, when it opens. This re-runs the checks that matter for a
 * long-lived connection: the session or API token still exists and has not expired, and the caller
 * is still a member of the workspace (or the agent still exists in it).
 */
@Injectable()
export class StreamAuthService {
  constructor(
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
    @InjectRepository(ApiTokenEntity) private readonly tokens: Repository<ApiTokenEntity>,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
  ) {}

  async isStillValid(auth: AuthInfo, workspaceId: string, now = Date.now()): Promise<boolean> {
    if (auth.token) {
      const token = await this.tokens.findOneBy({ id: auth.token.id });
      if (!token || token.workspaceId !== workspaceId) return false;
      const expires = token.expiresAt?.getTime();
      if (expires !== undefined && (Number.isNaN(expires) || expires <= now)) return false;
    } else {
      if (!auth.sessionId) return false;
      const session = await this.sessions.findOneBy({ id: auth.sessionId });
      const expires = session?.expiresAt?.getTime();
      if (!session || expires === undefined || Number.isNaN(expires) || expires <= now) return false;
    }
    if (auth.user) return this.memberships.existsBy({ workspaceId, userId: auth.user.id });
    if (auth.actor.type === 'agent' && auth.actor.id) return this.agents.existsBy({ id: auth.actor.id, workspaceId });
    return false;
  }
}

/**
 * Completes a stream the first time `isValid()` answers false (checked every `everyMs`). A check
 * that throws (database hiccup) keeps the stream open; the next tick tries again.
 */
export function closeWhenInvalid<T>(isValid: () => Promise<boolean>, everyMs: number): MonoTypeOperatorFunction<T> {
  const invalid$ = interval(everyMs).pipe(
    exhaustMap(() => defer(isValid).pipe(catchError(() => of(true)))),
    filter((valid) => !valid),
    take(1),
  );
  return takeUntil(invalid$);
}
