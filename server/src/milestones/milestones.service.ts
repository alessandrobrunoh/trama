import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { notFound, toDate, uid } from '../common/util.js';
import { MilestoneEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

export interface MilestoneInput {
  workstreamId?: string;
  name?: string;
  description?: string | null;
  targetDate?: string | null;
  sortOrder?: number;
}

@Injectable()
export class MilestonesService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    @InjectRepository(MilestoneEntity) private readonly repo: Repository<MilestoneEntity>,
  ) {}

  list(workspaceId: string, f: { workstreamId?: string } = {}) {
    const qb = this.repo
      .createQueryBuilder('m')
      .where('m.workspaceId = :workspaceId', { workspaceId })
      .orderBy('m.workstreamId', 'ASC')
      .addOrderBy('m.sortOrder', 'ASC')
      .addOrderBy('m.createdAt', 'ASC');
    if (f.workstreamId) qb.andWhere('m.workstreamId = :w', { w: f.workstreamId });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Milestone', id);
    return row;
  }

  async create(workspaceId: string, actor: ActorRef, input: MilestoneInput & { workstreamId: string; name: string }) {
    if (!(await this.ds.getRepository(WorkstreamEntity).existsBy({ id: input.workstreamId, workspaceId })))
      throw new BadRequestException(`Unknown workstream "${input.workstreamId}"`);
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const { max } = (await this.repo
        .createQueryBuilder('m')
        .select('MAX(m.sortOrder)', 'max')
        .where('m.workspaceId = :workspaceId AND m.workstreamId = :w', { workspaceId, w: input.workstreamId })
        .getRawOne<{ max: number | null }>()) ?? { max: null };
      sortOrder = max === null || max === undefined ? 0 : Number(max) + 1;
    }
    const row = await this.repo.save(
      this.repo.create({
        id: uid('ms'),
        workspaceId,
        workstreamId: input.workstreamId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        targetDate: (toDate(input.targetDate) as Date | null | undefined) ?? null,
        sortOrder,
      }),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'milestone.created',
      subject: { type: 'milestone', id: row.id },
      workstreamId: row.workstreamId,
      data: { name: row.name },
    });
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: Omit<MilestoneInput, 'workstreamId'>) {
    const row = await this.get(workspaceId, id);
    const fields: string[] = [];
    const set = <K extends keyof MilestoneEntity>(k: K, v: MilestoneEntity[K]) => {
      if (JSON.stringify(row[k]) !== JSON.stringify(v)) {
        row[k] = v;
        fields.push(k);
      }
    };
    if (patch.name !== undefined) set('name', patch.name.trim());
    if (patch.description !== undefined) set('description', patch.description?.trim() || null);
    if (patch.targetDate !== undefined) set('targetDate', (toDate(patch.targetDate) as Date | null) ?? null);
    if (patch.sortOrder !== undefined) set('sortOrder', patch.sortOrder);
    if (!fields.length) return row;
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'milestone.updated',
      subject: { type: 'milestone', id },
      workstreamId: row.workstreamId,
      data: { name: row.name, fields },
    });
    return row;
  }

  /** Assigns sortOrder 0..n-1 following `ids` (all milestones of the workstream, in the new order). */
  async reorder(workspaceId: string, actor: ActorRef, workstreamId: string, ids: string[]) {
    const rows = await this.repo.findBy({ workspaceId, workstreamId });
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id)))
      throw new BadRequestException('ids must be distinct milestones of the workstream');
    // Milestones not listed keep their relative order after the listed ones.
    const rest = rows.filter((r) => !ids.includes(r.id)).sort((a, b) => a.sortOrder - b.sortOrder);
    const ordered = [...ids.map((id) => byId.get(id)!), ...rest];
    const changed: MilestoneEntity[] = [];
    ordered.forEach((r, i) => {
      if (r.sortOrder !== i) {
        r.sortOrder = i;
        r.updatedAt = new Date();
        changed.push(r);
      }
    });
    if (changed.length) await this.repo.save(changed);
    for (const r of changed)
      await this.events.record({
        workspaceId,
        actor,
        type: 'milestone.updated',
        subject: { type: 'milestone', id: r.id },
        workstreamId,
        data: { name: r.name, fields: ['sortOrder'] },
      });
    return this.list(workspaceId, { workstreamId });
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    const affected = await this.ds.query<{ id: string }[]>(
      `SELECT "id" FROM "issues" WHERE "workspaceId" = $1 AND "milestoneIds" ? $2::text`,
      [workspaceId, id],
    );
    await this.ds.query(
      `UPDATE "issues" SET "milestoneIds" = "milestoneIds" - $2::text WHERE "workspaceId" = $1 AND "milestoneIds" ? $2::text`,
      [workspaceId, id],
    );
    await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, id]);
    await this.repo.delete({ id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'milestone.deleted',
      subject: { type: 'milestone', id },
      workstreamId: row.workstreamId,
      data: { name: row.name },
    });
    // issues that were in the milestone changed too: let other tabs refetch them
    for (const r of affected.slice(0, 200)) this.events.publish(workspaceId, { type: 'updated', entity: 'issue', id: r.id });
  }
}
