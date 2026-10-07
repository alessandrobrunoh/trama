import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { hasRole, type WorkspaceContext } from '../auth/request-context.js';
import type { SavedView, ViewEntity, ViewFilter, ViewLayout } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import { SavedViewEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

export interface ViewInput {
  name?: string;
  entity?: ViewEntity;
  filters?: ViewFilter[];
  sort?: SavedView['sort'] | null;
  groupBy?: string | null;
  layout?: ViewLayout;
  shared?: boolean;
}

@Injectable()
export class ViewsService {
  constructor(
    private readonly events: EventsService,
    @InjectRepository(SavedViewEntity) private readonly repo: Repository<SavedViewEntity>,
  ) {}

  /** Shared views of the workspace plus the caller's own private views. */
  async list(workspaceId: string, userId: string | undefined) {
    return this.repo
      .createQueryBuilder('v')
      .where('v.workspaceId = :workspaceId AND (v.shared = true OR v.ownerId = :userId)', { workspaceId, userId: userId ?? '' })
      .orderBy('v.createdAt', 'ASC')
      .getMany();
  }

  async get(ctx: WorkspaceContext, id: string) {
    const row = await this.repo.findOneBy({ id, workspaceId: ctx.workspace.id });
    if (!row || (!row.shared && row.ownerId !== ctx.userId)) throw notFound('View', id);
    return row;
  }

  async create(ctx: WorkspaceContext, input: ViewInput & { name: string; entity: ViewEntity }) {
    if (!ctx.userId) throw new ForbiddenException('Agents cannot own saved views');
    const row = await this.repo.save(
      this.repo.create({
        id: uid('vw'),
        workspaceId: ctx.workspace.id,
        ownerId: ctx.userId,
        name: input.name.trim(),
        entity: input.entity,
        filters: input.filters ?? [],
        sort: input.sort ?? null,
        groupBy: input.groupBy ?? null,
        layout: input.layout ?? 'list',
        shared: input.shared ?? false,
      }),
    );
    this.events.publish(ctx.workspace.id, { type: 'created', entity: 'view', id: row.id });
    return row;
  }

  private assertCanEdit(ctx: WorkspaceContext, row: SavedViewEntity) {
    if (row.ownerId !== ctx.userId && !(row.shared && hasRole(ctx.role, 'admin')))
      throw new ForbiddenException('Only the owner (or an admin, for shared views) can change a view');
  }

  async update(ctx: WorkspaceContext, id: string, patch: ViewInput) {
    const row = await this.get(ctx, id);
    this.assertCanEdit(ctx, row);
    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.entity !== undefined) row.entity = patch.entity;
    if (patch.filters !== undefined) row.filters = patch.filters;
    if (patch.sort !== undefined) row.sort = patch.sort;
    if (patch.groupBy !== undefined) row.groupBy = patch.groupBy;
    if (patch.layout !== undefined) row.layout = patch.layout;
    if (patch.shared !== undefined) row.shared = patch.shared;
    row.updatedAt = new Date();
    await this.repo.save(row);
    this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'view', id });
    return row;
  }

  async remove(ctx: WorkspaceContext, id: string) {
    const row = await this.get(ctx, id);
    this.assertCanEdit(ctx, row);
    await this.repo.delete({ id });
    this.events.publish(ctx.workspace.id, { type: 'deleted', entity: 'view', id });
  }
}
