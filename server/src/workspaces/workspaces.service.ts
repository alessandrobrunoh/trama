import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service.js';
import { hasRole } from '../auth/request-context.js';
import type { Role } from '../contracts/domain.js';
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

/** Slugs that would collide with client routes. */
export const RESERVED_SLUGS = new Set([
  'login',
  'signup',
  'new-workspace',
  'settings',
  'api',
  'admin',
  'auth',
  'workspaces',
  'invite',
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
        m.create(WorkspaceEntity, { id: uid('ws'), name: input.name.trim(), slug }),
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

  async remove(ws: WorkspaceEntity): Promise<void> {
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

  async changeRole(workspaceId: string, callerRole: Role, id: string, role: Role) {
    const m = await this.getMembership(workspaceId, id);
    this.assertCanGrant(callerRole, role);
    if (m.role === 'owner' && callerRole !== 'owner') throw new ForbiddenException('Only an owner can change an owner');
    if (m.role === 'owner' && role !== 'owner') await this.assertNotLastOwner(workspaceId, m);
    m.role = role;
    await this.memberships.save(m);
    this.events.publish(workspaceId, { type: 'updated', entity: 'membership', id: m.id });
    return Object.assign(m, { user: await this.users.findOneBy({ id: m.userId }) });
  }

  async removeMember(workspaceId: string, callerRole: Role, callerUserId: string | undefined, id: string) {
    const m = await this.getMembership(workspaceId, id);
    const self = m.userId === callerUserId;
    if (!self && !hasRole(callerRole, 'admin')) throw new ForbiddenException('Requires role admin or higher');
    if (m.role === 'owner') {
      if (callerRole !== 'owner') throw new ForbiddenException('Only an owner can remove an owner');
      await this.assertNotLastOwner(workspaceId, m);
    }
    await this.ds.transaction(async (tx) => {
      await tx.delete(MembershipEntity, { id });
      const teams = await tx.findBy(TeamEntity, { workspaceId });
      for (const t of teams)
        if (t.memberIds.includes(m.userId))
          await tx.update(TeamEntity, { id: t.id }, { memberIds: t.memberIds.filter((u) => u !== m.userId) });
    });
    this.events.publish(workspaceId, { type: 'deleted', entity: 'membership', id });
  }

  private assertCanGrant(callerRole: Role, target: Role) {
    if (target === 'owner' && callerRole !== 'owner') throw new ForbiddenException('Only an owner can grant owner');
  }

  private async assertNotLastOwner(workspaceId: string, m: MembershipEntity) {
    const owners = await this.memberships.countBy({ workspaceId, role: 'owner' });
    if (owners <= 1 && m.role === 'owner') throw new ConflictException('A workspace needs at least one owner');
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
