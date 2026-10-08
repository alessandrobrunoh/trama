import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ActorRef, Capability, Role, TokenScope } from '../contracts/domain.js';
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
  /** Effective role: the member's role, capped by the token scope when called with an API token. */
  role: Role;
  /** The caller's real workspace role, ignoring any token scope cap. */
  memberRole?: Role;
  /** Scope of the API token used for this request (undefined for browser sessions). */
  tokenScope?: TokenScope;
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
export const CAPABILITY_KEY = 'nabla:capability';
export const TEAM_SCOPE_KEY = 'nabla:team-scope';

/** Skip authentication (login, signup, health, webhooks…). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Minimum workspace role for a handler (or a whole controller). Without it the
 * default is `viewer` for GET/HEAD/OPTIONS and `member` for everything else.
 */
export const Roles = (min: Role) => SetMetadata(ROLES_KEY, min);

/**
 * Gate a handler (or controller) behind a workspace capability: the minimum role is read from the
 * workspace's permission settings (Settings → Roles & permissions) instead of being hard-coded.
 */
export const Can = (capability: Capability) => SetMetadata(CAPABILITY_KEY, capability);

/**
 * The route mutates something owned by a team (`workstream` → its owner team, `issue` → its team):
 * the team's `editPolicy` is enforced by PolicyGuard on top of the workspace role.
 */
export const EditsTeamWork = (kind: 'workstream' | 'issue') => SetMetadata(TEAM_SCOPE_KEY, kind);

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

/** Minimum role currently required for a capability in this workspace. */
export function minRoleFor(ctx: Pick<WorkspaceContext, 'workspace'>, capability: Capability): Role {
  return ctx.workspace.resolved().permissions[capability];
}

/** Does the caller's effective role satisfy the capability? */
export function canDo(ctx: WorkspaceContext, capability: Capability): boolean {
  return hasRole(ctx.role, minRoleFor(ctx, capability));
}
