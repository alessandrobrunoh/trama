import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import { canDo, type WorkspaceContext } from '../auth/request-context.js';
import { decryptSecret, encryptSecret } from '../common/crypto.js';
import { notFound, uid } from '../common/util.js';
import type { SavedView, ShareGrant, ShareLevel, ShareVisibility, SharingSettings, ViewEntity, ViewFilter, ViewLayout } from '../contracts/domain.js';
import { MembershipEntity, SavedViewEntity, UserEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { DEFAULT_SHARING, canEditView, canManageSharing, canReadView, type ViewActor } from './view-access.js';
import { viewLayoutProblem } from './view-rules.js';
import { generatePublicToken, hashPublicToken } from './view-token.js';

/** At most this many invited people per view. */
export const MAX_GRANTS = 100;

export interface SharingInput {
  visibility?: ShareVisibility;
  /** Replaces the whole list of invited people. */
  grants?: ShareGrant[];
}

export interface ViewInput {
  name?: string;
  entity?: ViewEntity;
  filters?: ViewFilter[];
  sort?: SavedView['sort'] | null;
  groupBy?: string | null;
  layout?: ViewLayout;
  /** Legacy flag: `true` = visible to the workspace, `false` = private. Prefer `sharing`. */
  shared?: boolean;
  sharing?: SharingInput;
}

type ViewCtx = Pick<WorkspaceContext, 'workspace' | 'userId' | 'role'>;

const actorOf = (ctx: ViewCtx): ViewActor => ({ userId: ctx.userId, role: ctx.role });

@Injectable()
export class ViewsService {
  constructor(
    private readonly events: EventsService,
    @InjectRepository(SavedViewEntity) private readonly repo: Repository<SavedViewEntity>,
    private readonly ds: DataSource,
  ) {}

  /** What the caller may see: own views, views shared with the workspace or by link, and views they were invited to. */
  async list(ctx: ViewCtx): Promise<SavedView[]> {
    const rows = await this.repo.find({ where: { workspaceId: ctx.workspace.id }, order: { createdAt: 'ASC' } });
    return rows.filter((r) => canReadView(r, actorOf(ctx))).map((r) => this.present(r, ctx));
  }

  async get(ctx: ViewCtx, id: string): Promise<SavedView> {
    return this.present(await this.load(ctx, id), ctx);
  }

  async create(ctx: ViewCtx, input: ViewInput & { name: string; entity: ViewEntity }): Promise<SavedView> {
    if (!ctx.userId) throw new ForbiddenException('Agents cannot own saved views');
    const visibility = input.sharing?.visibility ?? (input.shared ? 'workspace' : 'private');
    if (visibility !== 'private') this.assertCanShare(ctx);
    this.assertLayoutFits(input.entity, input.layout ?? 'list');
    const grants = await this.checkGrants(ctx.workspace.id, ctx.userId, input.sharing?.grants ?? []);
    const row = this.repo.create({
      id: uid('vw'),
      workspaceId: ctx.workspace.id,
      ownerId: ctx.userId,
      name: input.name.trim(),
      entity: input.entity,
      filters: input.filters ?? [],
      sort: input.sort ?? null,
      groupBy: input.groupBy ?? null,
      layout: input.layout ?? 'list',
      shared: false,
      sharing: { ...DEFAULT_SHARING },
      publicTokenHash: null,
      publicTokenEnc: null,
    });
    this.applySharing(row, { visibility, grants });
    await this.repo.save(row);
    this.events.publish(ctx.workspace.id, { type: 'created', entity: 'view', id: row.id });
    return this.present(row, ctx);
  }

  async update(ctx: ViewCtx, id: string, patch: ViewInput): Promise<SavedView> {
    const row = await this.load(ctx, id);
    const actor = actorOf(ctx);
    if (!canEditView(row, actor)) throw new ForbiddenException('You can only view this view; ask the owner for edit access');
    this.assertLayoutFits(patch.entity ?? row.entity, patch.layout ?? row.layout);

    if (patch.shared !== undefined || patch.sharing !== undefined) {
      if (!canManageSharing(row, actor)) throw new ForbiddenException('Only the owner (or an admin, for shared views) can change who has access');
      const current = row.sharing.visibility;
      const visibility: ShareVisibility =
        patch.sharing?.visibility ?? (patch.shared === undefined ? current : patch.shared ? (current === 'private' ? 'workspace' : current) : 'private');
      if (visibility !== current && visibility !== 'private') this.assertCanShare(ctx);
      const grants = patch.sharing?.grants ? await this.checkGrants(ctx.workspace.id, row.ownerId, patch.sharing.grants) : row.sharing.grants;
      this.applySharing(row, { visibility, grants });
    }

    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.entity !== undefined) row.entity = patch.entity;
    if (patch.filters !== undefined) row.filters = patch.filters;
    if (patch.sort !== undefined) row.sort = patch.sort;
    if (patch.groupBy !== undefined) row.groupBy = patch.groupBy;
    if (patch.layout !== undefined) row.layout = patch.layout;
    row.updatedAt = new Date();
    await this.repo.save(row);
    this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'view', id });
    return this.present(row, ctx);
  }

  /** Invite existing workspace members by email (comma separated in the UI; one entry per address here). */
  async invite(ctx: ViewCtx, id: string, emails: string[], level: ShareLevel = 'view'): Promise<SavedView> {
    const row = await this.load(ctx, id);
    if (!canManageSharing(row, actorOf(ctx))) throw new ForbiddenException('Only the owner (or an admin, for shared views) can invite people');
    const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length) throw new BadRequestException('Enter at least one email address');
    const members = await this.ds.getRepository(MembershipEntity).findBy({ workspaceId: ctx.workspace.id });
    const users = members.length ? await this.ds.getRepository(UserEntity).findBy({ id: In(members.map((m) => m.userId)) }) : [];
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
    const unknown = wanted.filter((e) => !byEmail.has(e));
    if (unknown.length) throw new BadRequestException(`Not members of this workspace: ${unknown.join(', ')}. Invite them to the workspace first.`);
    const grants = [...row.sharing.grants];
    for (const email of wanted) {
      const userId = byEmail.get(email)!;
      if (userId === row.ownerId) continue;
      const existing = grants.find((g) => g.userId === userId);
      if (existing) existing.level = level;
      else grants.push({ userId, level });
    }
    if (grants.length > MAX_GRANTS) throw new BadRequestException(`A view can be shared with at most ${MAX_GRANTS} people`);
    row.sharing = { visibility: row.sharing.visibility, grants };
    row.updatedAt = new Date();
    await this.repo.save(row);
    this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'view', id });
    return this.present(row, ctx);
  }

  /** Replace the public link with a new one; the old link stops working immediately. */
  async rotateLink(ctx: ViewCtx, id: string): Promise<SavedView> {
    const row = await this.load(ctx, id);
    if (!canManageSharing(row, actorOf(ctx))) throw new ForbiddenException('Only the owner (or an admin, for shared views) can change the public link');
    if (row.sharing.visibility !== 'link') throw new BadRequestException('This view is not shared by link');
    this.mintToken(row);
    row.updatedAt = new Date();
    await this.repo.save(row);
    this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'view', id });
    return this.present(row, ctx);
  }

  async remove(ctx: ViewCtx, id: string) {
    const row = await this.load(ctx, id);
    if (!canManageSharing(row, actorOf(ctx))) throw new ForbiddenException('Only the owner (or an admin, for shared views) can delete a view');
    await this.repo.delete({ id });
    this.events.publish(ctx.workspace.id, { type: 'deleted', entity: 'view', id });
  }

  // ── internals ──

  /** The row, or 404 when it does not exist or the caller may not see it (existence is not leaked). */
  private async load(ctx: ViewCtx, id: string): Promise<SavedViewEntity> {
    const row = await this.repo.findOneBy({ id, workspaceId: ctx.workspace.id });
    if (!row || !canReadView(row, actorOf(ctx))) throw notFound('View', id);
    return row;
  }

  /** Wire shape: the secret link is included only for people who can manage sharing. */
  private present(row: SavedViewEntity, ctx: ViewCtx): SavedView {
    const out = { ...row.toJSON() } as unknown as SavedView;
    out.sharing = row.sharing;
    if (row.sharing.visibility === 'link' && row.publicTokenEnc && canManageSharing(row, actorOf(ctx))) {
      out.publicToken = decryptSecret(row.publicTokenEnc);
    }
    return out;
  }

  /** Sets visibility + grants and keeps the legacy `shared` flag and the public token in step. */
  private applySharing(row: SavedViewEntity, next: SharingSettings): void {
    row.sharing = { visibility: next.visibility, grants: next.grants };
    row.shared = next.visibility !== 'private';
    if (next.visibility === 'link') {
      if (!row.publicTokenHash || !row.publicTokenEnc) this.mintToken(row);
    } else {
      // Leaving link sharing revokes the public URL for good; going back creates a new one.
      row.publicTokenHash = null;
      row.publicTokenEnc = null;
    }
  }

  private mintToken(row: SavedViewEntity): void {
    const token = generatePublicToken();
    row.publicTokenHash = hashPublicToken(token);
    row.publicTokenEnc = encryptSecret(token);
  }

  /** Grants must name distinct workspace members other than the owner. */
  private async checkGrants(workspaceId: string, ownerId: string, grants: ShareGrant[]): Promise<ShareGrant[]> {
    const byUser = new Map<string, ShareLevel>();
    for (const g of grants) if (g.userId !== ownerId) byUser.set(g.userId, g.level);
    if (byUser.size > MAX_GRANTS) throw new BadRequestException(`A view can be shared with at most ${MAX_GRANTS} people`);
    if (byUser.size) {
      const members = await this.ds.getRepository(MembershipEntity).findBy({ workspaceId, userId: In([...byUser.keys()]) });
      const ok = new Set(members.map((m) => m.userId));
      const bad = [...byUser.keys()].filter((u) => !ok.has(u));
      if (bad.length) throw new BadRequestException('You can only share a view with members of this workspace');
    }
    return [...byUser].map(([userId, level]) => ({ userId, level }));
  }

  private assertLayoutFits(entity: ViewEntity, layout: ViewLayout) {
    const problem = viewLayoutProblem(entity, layout);
    if (problem) throw new BadRequestException(problem);
  }

  private assertCanShare(ctx: ViewCtx) {
    if (!canDo(ctx as WorkspaceContext, 'manageSharedViews')) throw new ForbiddenException('You are not allowed to share views with the workspace');
  }
}
