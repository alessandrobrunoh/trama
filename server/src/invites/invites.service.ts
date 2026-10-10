import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, type Repository } from 'typeorm';
import { appUrl } from '../common/app-url.js';
import { notFound, uid } from '../common/util.js';
import {
  accessWithin,
  effectiveMemberAccess,
  INVITE_TTL_DAYS,
  normalizeMemberAccess,
  type InviteLink,
  type InvitePreview,
  type MemberAccess,
  type MemberGrant,
  type Role,
} from '../contracts/domain.js';
import {
  InviteEntity,
  MembershipEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { MailService } from '../mail/mail.service.js';
import { hasRole } from '../auth/request-context.js';
import { renderInviteEmail } from './invite-email.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** `a***@example.com`: enough for someone to recognise the account without exposing the address. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain ?? ''}`;
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(InviteEntity) private readonly invites: Repository<InviteEntity>,
    @InjectRepository(WorkspaceEntity) private readonly workspaces: Repository<WorkspaceEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    private readonly events: EventsService,
    private readonly mail: MailService,
  ) {}

  /** Pending invitations (expired ones included, so they can be resent), newest first. */
  list(workspaceId: string): Promise<InviteEntity[]> {
    return this.invites.find({
      where: { workspaceId, acceptedAt: IsNull(), revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Invite `email` to the workspace. Inviting an address that already has a pending invitation
   * refreshes it (new link, new expiry) instead of piling up duplicates.
   */
  async create(
    workspace: WorkspaceEntity,
    inviter: { userId?: string; role: Role },
    input: { email: string; role: Role; access?: unknown },
  ): Promise<InviteLink> {
    this.assertCanGrant(inviter.role, input.role);
    const baseline = workspace.resolved().roleGrants[input.role];
    const access = input.role === 'owner' ? null : this.parseAccess(input.access, baseline);
    await this.assertCanGrantAccess(workspace, inviter, access, baseline);
    const email = input.email.trim().toLowerCase();
    const existing = await this.users.findOneBy({ email });
    if (existing && (await this.memberships.existsBy({ workspaceId: workspace.id, userId: existing.id })))
      throw new ConflictException('This person is already a member');

    let invite = await this.invites.findOneBy({
      workspaceId: workspace.id,
      email,
      acceptedAt: IsNull(),
      revokedAt: IsNull(),
    });
    const created = !invite;
    invite ??= this.invites.create({
      id: uid('inv'),
      workspaceId: workspace.id,
      email,
      invitedByUserId: inviter.userId ?? null,
      emailedAt: null,
      acceptedAt: null,
      revokedAt: null,
    });
    invite.role = input.role;
    invite.access = access;
    const link = await this.issueLink(workspace, invite);
    this.events.publish(workspace.id, { type: created ? 'created' : 'updated', entity: 'invite', id: invite.id });
    return link;
  }

  /** New link and expiry for a pending invitation, emailed again. */
  async resend(workspace: WorkspaceEntity, callerRole: Role, id: string): Promise<InviteLink> {
    const invite = await this.findPending(workspace.id, id);
    this.assertCanGrant(callerRole, invite.role);
    const link = await this.issueLink(workspace, invite);
    this.events.publish(workspace.id, { type: 'updated', entity: 'invite', id: invite.id });
    return link;
  }

  async revoke(workspaceId: string, id: string): Promise<void> {
    const invite = await this.findPending(workspaceId, id);
    invite.revokedAt = new Date();
    await this.invites.save(invite);
    this.events.publish(workspaceId, { type: 'deleted', entity: 'invite', id });
  }

  /** What the holder of a link may see before signing in. 404 for unknown, used, revoked or expired links. */
  async preview(token: string): Promise<InvitePreview> {
    const invite = await this.findByToken(token);
    const [workspace, inviter] = await Promise.all([
      this.workspaces.findOneByOrFail({ id: invite.workspaceId }),
      invite.invitedByUserId ? this.users.findOneBy({ id: invite.invitedByUserId }) : null,
    ]);
    return {
      workspaceName: workspace.name,
      role: invite.role,
      email: invite.email,
      invitedByName: inviter?.name,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** Join the workspace as the signed-in user. The account's email must match the invited one. */
  async accept(token: string, user: UserEntity): Promise<{ workspace: { slug: string; name: string }; role: Role }> {
    const invite = await this.findByToken(token);
    if (user.email.toLowerCase() !== invite.email)
      throw new ForbiddenException(
        `This invitation was sent to ${maskEmail(invite.email)}. Sign in with that account to accept it.`,
      );
    const workspace = await this.workspaces.findOneByOrFail({ id: invite.workspaceId });
    let membershipId: string | undefined;
    let role = invite.role;
    await this.ds.transaction(async (m) => {
      const current = await m.findOneBy(MembershipEntity, { workspaceId: workspace.id, userId: user.id });
      if (current) role = current.role;
      else {
        const saved = await m.save(
          m.create(MembershipEntity, {
            id: uid('mb'),
            workspaceId: workspace.id,
            userId: user.id,
            role: invite.role,
            access: invite.role === 'owner' ? null : invite.access,
          }),
        );
        membershipId = saved.id;
      }
      invite.acceptedAt = new Date();
      await m.save(invite);
    });
    if (membershipId) this.events.publish(workspace.id, { type: 'created', entity: 'membership', id: membershipId });
    this.events.publish(workspace.id, { type: 'deleted', entity: 'invite', id: invite.id });
    return { workspace: { slug: workspace.slug, name: workspace.name }, role };
  }

  // ───────────── internals ─────────────

  /** Rotates the secret, extends the expiry, saves, and emails the new link. */
  private async issueLink(workspace: WorkspaceEntity, invite: InviteEntity): Promise<InviteLink> {
    const token = randomBytes(32).toString('base64url');
    invite.tokenHash = hashToken(token);
    invite.expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * DAY_MS);
    await this.invites.save(invite);

    const url = `${appUrl()}/invite/${token}`;
    const inviter = invite.invitedByUserId ? await this.users.findOneBy({ id: invite.invitedByUserId }) : null;
    const message = renderInviteEmail({
      workspaceName: workspace.name,
      inviterName: inviter?.name,
      role: invite.role,
      url,
      expiresAt: invite.expiresAt,
    });
    const emailed = await this.mail.send({ to: invite.email, ...message });
    if (emailed) {
      invite.emailedAt = new Date();
      await this.invites.save(invite);
    }
    return { invite: invite as unknown as InviteLink['invite'], url, emailed };
  }

  private async findPending(workspaceId: string, id: string): Promise<InviteEntity> {
    const invite = await this.invites.findOneBy({ id, workspaceId, acceptedAt: IsNull(), revokedAt: IsNull() });
    if (!invite) throw notFound('Invite', id);
    return invite;
  }

  private async findByToken(token: string): Promise<InviteEntity> {
    const invite = token ? await this.invites.findOneBy({ tokenHash: hashToken(token) }) : null;
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() < Date.now())
      throw new NotFoundException('This invitation is no longer valid');
    return invite;
  }

  private assertCanGrant(callerRole: Role, target: Role): void {
    if (target === 'owner' && callerRole !== 'owner') throw new ForbiddenException('Only an owner can grant owner');
    if (!hasRole(callerRole, target)) throw new ForbiddenException(`You cannot grant a role above your own (${callerRole})`);
  }

  /** `undefined` means no custom access. Anything else is normalized and clamped to the role. */
  private parseAccess(input: unknown, baseline: readonly MemberGrant[]): MemberAccess | null {
    if (input == null) return null;
    if (typeof input !== 'object') throw new BadRequestException('access must be an object');
    return normalizeMemberAccess(input, baseline);
  }

  /** A limited inviter can only hand out projects and actions they already have, including the target role. */
  private async assertCanGrantAccess(
    workspace: WorkspaceEntity,
    inviter: { userId?: string; role: Role },
    access: MemberAccess | null,
    baseline: readonly MemberGrant[],
  ): Promise<void> {
    if (!inviter.userId) {
      if (access) throw new ForbiddenException('Only a person can set access limits');
      return;
    }
    if (inviter.role === 'owner') return;
    const mine = await this.memberships.findOneBy({ workspaceId: workspace.id, userId: inviter.userId });
    const callerAccess = effectiveMemberAccess(inviter.role, mine?.access ?? null, workspace.resolved().roleGrants);
    if (!accessWithin(access, callerAccess, baseline))
      throw new ForbiddenException('You cannot grant access wider than your own');
  }
}
