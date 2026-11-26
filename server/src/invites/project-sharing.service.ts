import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, type Repository } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import { notFound } from '../common/util.js';
import {
  GUEST_ROLE_ID,
  accessIncludesProject,
  applyTokenScope,
  canGrantRole,
  effectiveMemberAccess,
  findWorkspaceRole,
  isProjectLimited,
  type MemberAccess,
  type ProjectInviteResult,
  type ProjectShare,
  type ProjectShareMember,
  type WorkspaceRole,
} from '../contracts/domain.js';
import { InviteEntity, MembershipEntity, UserEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { visibleMemberships } from '../workspaces/people-scope.js';
import { InvitesService } from './invites.service.js';

/** Access limited to these projects: no unassigned work, nothing beyond the role. */
const projectAccess = (projectIds: string[], stored?: MemberAccess | null): MemberAccess => ({
  projects: { all: false, projectIds },
  includeUnassigned: false,
  grants: stored?.grants ?? [],
});

const listedProjects = (access: MemberAccess | null | undefined): string[] =>
  access && !access.projects.all ? access.projects.projectIds : [];

/**
 * Sharing one project with people outside the workspace's regular members. A person invited this way is a
 * guest: the `guest` role with `access.projects` naming this project (and any other they were invited to).
 * Everything here builds on membership access and invitations; nothing about visibility lives in this file.
 */
@Injectable()
export class ProjectSharingService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly invites: InvitesService,
    private readonly events: EventsService,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(InviteEntity) private readonly inviteRows: Repository<InviteEntity>,
  ) {}

  /** Who can open the project (guests, limited members, and everyone who sees every project), and pending project invitations. */
  async share(ctx: WorkspaceContext, projectId: string): Promise<ProjectShare> {
    const workspaceId = ctx.workspace.id;
    await this.projects.get(workspaceId, projectId);
    const roles = ctx.workspace.resolved().roles;
    const all = await this.memberships.find({ where: { workspaceId }, order: { createdAt: 'ASC' } });
    const onProject = all.filter((m) =>
      accessIncludesProject(effectiveMemberAccess(findWorkspaceRole(roles, m.role), m.access), projectId),
    );
    const rows = visibleMemberships(onProject, roles, ctx.access, ctx.userId);
    const users = await this.users.findBy({ id: In(rows.map((row) => row.userId)) });
    const byId = new Map(users.map((user) => [user.id, user]));
    const members = rows.map((row) => this.present(row, roles, byId.get(row.userId)));
    const pending = await this.inviteRows.find({
      where: { workspaceId, acceptedAt: IsNull(), revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    const invites = pending.filter((invite) => listedProjects(invite.access).includes(projectId));
    return { members, invites: invites as unknown as ProjectShare['invites'] };
  }

  /**
   * Invite `email` to this project as a guest. A person who is already a guest (or limited to some projects)
   * gets the project added to their list. Someone who already sees every project cannot be invited again.
   */
  async invite(ctx: WorkspaceContext, projectId: string, rawEmail: string): Promise<ProjectInviteResult> {
    const workspace = ctx.workspace;
    await this.projects.get(workspace.id, projectId);
    const email = rawEmail.trim().toLowerCase();
    const roles = workspace.resolved().roles;
    const user = await this.users.findOneBy({ email });
    const membership = user
      ? await this.memberships.findOneBy({ workspaceId: workspace.id, userId: user.id })
      : null;

    if (user && membership) {
      const target = findWorkspaceRole(roles, membership.role);
      const effective = effectiveMemberAccess(target, membership.access);
      if (!isProjectLimited(effective))
        throw new BadRequestException(
          `${user.name || email} is already a member with access to every project. Nothing to share.`,
        );
      if (!canGrantRole(this.callerRole(ctx), target))
        throw new ForbiddenException('You cannot change the access of someone with permissions you do not have');
      if (!accessIncludesProject(effective, projectId)) {
        membership.access = projectAccess([...listedProjects(effective), projectId], membership.access);
        await this.memberships.save(membership);
        this.events.publish(workspace.id, { type: 'updated', entity: 'membership', id: membership.id });
      }
      return { status: 'added', member: this.present(membership, roles, user) };
    }

    if (!findWorkspaceRole(roles, GUEST_ROLE_ID))
      throw new BadRequestException(
        'This workspace has no Guest role. Add one in Settings · Roles & permissions before inviting guests.',
      );
    const pending = await this.inviteRows.findOneBy({
      workspaceId: workspace.id,
      email,
      acceptedAt: IsNull(),
      revokedAt: IsNull(),
    });
    if (pending && pending.role !== GUEST_ROLE_ID)
      throw new ConflictException(
        'This person already has a pending workspace invitation. Manage it in Settings · Members.',
      );
    const projectIds = [...new Set([...listedProjects(pending?.access), projectId])];
    const link = await this.invites.create(
      workspace,
      { userId: ctx.userId, role: ctx.role, tokenScope: ctx.tokenScope },
      { email, role: GUEST_ROLE_ID, access: projectAccess(projectIds) },
    );
    return { status: 'invited', link };
  }

  /** New link for a pending guest invitation of this project. */
  async resend(ctx: WorkspaceContext, projectId: string, inviteId: string) {
    await this.projects.get(ctx.workspace.id, projectId);
    await this.findProjectInvite(ctx.workspace.id, projectId, inviteId);
    return this.invites.resend(ctx.workspace, { role: ctx.role, tokenScope: ctx.tokenScope }, inviteId);
  }

  /** Takes this project off a pending invitation, and revokes it when it was the only one. */
  async revokeInvite(ctx: WorkspaceContext, projectId: string, inviteId: string): Promise<void> {
    await this.projects.get(ctx.workspace.id, projectId);
    const invite = await this.findProjectInvite(ctx.workspace.id, projectId, inviteId);
    const rest = listedProjects(invite.access).filter((id) => id !== projectId);
    if (!rest.length) {
      await this.invites.revoke(ctx.workspace.id, inviteId);
      return;
    }
    invite.access = projectAccess(rest, invite.access);
    await this.inviteRows.save(invite);
    this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'invite', id: invite.id });
  }

  /**
   * Take this project away from a guest or a limited member. When it was their last project and they are a
   * guest, they leave the workspace. People who see every project are changed in Settings · Members.
   */
  async removeAccess(
    ctx: WorkspaceContext,
    projectId: string,
    membershipId: string,
  ): Promise<{ membershipEnded: boolean }> {
    const workspace = ctx.workspace;
    await this.projects.get(workspace.id, projectId);
    const roles = workspace.resolved().roles;
    const membership = await this.memberships.findOneBy({ id: membershipId, workspaceId: workspace.id });
    if (!membership) throw notFound('Membership', membershipId);
    const target = findWorkspaceRole(roles, membership.role);
    const effective = effectiveMemberAccess(target, membership.access);
    if (!isProjectLimited(effective))
      throw new BadRequestException('This person sees every project. Change their access in Settings · Members.');
    if (!accessIncludesProject(effective, projectId)) throw notFound('Membership', membershipId);
    if (!canGrantRole(this.callerRole(ctx), target))
      throw new ForbiddenException('You cannot change the access of someone with permissions you do not have');
    const rest = listedProjects(effective).filter((id) => id !== projectId);
    if (!rest.length) {
      if (membership.role !== GUEST_ROLE_ID)
        throw new BadRequestException(
          'This is their last project. Change their access or remove them in Settings · Members.',
        );
      await this.memberships.delete({ id: membership.id });
      this.events.publish(workspace.id, { type: 'deleted', entity: 'membership', id: membership.id });
      return { membershipEnded: true };
    }
    membership.access = projectAccess(rest, membership.access);
    await this.memberships.save(membership);
    this.events.publish(workspace.id, { type: 'updated', entity: 'membership', id: membership.id });
    return { membershipEnded: false };
  }

  // ───────────── internals ─────────────

  private callerRole(ctx: WorkspaceContext): WorkspaceRole | undefined {
    const found = findWorkspaceRole(ctx.workspace.resolved().roles, ctx.role);
    return found ? applyTokenScope(found, ctx.tokenScope) : undefined;
  }

  private async findProjectInvite(workspaceId: string, projectId: string, inviteId: string): Promise<InviteEntity> {
    const invite = await this.inviteRows.findOneBy({
      id: inviteId,
      workspaceId,
      acceptedAt: IsNull(),
      revokedAt: IsNull(),
    });
    if (!invite || !listedProjects(invite.access).includes(projectId)) throw notFound('Invite', inviteId);
    return invite;
  }

  private present(
    membership: MembershipEntity,
    roles: readonly WorkspaceRole[],
    user: UserEntity | undefined,
  ): ProjectShareMember {
    return Object.assign(membership, {
      user,
      allProjects: !isProjectLimited(
        effectiveMemberAccess(findWorkspaceRole(roles, membership.role), membership.access),
      ),
    }) as unknown as ProjectShareMember;
  }
}
