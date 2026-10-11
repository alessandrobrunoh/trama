import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type {
  ActorRef,
  Capability,
  MemberAccess,
  Role,
  TokenScope,
  WorkspaceRole,
} from '../contracts/domain.js';
import {
  legacyRoleAtLeast,
  roleHasAdminPower,
  roleHasCapability,
} from '../contracts/domain.js';
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
  /** Present when authenticated with `Authorization: Bearer trm_…` (or a legacy `nbl_…` token). */
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
  /** The membership's role id. A read or write token does not change this; `owner` and `capabilities` do. */
  role: Role;
  /** The caller's real workspace role, ignoring any token scope cap. */
  memberRole?: Role;
  /** Scope of the API token used for this request (undefined for browser sessions). */
  tokenScope?: TokenScope;
  /**
   * Present only when this person is narrower than their role. The owner role is never narrowed.
   * Absent or null: the role applies in full.
   */
  access?: MemberAccess | null;
  /** True when this request still has the owner role. False for a read or write token. */
  owner?: boolean;
  /** Capabilities of the role after the token scope cap. Absent on partial test contexts. */
  capabilities?: readonly Capability[];
}

export interface AppRequest extends Request {
  auth?: AuthInfo;
  ctx?: WorkspaceContext;
}

/** @deprecated Rank of the four migrated role ids. Custom roles are not ranked. */
export const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** True only when both ids are old ranks and `role` is at least `min`. */
export function hasRole(role: Role, min: Role): boolean {
  return legacyRoleAtLeast(role, min);
}

/** The owner role, unless a read or write token capped this request. */
export function isOwner(ctx: { role?: Role; owner?: boolean }): boolean {
  if (typeof ctx.owner === 'boolean') return ctx.owner;
  return ctx.role === 'owner';
}

/**
 * Workspace administration: the owner role, or any capability that used to require an admin.
 * When `capabilities` is omitted (older tests), falls back to the admin rank of `role`.
 */
export function hasAdminPower(ctx: {
  role?: Role;
  owner?: boolean;
  capabilities?: readonly Capability[];
}): boolean {
  if (ctx.owner) return true;
  if (ctx.capabilities)
    return roleHasAdminPower({
      owner: false,
      capabilities: [...ctx.capabilities],
    });
  return hasRole(ctx.role ?? '', 'admin');
}

export const IS_PUBLIC_KEY = 'trama:public';
export const ROLES_KEY = 'trama:roles';
export const REQUIRE_USER_KEY = 'trama:require-user';
export const CAPABILITY_KEY = 'trama:capability';
export const TEAM_SCOPE_KEY = 'trama:team-scope';
export const ALLOW_CUSTOM_TOKEN_KEY = 'trama:allow-custom-token';
export const SESSION_ONLY_KEY = 'trama:session-only';
export const MULTIPART_KEY = 'trama:multipart';

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
export const Can = (capability: Capability) =>
  SetMetadata(CAPABILITY_KEY, capability);

/**
 * The route mutates something owned by a team (`workstream` → its owner team, `issue` → its team):
 * the team's `editPolicy` is enforced by PolicyGuard on top of the workspace role.
 */
export const EditsTeamWork = (kind: 'workstream' | 'issue') =>
  SetMetadata(TEAM_SCOPE_KEY, kind);

/** A non-workspace route that `custom` (fine-grained) tokens may call, e.g. `GET /auth/token`. */
export const AllowCustomToken = () => SetMetadata(ALLOW_CUSTOM_TOKEN_KEY, true);

/**
 * An account-level route (not bound to one workspace): browser sessions only. An API token belongs to
 * a single workspace, so it must not create workspaces, accept invites or change the person's account settings.
 */
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);

/** Reject agent tokens: the route needs a human principal (a user). */
export const RequireUser = () => SetMetadata(REQUIRE_USER_KEY, true);

/**
 * This route accepts `multipart/form-data` (a file upload). The session CSRF header is still required;
 * only the JSON content-type check is relaxed, and only for this handler.
 */
export const Multipart = () => SetMetadata(MULTIPART_KEY, true);

function req(ctx: ExecutionContext): AppRequest {
  return ctx.switchToHttp().getRequest<AppRequest>();
}

/** `@Ctx() ctx: WorkspaceContext` — workspace, actor, userId, role. */
export const Ctx = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): WorkspaceContext => req(ctx).ctx!,
);

/** `@Actor() actor: ActorRef` — the acting user/agent of the request. */
export const Actor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ActorRef =>
    (req(ctx).ctx ?? req(ctx).auth)!.actor,
);

/** `@Auth() auth: AuthInfo` — available on every non-public route. */
export const Auth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthInfo => req(ctx).auth!,
);

/** Does this request's role include the capability? A read or write token uses the capped set. */
export function canDo(
  ctx: Pick<WorkspaceContext, 'role' | 'workspace'> & {
    capabilities?: readonly Capability[];
  },
  capability: Capability,
): boolean {
  if (ctx.capabilities) return ctx.capabilities.includes(capability);
  const resolved = ctx.workspace.resolved() as {
    roles?: readonly WorkspaceRole[];
    permissions?: Partial<Record<Capability, string>>;
  };
  if (resolved.roles?.length)
    return roleHasCapability(resolved.roles, ctx.role, capability);
  const min = resolved.permissions?.[capability];
  return !!min && legacyRoleAtLeast(ctx.role, min);
}
