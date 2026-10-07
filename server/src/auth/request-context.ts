import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ActorRef, Role } from '../contracts/domain.js';
import type {
  ApiTokenEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';

/** Who is calling (set by AccessGuard on every non-public route). */
export interface AuthInfo {
  actor: ActorRef;
  /** Present for browser sessions and user-actor API tokens; absent for agent tokens. */
  user?: UserEntity;
  /** Present when authenticated with `Authorization: Bearer nbl_…`. */
  token?: ApiTokenEntity;
  method: 'session' | 'token';
  /** sha256 id of the cookie session (method = session). */
  sessionId?: string;
}

/** Resolved for every route under `/api/w/:slug/...`. */
export interface WorkspaceContext {
  workspace: WorkspaceEntity;
  actor: ActorRef;
  /** The acting user's id (undefined for agent tokens). */
  userId?: string;
  role: Role;
}

export interface AppRequest extends Request {
  auth?: AuthInfo;
  ctx?: WorkspaceContext;
}

export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const IS_PUBLIC_KEY = 'nabla:public';
export const ROLES_KEY = 'nabla:roles';
export const REQUIRE_USER_KEY = 'nabla:require-user';

/** Skip authentication (login, signup, health, webhooks…). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Minimum workspace role for a handler (or a whole controller). Without it the
 * default is `viewer` for GET/HEAD/OPTIONS and `member` for everything else.
 */
export const Roles = (min: Role) => SetMetadata(ROLES_KEY, min);

/** Reject agent tokens: the route needs a human principal (a user). */
export const RequireUser = () => SetMetadata(REQUIRE_USER_KEY, true);

function req(ctx: ExecutionContext): AppRequest {
  return ctx.switchToHttp().getRequest<AppRequest>();
}

/** `@Ctx() ctx: WorkspaceContext` — workspace, actor, userId, role. */
export const Ctx = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): WorkspaceContext => req(ctx).ctx!,
);

/** `@Actor() actor: ActorRef` — the acting user/agent of the request. */
export const Actor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ActorRef => (req(ctx).ctx ?? req(ctx).auth)!.actor,
);

/** `@Auth() auth: AuthInfo` — available on every non-public route. */
export const Auth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthInfo => req(ctx).auth!,
);
