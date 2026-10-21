import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { catchError, defer, exhaustMap, filter, interval, of, take, takeUntil, type MonoTypeOperatorFunction } from 'rxjs';
import type { Repository } from 'typeorm';
import type { AuthInfo, WorkspaceContext } from '../auth/request-context.js';
import {
  agentWorkspaceRole,
  applyTokenScope,
  effectiveMemberAccess,
  findWorkspaceRole,
} from '../contracts/domain.js';
import {
  AgentEntity,
  ApiTokenEntity,
  MembershipEntity,
  SessionEntity,
  WorkspaceEntity,
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
    @InjectRepository(WorkspaceEntity) private readonly workspaces: Repository<WorkspaceEntity>,
  ) {}

  async isStillValid(
    auth: AuthInfo,
    ctx: WorkspaceContext,
    now = Date.now(),
  ): Promise<boolean> {
    const workspaceId = ctx.workspace.id;
    if (auth.token) {
      const token = await this.tokens.findOneBy({ id: auth.token.id });
      if (!token || token.workspaceId !== workspaceId) return false;
      const expires = token.expiresAt?.getTime();
      if (expires !== undefined && (Number.isNaN(expires) || expires <= now)) return false;
      if (
        token.scope !== auth.token.scope ||
        JSON.stringify(token.permissions ?? []) !== JSON.stringify(auth.token.permissions ?? [])
      )
        return false;
    } else {
      if (!auth.sessionId) return false;
      const session = await this.sessions.findOneBy({ id: auth.sessionId });
      const expires = session?.expiresAt?.getTime();
      if (!session || expires === undefined || Number.isNaN(expires) || expires <= now) return false;
    }

    const workspace = await this.workspaces.findOneBy({ id: workspaceId });
    if (!workspace) return false;
    let memberRole: string;
    let storedAccess = null;
    if (auth.user) {
      const membership = await this.memberships.findOneBy({
        workspaceId,
        userId: auth.user.id,
      });
      if (!membership) return false;
      memberRole = membership.role;
      storedAccess = membership.access;
    } else if (auth.actor.type === 'agent' && auth.actor.id) {
      if (!(await this.agents.existsBy({ id: auth.actor.id, workspaceId })))
        return false;
      memberRole = 'member';
    } else {
      return false;
    }

    const role =
      auth.actor.type === 'agent'
        ? agentWorkspaceRole()
        : findWorkspaceRole(workspace.resolved().roles, memberRole);
    if (!role) return false;
    const effectiveRole = applyTokenScope(role, auth.token?.scope);
    const access = effectiveMemberAccess(effectiveRole, storedAccess);
    return (
      ctx.role === memberRole &&
      ctx.memberRole === memberRole &&
      ctx.tokenScope === auth.token?.scope &&
      ctx.owner === effectiveRole.owner &&
      JSON.stringify(ctx.capabilities ?? []) ===
        JSON.stringify(effectiveRole.capabilities) &&
      JSON.stringify(ctx.access ?? null) === JSON.stringify(access)
    );
  }
}

/**
 * Completes a stream the first time `isValid()` answers false (checked every `everyMs`). A check
 * that throws closes the stream: authorization cannot be confirmed during a database outage.
 */
export function closeWhenInvalid<T>(isValid: () => Promise<boolean>, everyMs: number): MonoTypeOperatorFunction<T> {
  const invalid$ = interval(everyMs).pipe(
    exhaustMap(() => defer(isValid).pipe(catchError(() => of(false)))),
    filter((valid) => !valid),
    take(1),
  );
  return takeUntil(invalid$);
}
