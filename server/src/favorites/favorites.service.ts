import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In, type EntityManager, type EntityTarget } from 'typeorm';
import { uid } from '../common/util.js';
import { FAVORITE_TYPES, MAX_FAVORITES, type FavoriteType } from '../contracts/domain.js';
import {
  DecisionEntity,
  FavoriteEntity,
  IssueEntity,
  ProjectEntity,
  RepositoryEntity,
  SavedViewEntity,
  TeamEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

const TABLES: Record<FavoriteType, EntityTarget<{ id: string; workspaceId: string }>> = {
  issue: IssueEntity,
  workstream: WorkstreamEntity,
  project: ProjectEntity,
  decision: DecisionEntity,
  team: TeamEntity,
  repository: RepositoryEntity,
  view: SavedViewEntity,
};

@Injectable()
export class FavoritesService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
  ) {}

  /**
   * The caller's favorites, oldest first. Favorites whose subject was deleted (or, for views, is
   * no longer visible to the caller) are removed here instead of being left dangling.
   */
  async list(workspaceId: string, userId: string): Promise<FavoriteEntity[]> {
    const repo = this.ds.getRepository(FavoriteEntity);
    const all = await repo.find({ where: { workspaceId, userId }, order: { createdAt: 'ASC', id: 'ASC' } });
    const gone: string[] = [];
    for (const type of FAVORITE_TYPES) {
      const mine = all.filter((f) => f.type === type);
      if (!mine.length) continue;
      const alive = await this.visibleIds(this.ds.manager, workspaceId, userId, type, mine.map((f) => f.subjectId));
      gone.push(...mine.filter((f) => !alive.has(f.subjectId)).map((f) => f.id));
    }
    if (gone.length) await repo.delete({ id: In(gone) });
    return all.filter((f) => !gone.includes(f.id));
  }

  /** Pin a subject. Pinning something already pinned returns the existing favorite. */
  async add(workspaceId: string, userId: string, type: FavoriteType, subjectId: string): Promise<FavoriteEntity> {
    if (!FAVORITE_TYPES.includes(type)) throw new BadRequestException(`type must be one of ${FAVORITE_TYPES.join(', ')}`);
    const repo = this.ds.getRepository(FavoriteEntity);
    const existing = await repo.findOneBy({ workspaceId, userId, type, subjectId });
    if (existing) return existing;
    const alive = await this.visibleIds(this.ds.manager, workspaceId, userId, type, [subjectId]);
    if (!alive.has(subjectId)) throw new NotFoundException(`${type} "${subjectId}" not found`);
    if ((await repo.countBy({ workspaceId, userId })) >= MAX_FAVORITES)
      throw new ConflictException(`You can keep up to ${MAX_FAVORITES} favorites per workspace`);
    const row = repo.create({ id: uid('fav'), workspaceId, userId, type, subjectId });
    // A concurrent request may have inserted the same favorite; the unique index decides.
    await repo.createQueryBuilder().insert().values(row).orIgnore().execute();
    const saved = await repo.findOneByOrFail({ workspaceId, userId, type, subjectId });
    if (saved.id === row.id) this.events.publish(workspaceId, { type: 'created', entity: 'favorite', id: saved.id });
    return saved;
  }

  /** Unpin. Idempotent: unpinning something that is not pinned succeeds. */
  async remove(workspaceId: string, userId: string, type: FavoriteType, subjectId: string): Promise<void> {
    const repo = this.ds.getRepository(FavoriteEntity);
    const existing = await repo.findOneBy({ workspaceId, userId, type, subjectId });
    if (!existing) return;
    await repo.delete({ id: existing.id });
    this.events.publish(workspaceId, { type: 'deleted', entity: 'favorite', id: existing.id });
  }

  /** Of `ids`, the ones that exist in the workspace and that this user may see. */
  private async visibleIds(
    m: EntityManager,
    workspaceId: string,
    userId: string,
    type: FavoriteType,
    ids: string[],
  ): Promise<Set<string>> {
    if (type === 'view') {
      const rows = await m.find(SavedViewEntity, { where: { workspaceId, id: In(ids) } });
      return new Set(rows.filter((v) => v.shared || v.ownerId === userId).map((v) => v.id));
    }
    const rows = await m.find(TABLES[type], { where: { workspaceId, id: In(ids) }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }
}
