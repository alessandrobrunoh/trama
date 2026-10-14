import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  AuthService,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
} from '../auth/auth.service.js';
import {
  ALLOW_CUSTOM_TOKEN_KEY,
  CAPABILITY_KEY,
  IS_PUBLIC_KEY,
  MULTIPART_KEY,
  REQUIRE_USER_KEY,
  TEAM_SCOPE_KEY,
  ROLES_KEY,
  SESSION_ONLY_KEY,
  type AppRequest,
  type AuthInfo,
} from '../auth/request-context.js';
import {
  isUploadBytesRoute,
  requiredPermission,
} from '../auth/api-permissions.js';
import {
  CAPABILITY_META,
  agentWorkspaceRole,
  applyTokenScope,
  effectiveMemberAccess,
  findWorkspaceRole,
  roleAllows,
} from '../contracts/domain.js';
import { requiredMemberGrant } from '../auth/member-access.js';
import { TokensService } from '../auth/tokens.service.js';
import type {
  Capability,
  MemberAccess,
  Role,
  TokenScope,
  WorkspaceRole,
} from '../contracts/domain.js';
import { PermissionsService } from './permissions.service.js';
import {
  AgentEntity,
  MembershipEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';

/**
 * Effective role of a token. `read` keeps view grants only. `write` drops admin capabilities and the
 * owner flag. `admin` and `custom` keep the role. Never raises what the role already has.
 */
export function capRole(
  role: WorkspaceRole,
  scope: TokenScope | undefined,
): WorkspaceRole {
  return applyTokenScope(role, scope);
}

function rankGate(min: Role): 'viewer' | 'member' | 'admin' | 'owner' {
  if (
    min === 'owner' ||
    min === 'admin' ||
    min === 'member' ||
    min === 'viewer'
  )
    return min;
  return 'member';
}

function capabilityLabel(capability: Capability): string {
  return CAPABILITY_META[capability].label.toLowerCase();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-session writes must be JSON so a cross-site form cannot submit them. A handler marked
 * multipart may also accept `multipart/form-data`; the CSRF header check still applies to both.
 */
export function sessionAllowsContentType(opts: {
  hasBody: boolean;
  json: boolean;
  multipart: boolean;
  multipartRoute: boolean;
}): boolean {
  if (!opts.hasBody) return true;
  if (opts.json) return true;
  return opts.multipartRoute && opts.multipart;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hasBody(req: AppRequest): boolean {
  const len = req.headers['content-length'];
  return (
    (len !== undefined && len !== '0') ||
    req.headers['transfer-encoding'] !== undefined
  );
}

/**
 * The single global guard. In order:
 *  1. `@Public()` routes pass through (but mutating ones with a body must be JSON).
 *  2. Authenticates: `Authorization: Bearer trm_… (or a legacy nbl_… token)` (API token, acting as a user or an agent)
 *     or the httpOnly `trama_session` cookie (or the legacy `nabla_session`). → 401 otherwise. Sets `req.auth`.
 *  3. CSRF for cookie sessions: mutating requests need `X-Requested-With` or `X-Client-Id`
 *     (forces a CORS preflight, so only allow-listed origins can send them); bodies must be JSON.
 *  4. `@SessionOnly()` account routes (create workspace, accept invite, personal settings) refuse API tokens.
 *     API token scopes: `read` tokens can only call safe (GET) routes and lose every capability.
 *     A `write` token drops admin capabilities and the owner role, so it cannot reach workspace-admin
 *     routes. `admin` tokens keep the full role of the user they act as.
 *  5. For routes with a `:slug` param: resolves the workspace + the caller's role → `req.ctx`.
 *     Non-members get 404 (existence is not leaked). A role without the capability, or without the
 *     grant a write needs, gets 403.
 *     The gate is `@Can(capability)` (that role's own set), else `@Roles(min)`, else viewer for reads
 *     and member for writes. There is no rank ladder.
 *     Agent tokens act with the historical member permissions, never as owner.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaces: Repository<WorkspaceEntity>,
    @InjectRepository(MembershipEntity)
    private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(AgentEntity)
    private readonly agents: Repository<AgentEntity>,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const mutating = !SAFE_METHODS.has(req.method);

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      if (mutating && hasBody(req) && !req.is('application/json'))
        throw new UnsupportedMediaTypeException(
          'Content-Type must be application/json',
        );
      return true;
    }

    const auth = await this.authenticate(req);
    if (!auth) throw new UnauthorizedException('Authentication required');
    req.auth = auth;

    if (mutating && auth.method === 'session') {
      const multipartRoute =
        this.reflector.getAllAndOverride<boolean>(MULTIPART_KEY, targets) ===
        true;
      if (
        !sessionAllowsContentType({
          hasBody: hasBody(req),
          json: Boolean(req.is('application/json')),
          multipart: Boolean(req.is('multipart/form-data')),
          multipartRoute,
        })
      ) {
        throw new UnsupportedMediaTypeException(
          'Content-Type must be application/json',
        );
      }
      if (!req.headers['x-requested-with'] && !req.headers['x-client-id'])
        throw new ForbiddenException(
          'Missing X-Requested-With or X-Client-Id header',
        );
    }

    if (
      auth.token &&
      this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, targets)
    )
      throw new ForbiddenException(
        'This account-level route is only available to signed-in browser sessions, not API tokens',
      );

    if (auth.token) {
      await this.tokens.enforceLimits(auth.token, mutating);
      if (auth.token.scope === 'custom')
        this.enforceCustomPermission(req, targets, mutating);
    }

    if (auth.token?.scope === 'read' && mutating)
      throw new ForbiddenException(
        'This API token has the "read" scope and can only call GET routes',
      );

    if (
      this.reflector.getAllAndOverride<boolean>(REQUIRE_USER_KEY, targets) &&
      !auth.user
    )
      throw new ForbiddenException(
        'This endpoint requires a user, not an agent token',
      );

    const slug = (req.params as Record<string, string | undefined>).slug;
    if (slug) {
      const workspace = await this.workspaces.findOneBy({ slug });
      const membership = workspace
        ? await this.membershipIn(auth, workspace.id)
        : null;
      if (!workspace || !membership)
        throw new NotFoundException(`Workspace "${slug}" not found`);
      const memberRole = membership.role;
      const settings = workspace.resolved();
      const baseRole =
        membership.kind === 'agent'
          ? agentWorkspaceRole()
          : findWorkspaceRole(settings.roles, memberRole);
      if (!baseRole)
        throw new ForbiddenException('This role is no longer available');
      const capability = this.reflector.getAllAndOverride<
        Capability | undefined
      >(CAPABILITY_KEY, targets);
      const min =
        this.reflector.getAllAndOverride<Role | undefined>(
          ROLES_KEY,
          targets,
        ) ?? (mutating ? 'member' : 'viewer');
      const scope = auth.token?.scope;
      const effective = capRole(baseRole, scope);
      const stored = membership.kind === 'user' ? membership.access : null;
      const access = effectiveMemberAccess(effective, stored);
      const needed = requiredMemberGrant(
        req.method,
        (req.route as { path?: string } | undefined)?.path ?? '',
      );
      const gate = { capability, min: rankGate(min), neededGrant: needed };
      if (!roleAllows(effective, gate, access)) {
        const uncapped = effectiveMemberAccess(baseRole, stored);
        if (scope && scope !== 'admin' && roleAllows(baseRole, gate, uncapped))
          throw new ForbiddenException(
            `This route needs more than the "${scope}" token scope allows`,
          );
        if (capability)
          throw new ForbiddenException(
            `You are not allowed to ${capabilityLabel(capability)}`,
          );
        throw new ForbiddenException('You are not allowed to do that');
      }
      // A capability is the permission for this route. Grants still narrow routes that are not capability-gated.
      if (access && !capability) this.enforceMemberGrant(req, access);
      const role = membership.kind === 'agent' ? 'member' : memberRole;
      req.ctx = {
        workspace,
        actor: auth.actor,
        userId: auth.user?.id,
        role,
        memberRole: role,
        tokenScope: scope,
        access,
        owner: effective.owner,
        capabilities: effective.capabilities,
      };
      const teamScope = this.reflector.getAllAndOverride<'issue' | undefined>(
        TEAM_SCOPE_KEY,
        targets,
      );
      if (teamScope)
        await this.permissions.enforceTeamScope(teamScope, req, req.ctx);
    }
    return true;
  }

  /** `custom` tokens: the route's `<resource>:<action>` must be in the token's explicit list. */
  private enforceCustomPermission(
    req: AppRequest,
    targets: Parameters<Reflector['getAllAndOverride']>[1],
    mutating: boolean,
  ): void {
    const token = req.auth!.token!;
    const path = (req.route as { path?: string } | undefined)?.path ?? '';
    const needed = requiredPermission(req.method, path);
    if (!needed) {
      // File bytes are not their own permission. UploadsService checks the parent record, and
      // whether this token may write, before anything is stored or returned.
      if (isUploadBytesRoute(path)) return;
      if (
        this.reflector.getAllAndOverride<boolean>(
          ALLOW_CUSTOM_TOKEN_KEY,
          targets,
        ) &&
        !mutating
      )
        return;
      throw new ForbiddenException(
        'This route is not available to custom API tokens',
      );
    }
    if (!token.permissions?.includes(needed))
      throw new ForbiddenException(
        `This API token lacks the "${needed}" permission`,
      );
  }

  private async authenticate(req: AppRequest): Promise<AuthInfo | null> {
    const header = req.headers.authorization;
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m) return null;
      const token = await this.tokens.authenticate(m[1]);
      // A presented bearer token that is missing, revoked or expired is not a session.
      // Do not fall through to the cookie: the caller asked to act as that token.
      if (!token) return null;
      if (token.actor.type === 'user') {
        const user = await this.users.findOneBy({ id: token.actor.id });
        return user
          ? {
              actor: { type: 'user', id: user.id },
              user,
              token,
              method: 'token',
            }
          : null;
      }
      return { actor: token.actor, token, method: 'token' };
    }
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE] || cookies[LEGACY_SESSION_COOKIE];
    if (!raw) return null;
    const found = await this.auth.authenticateSession(raw);
    if (!found) return null;
    return {
      actor: { type: 'user', id: found.user.id },
      user: found.user,
      method: 'session',
      sessionId: found.sessionId,
    };
  }

  /** `custom` is not the only narrowing: a person's own access can refuse a route their role would allow. */
  private enforceMemberGrant(req: AppRequest, access: MemberAccess): void {
    const path = (req.route as { path?: string } | undefined)?.path ?? '';
    const needed = requiredMemberGrant(req.method, path);
    if (needed && !access.grants.includes(needed))
      throw new ForbiddenException(`Your access does not include "${needed}"`);
  }

  /** The caller's membership, or a synthetic agent membership. Null when they have no access. */
  private async membershipIn(
    auth: AuthInfo,
    workspaceId: string,
  ): Promise<
    | { kind: 'user'; role: Role; access: MemberAccess | null }
    | { kind: 'agent'; role: Role; access: null }
    | null
  > {
    if (auth.token && auth.token.workspaceId !== workspaceId) return null;
    if (auth.user) {
      const m = await this.memberships.findOneBy({
        workspaceId,
        userId: auth.user.id,
      });
      return m ? { kind: 'user', role: m.role, access: m.access } : null;
    }
    // Agent token: valid only while the agent still exists in this workspace. Agents are not narrowed per person.
    if (auth.actor.type === 'agent' && auth.actor.id) {
      return (await this.agents.existsBy({ id: auth.actor.id, workspaceId }))
        ? { kind: 'agent', role: 'member', access: null }
        : null;
    }
    return null;
  }
}
