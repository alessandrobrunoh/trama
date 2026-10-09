import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service.js';
import { hasRole, type WorkspaceContext } from '../auth/request-context.js';
import { CAPABILITIES, CAPABILITY_ROLES } from '../contracts/domain.js';
import type { Capability, PermissionMap, Role, WorkspaceSettings } from '../contracts/domain.js';
import {
  AgentEntity,
  ApiTokenEntity,
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
        m.create(WorkspaceEntity, { id: uid('ws'), name: input.name.trim(), slug, primaryOwnerId: user.id }),
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

  /** Partial update of the customization settings. Changing `permissions` is reserved to owners. */
  async updateSettings(
    ctx: WorkspaceContext,
    patch: {
      permissions?: Record<string, string>;
      defaultTeamId?: string | null;
      estimateScale?: WorkspaceSettings['estimateScale'];
      weekStart?: WorkspaceSettings['weekStart'];
      timeZone?: string;
      iconColor?: string | null;
      iconInitial?: string | null;
      deltaThreads?: boolean;
    },
  ) {
    const ws = ctx.workspace;
    const next: Partial<WorkspaceSettings> = { ...ws.settings };
    if (patch.permissions !== undefined) {
      if (!hasRole(ctx.role, 'owner')) throw new ForbiddenException('Only an owner can change roles and permissions');
      const perms: Partial<PermissionMap> = { ...(next.permissions ?? {}) };
      for (const [cap, role] of Object.entries(patch.permissions)) {
        if (!CAPABILITIES.includes(cap as Capability)) throw new BadRequestException(`Unknown capability "${cap}"`);
        if (!CAPABILITY_ROLES.includes(role as Role))
          throw new BadRequestException(`"${role}" is not a valid minimum role for ${cap} (use ${CAPABILITY_ROLES.join(', ')})`);
        perms[cap as Capability] = role as Role;
      }
      next.permissions = perms as PermissionMap;
    }
    if (patch.defaultTeamId !== undefined) {
      if (patch.defaultTeamId === null) delete next.defaultTeamId;
      else {
        if (!(await this.ds.getRepository(TeamEntity).existsBy({ id: patch.defaultTeamId, workspaceId: ws.id })))
          throw new BadRequestException('defaultTeamId must be a team of this workspace');
        next.defaultTeamId = patch.defaultTeamId;
      }
    }
    if (patch.estimateScale !== undefined) next.estimateScale = patch.estimateScale;
    if (patch.deltaThreads !== undefined) next.deltaThreads = patch.deltaThreads;
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

  async addMember(workspaceId: string, callerRole: Role, input: { email: string; role: Role }) {
    this.assertCanGrant(callerRole, input.role);
    const user = await this.users.findOneBy({ email: input.email.trim().toLowerCase() });
    if (!user) throw notFound('User', input.email);
    if (await this.memberships.existsBy({ workspaceId, userId: user.id }))
      throw new ConflictException('User is already a member');
    const m = await this.memberships.save(
      this.memberships.create({ id: uid('mb'), workspaceId, userId: user.id, role: input.role }),
    );
    this.events.publish(workspaceId, { type: 'created', entity: 'membership', id: m.id });
    return Object.assign(m, { user });
  }

  async changeRole(ws: WorkspaceEntity, caller: MemberActor, id: string, role: Role) {
    const m = await this.getMembership(ws.id, id);
    this.assertCanGrant(caller.role, role);
    if (m.role !== role) assertCanChangeRole(await this.ruleContext(ws), caller, m, role);
    m.role = role;
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

  private assertCanGrant(callerRole: Role, target: Role) {
    if (target === 'owner' && callerRole !== 'owner') throw new ForbiddenException('Only an owner can grant owner');
    if (!hasRole(callerRole, target)) throw new ForbiddenException(`You cannot grant a role above your own (${callerRole})`);
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
