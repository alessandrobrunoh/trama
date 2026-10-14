import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, type Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service.js';
import { isOwner, type WorkspaceContext } from '../auth/request-context.js';
import {
  CAPABILITIES,
  accessWithin,
  applyTokenScope,
  canGrantRole,
  effectiveMemberAccess,
  findWorkspaceRole,
  freshWorkspaceRoles,
  normalizeCapabilities,
  normalizeGrantList,
  normalizeMemberAccess,
  normalizeWorkspaceRoles,
  OWNER_ROLE_ID,
  ROLE_NAME_MAX,
} from '../contracts/domain.js';
import type { MemberAccess, MemberGrant, Role, TokenScope, WorkspaceRole, WorkspaceSettings } from '../contracts/domain.js';
import {
  AgentEntity,
  ApiTokenEntity,
  InviteEntity,
  MembershipEntity,
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { notFound, slugify, uid } from '../common/util.js';
import { EventsService } from '../events/events.service.js';
import {
  assertCanChangeRole,
  assertCanRemoveMember,
  assertCanTransferOwnership,
  type MemberActor,
  type MemberRuleContext,
} from './member-rules.js';

/** Slugs that would collide with client routes. */
export const RESERVED_SLUGS = new Set([
  'login',
  'signup',
  'register',
  'blog',
  'roadmap',
  'changelog',
  'brand',
  '404',
  'new-workspace',
  'settings',
  'api',
  'admin',
  'auth',
  'workspaces',
  'invite',
  'shared',
]);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly ds: DataSource,
    private readonly auth: AuthService,
    private readonly events: EventsService,
    @InjectRepository(WorkspaceEntity) private readonly workspaces: Repository<WorkspaceEntity>,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
    @InjectRepository(ApiTokenEntity) private readonly tokens: Repository<ApiTokenEntity>,
  ) {}

  // ───────── workspaces

  listMine(userId: string) {
    return this.auth.workspacesOf(userId);
  }

  async create(user: UserEntity, input: { name: string; slug?: string }) {
    const explicit = input.slug?.trim().toLowerCase();
    const base = explicit || slugify(input.name) || 'workspace';
    if (explicit && !SLUG_RE.test(explicit))
      throw new BadRequestException('slug must be 3-40 chars: lowercase letters, digits and dashes');
    if (RESERVED_SLUGS.has(base)) {
      if (explicit) throw new ConflictException(`Slug "${base}" is reserved`);
    }
    let slug = RESERVED_SLUGS.has(base) || base.length < 3 ? `${base}-ws` : base;
    if (explicit && (await this.workspaces.existsBy({ slug }))) throw new ConflictException(`Slug "${slug}" is taken`);
    if (!explicit) {
      const root = slug;
      for (let i = 2; await this.workspaces.existsBy({ slug }); i++) slug = `${root}-${i}`;
    }
    const ws = await this.ds.transaction(async (m) => {
      const workspace = await m.save(
        m.create(WorkspaceEntity, {
          id: uid('ws'),
          name: input.name.trim(),
          slug,
          primaryOwnerId: user.id,
          settings: { roles: freshWorkspaceRoles() },
        }),
      );
      await m.save(
        m.create(MembershipEntity, { id: uid('mb'), workspaceId: workspace.id, userId: user.id, role: 'owner' }),
      );
      return workspace;
    });
    return Object.assign(ws, { role: 'owner' as Role });
  }

  async update(ws: WorkspaceEntity, patch: { name?: string; slug?: string }) {
    if (patch.name !== undefined) ws.name = patch.name.trim();
    if (patch.slug !== undefined && patch.slug !== ws.slug) {
      const slug = patch.slug.toLowerCase();
      if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) throw new BadRequestException('Invalid or reserved slug');
      if (await this.workspaces.existsBy({ slug })) throw new ConflictException(`Slug "${slug}" is taken`);
      ws.slug = slug;
    }
    return this.workspaces.save(ws);
  }

  /** Partial update of the customization settings. Roles are changed through the role endpoints. */
  async updateSettings(
    ctx: WorkspaceContext,
    patch: {
      defaultTeamId?: string | null;
      estimateScale?: WorkspaceSettings['estimateScale'];
      weekStart?: WorkspaceSettings['weekStart'];
      timeZone?: string;
      iconColor?: string | null;
      iconInitial?: string | null;
    },
  ) {
    const ws = ctx.workspace;
    const next: Partial<WorkspaceSettings> = { ...ws.settings };
    if (patch.defaultTeamId !== undefined) {
      if (patch.defaultTeamId === null) delete next.defaultTeamId;
      else {
        if (!(await this.ds.getRepository(TeamEntity).existsBy({ id: patch.defaultTeamId, workspaceId: ws.id })))
          throw new BadRequestException('defaultTeamId must be a team of this workspace');
        next.defaultTeamId = patch.defaultTeamId;
      }
    }
    if (patch.estimateScale !== undefined) next.estimateScale = patch.estimateScale;
    if (patch.weekStart !== undefined) next.weekStart = patch.weekStart;
    if (patch.timeZone !== undefined) {
      if (patch.timeZone !== 'auto') {
        try {
          new Intl.DateTimeFormat('en', { timeZone: patch.timeZone });
        } catch {
          throw new BadRequestException(`"${patch.timeZone}" is not a valid IANA time zone`);
        }
      }
      next.timeZone = patch.timeZone;
    }
    if (patch.iconColor !== undefined) {
      if (patch.iconColor === null) delete next.iconColor;
      else next.iconColor = patch.iconColor.toLowerCase();
    }
    if (patch.iconInitial !== undefined) {
      const initial = patch.iconInitial?.trim();
      if (!initial) delete next.iconInitial;
      else next.iconInitial = initial.toUpperCase();
    }
    ws.settings = next;
    const saved = await this.workspaces.save(ws);
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return saved;
  }

  private assertOwner(ctx: WorkspaceContext): void {
    if (!isOwner(ctx)) throw new ForbiddenException('Only an owner can change roles');
  }

  private async writeRoles(ws: WorkspaceEntity, roles: readonly WorkspaceRole[]): Promise<WorkspaceEntity> {
    const normalized = normalizeWorkspaceRoles(roles);
    const settings: Partial<WorkspaceSettings> = { ...ws.settings, roles: normalized };
    delete (settings as { permissions?: unknown }).permissions;
    delete (settings as { roleGrants?: unknown }).roleGrants;
    ws.settings = settings;
    const saved = await this.workspaces.save(ws);
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return saved;
  }

  /** Owner only. The new role starts with exactly the capabilities and grants that were sent. */
  async createRole(ctx: WorkspaceContext, input: { name: string; capabilities?: readonly unknown[]; grants?: readonly unknown[] }): Promise<WorkspaceEntity> {
    this.assertOwner(ctx);
    const name = input.name?.trim() ?? '';
    if (!name || name.length > ROLE_NAME_MAX) throw new BadRequestException(`A role name is required (at most ${ROLE_NAME_MAX} characters)`);
    const roles = ctx.workspace.resolved().roles;
    if (roles.some((role) => role.name.toLowerCase() === name.toLowerCase())) throw new ConflictException(`A role named "${name}" already exists`);
    this.assertKnownCapabilities(input.capabilities);
    const created: WorkspaceRole = {
      id: uid('role').toLowerCase(),
      name,
      owner: false,
      capabilities: normalizeCapabilities(input.capabilities ?? [], false),
      grants: normalizeGrantList(input.grants ?? []),
    };
    return this.writeRoles(ctx.workspace, [...roles, created]);
  }

  /** Owner only. The owner role stays the owner role and keeps membership management. */
  async updateRole(ctx: WorkspaceContext, roleId: string, patch: { name?: string; capabilities?: readonly unknown[]; grants?: readonly unknown[] }): Promise<WorkspaceEntity> {
    this.assertOwner(ctx);
    if (patch.name === undefined && patch.capabilities === undefined && patch.grants === undefined) throw new BadRequestException('Nothing to change');
    const roles = ctx.workspace.resolved().roles.map((role) => ({ ...role, capabilities: [...role.capabilities], grants: [...role.grants] }));
    const role = roles.find((item) => item.id === roleId);
    if (!role) throw notFound('Role', roleId);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > ROLE_NAME_MAX) throw new BadRequestException(`A role name is required (at most ${ROLE_NAME_MAX} characters)`);
      if (roles.some((item) => item.id !== role.id && item.name.toLowerCase() === name.toLowerCase())) throw new ConflictException(`A role named "${name}" already exists`);
      role.name = name;
    }
    if (patch.capabilities !== undefined) {
      this.assertKnownCapabilities(patch.capabilities);
      role.capabilities = normalizeCapabilities(patch.capabilities, role.owner);
    }
    if (patch.grants !== undefined && !role.owner) role.grants = normalizeGrantList(patch.grants);
    return this.writeRoles(ctx.workspace, roles);
  }

  private assertKnownCapabilities(input: readonly unknown[] | undefined): void {
    if (!input) return;
    for (const cap of input) {
      if (typeof cap !== 'string' || !(CAPABILITIES as readonly string[]).includes(cap))
        throw new BadRequestException(`Unknown capability "${String(cap)}"`);
    }
  }

  /** Owner only. The owner role cannot be deleted, and neither can a role someone still holds. */
  async deleteRole(ctx: WorkspaceContext, roleId: string): Promise<WorkspaceEntity> {
    this.assertOwner(ctx);
    const roles = ctx.workspace.resolved().roles;
    const role = findWorkspaceRole(roles, roleId);
    if (!role) throw notFound('Role', roleId);
    if (role.owner || role.id === OWNER_ROLE_ID) throw new ForbiddenException('The owner role cannot be deleted');
    if (await this.memberships.existsBy({ workspaceId: ctx.workspace.id, role: role.id })) throw new ConflictException('Move everyone off this role before deleting it');
    const pending = await this.ds.getRepository(InviteEntity).existsBy({ workspaceId: ctx.workspace.id, role: role.id, acceptedAt: IsNull(), revokedAt: IsNull() });
    if (pending) throw new ConflictException('Revoke invitations for this role before deleting it');
    return this.writeRoles(ctx.workspace, roles.filter((item) => item.id !== role.id));
  }

  /** Irreversible: the caller must repeat the workspace slug or name so a stray request cannot delete it. */
  async remove(ws: WorkspaceEntity, confirm: string): Promise<void> {
    const typed = (confirm ?? '').trim();
    if (typed !== ws.slug && typed !== ws.name)
      throw new BadRequestException('confirm must be the exact slug or name of the workspace you are deleting');
    await this.workspaces.delete({ id: ws.id });
  }

  // ───────── members

  async listMembers(workspaceId: string) {
    const rows = await this.memberships.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
    const users = await this.users.findBy({ id: In(rows.map((r) => r.userId)) });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((m) => Object.assign(m, { user: byId.get(m.userId) }));
  }

  private async getMembership(workspaceId: string, id: string) {
    const m = await this.memberships.findOneBy({ id, workspaceId });
    if (!m) throw notFound('Membership', id);
    return m;
  }

  async addMember(ws: WorkspaceEntity, callerRole: Role, input: { email: string; role: Role }, tokenScope?: TokenScope) {
    this.assertCanGrant(ws, callerRole, input.role, tokenScope);
    const user = await this.users.findOneBy({ email: input.email.trim().toLowerCase() });
    if (!user) throw notFound('User', input.email);
    if (await this.memberships.existsBy({ workspaceId: ws.id, userId: user.id }))
      throw new ConflictException('User is already a member');
    const m = await this.memberships.save(
      this.memberships.create({ id: uid('mb'), workspaceId: ws.id, userId: user.id, role: input.role }),
    );
    this.events.publish(ws.id, { type: 'created', entity: 'membership', id: m.id });
    return Object.assign(m, { user });
  }

  async changeRole(ws: WorkspaceEntity, caller: MemberActor, id: string, role: Role) {
    return this.updateMember(ws, caller, id, { role });
  }

  /** Change the role, the custom access, or both. Access can only narrow, and only within what the caller has. */
  async updateMember(
    ws: WorkspaceEntity,
    caller: MemberActor,
    id: string,
    patch: { role?: Role; access?: unknown },
  ) {
    if (patch.role === undefined && patch.access === undefined) throw new BadRequestException('Nothing to change');
    const m = await this.getMembership(ws.id, id);
    const nextRole = patch.role ?? m.role;
    const targetRole = patch.role !== undefined ? this.assertCanGrant(ws, caller.role, patch.role, caller.tokenScope) : findWorkspaceRole(ws.resolved().roles, nextRole);
    if (!targetRole) throw new BadRequestException(`Unknown role "${nextRole}"`);
    if (patch.role !== undefined && m.role !== patch.role) {
      assertCanChangeRole(await this.ruleContext(ws), caller, m, patch.role);
      m.role = patch.role;
    }
    const baseline = targetRole.grants;
    if (targetRole.owner) m.access = null;
    else if (patch.access !== undefined) {
      const access = this.parseAccess(patch.access, baseline);
      await this.assertCanGrantAccess(ws, caller, access, baseline);
      m.access = access;
    } else if (patch.role !== undefined) m.access = normalizeMemberAccess(m.access, baseline);
    await this.memberships.save(m);
    this.events.publish(ws.id, { type: 'updated', entity: 'membership', id: m.id });
    return Object.assign(m, { user: await this.users.findOneBy({ id: m.userId }) });
  }

  async removeMember(ws: WorkspaceEntity, caller: MemberActor, id: string) {
    const workspaceId = ws.id;
    const m = await this.getMembership(workspaceId, id);
    assertCanRemoveMember(await this.ruleContext(ws), caller, m);
    await this.ds.transaction(async (tx) => {
      await tx.delete(MembershipEntity, { id });
      const teams = await tx.findBy(TeamEntity, { workspaceId });
      for (const t of teams)
        if (t.memberIds.includes(m.userId))
          await tx.update(
            TeamEntity,
            { id: t.id },
            { memberIds: t.memberIds.filter((u) => u !== m.userId), leadIds: t.leadIds.filter((u) => u !== m.userId) },
          );
    });
    this.events.publish(workspaceId, { type: 'deleted', entity: 'membership', id });
  }

  /** The primary owner hands the workspace over: the target becomes owner and primary owner; the caller stays an owner. */
  async transferOwnership(ws: WorkspaceEntity, caller: MemberActor, membershipId: string) {
    const target = await this.getMembership(ws.id, membershipId);
    assertCanTransferOwnership(ws, caller, target.userId);
    if (target.role !== 'owner') {
      target.role = 'owner';
      await this.memberships.save(target);
      this.events.publish(ws.id, { type: 'updated', entity: 'membership', id: target.id });
    }
    ws.primaryOwnerId = target.userId;
    await this.workspaces.save(ws);
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return Object.assign(ws, { role: caller.role });
  }

  private async ruleContext(ws: WorkspaceEntity): Promise<MemberRuleContext> {
    return {
      primaryOwnerId: ws.primaryOwnerId,
      ownerCount: await this.memberships.countBy({ workspaceId: ws.id, role: 'owner' }),
    };
  }

  private parseAccess(input: unknown, baseline: readonly MemberGrant[]): MemberAccess | null {
    if (input == null) return null;
    if (typeof input !== 'object') throw new BadRequestException('access must be an object');
    return normalizeMemberAccess(input, baseline);
  }

  private async assertCanGrantAccess(
    ws: WorkspaceEntity,
    caller: MemberActor,
    access: MemberAccess | null,
    baseline: readonly MemberGrant[],
  ): Promise<void> {
    if (!caller.userId) {
      if (access) throw new ForbiddenException('Only a person can set access limits');
      return;
    }
    const callerRole = this.effectiveCaller(ws, caller.role, caller.tokenScope);
    if (callerRole?.owner) return;
    const mine = await this.memberships.findOneBy({ workspaceId: ws.id, userId: caller.userId });
    const callerAccess = effectiveMemberAccess(callerRole, mine?.access ?? null);
    if (!accessWithin(access, callerAccess, baseline)) throw new ForbiddenException('You cannot grant access wider than your own');
  }

  private effectiveCaller(ws: WorkspaceEntity, callerRole: Role, tokenScope?: TokenScope): WorkspaceRole | undefined {
    const found = findWorkspaceRole(ws.resolved().roles, callerRole);
    return found ? applyTokenScope(found, tokenScope) : undefined;
  }

  /** The target role, when the caller may grant it. Throws otherwise. */
  private assertCanGrant(ws: WorkspaceEntity, callerRole: Role, targetId: Role, tokenScope?: TokenScope): WorkspaceRole {
    const target = findWorkspaceRole(ws.resolved().roles, targetId);
    if (!target) throw new BadRequestException(`Unknown role "${targetId}"`);
    const caller = this.effectiveCaller(ws, callerRole, tokenScope);
    if (!canGrantRole(caller, target)) throw new ForbiddenException('You cannot grant a role with permissions you do not have');
    return target;
  }

  // ───────── agents

  listAgents(workspaceId: string) {
    return this.agents.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
  }

  async getAgent(workspaceId: string, id: string) {
    const a = await this.agents.findOneBy({ id, workspaceId });
    if (!a) throw notFound('Agent', id);
    return a;
  }

  async createAgent(workspaceId: string, input: Partial<AgentEntity> & Pick<AgentEntity, 'name' | 'provider'>) {
    if (input.ownerUserId && !(await this.memberships.existsBy({ workspaceId, userId: input.ownerUserId })))
      throw new BadRequestException('ownerUserId must be a workspace member');
    const agent = await this.agents.save(
      this.agents.create({
        id: uid('ag'),
        workspaceId,
        name: input.name.trim(),
        provider: input.provider,
        description: input.description ?? null,
        ownerUserId: input.ownerUserId ?? null,
      }),
    );
    this.events.publish(workspaceId, { type: 'created', entity: 'agent', id: agent.id });
    return agent;
  }

  async updateAgent(workspaceId: string, id: string, patch: Partial<AgentEntity>) {
    const agent = await this.getAgent(workspaceId, id);
    if (patch.ownerUserId && !(await this.memberships.existsBy({ workspaceId, userId: patch.ownerUserId })))
      throw new BadRequestException('ownerUserId must be a workspace member');
    for (const k of ['name', 'provider', 'description', 'ownerUserId'] as const)
      if (patch[k] !== undefined) (agent as unknown as Record<string, unknown>)[k] = patch[k];
    await this.agents.save(agent);
    this.events.publish(workspaceId, { type: 'updated', entity: 'agent', id });
    return agent;
  }

  async removeAgent(workspaceId: string, id: string) {
    await this.getAgent(workspaceId, id);
    await this.ds.transaction(async (m) => {
      await m.query(`DELETE FROM "api_tokens" WHERE "workspaceId" = $1 AND "actor"->>'id' = $2`, [workspaceId, id]);
      await m.delete(AgentEntity, { id });
    });
    this.events.publish(workspaceId, { type: 'deleted', entity: 'agent', id });
  }

  // ───────── tokens

  listTokens(workspaceId: string, onlyUserId?: string) {
    const qb = this.tokens
      .createQueryBuilder('t')
      .where('t.workspaceId = :workspaceId', { workspaceId })
      .orderBy('t.createdAt', 'DESC');
    if (onlyUserId) qb.andWhere('t.createdByUserId = :onlyUserId', { onlyUserId });
    return qb.getMany();
  }

  async removeToken(workspaceId: string, id: string, onlyUserId?: string) {
    const t = await this.tokens.findOneBy({ id, workspaceId });
    if (!t || (onlyUserId && t.createdByUserId !== onlyUserId)) throw notFound('Token', id);
    await this.tokens.delete({ id });
  }
}
