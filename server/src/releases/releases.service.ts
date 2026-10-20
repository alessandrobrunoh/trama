import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import {
  resolveStatusEntry,
  statusTypeOf,
  type ActorRef,
  type IssueStatus,
  type ReleasePipelineType,
  type ReleaseStatus,
} from '../contracts/domain.js';
import { notFound, toDate, uid } from '../common/util.js';
import {
  IssueEntity,
  ReleaseEntity,
  ReleasePipelineEntity,
  TeamEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { IssuesService } from '../issues/issues.service.js';
import {
  loadStatusCatalog,
  requireStatus,
} from '../status/status-catalog.js';

const PIPELINE_TYPES: readonly ReleasePipelineType[] = [
  'continuous',
  'scheduled',
];
const RELEASE_STATUSES: readonly ReleaseStatus[] = [
  'draft',
  'released',
  'canceled',
];
const OPEN_ISSUE_TYPES: readonly IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
];

export interface PipelineInput {
  name?: string;
  type?: ReleasePipelineType;
  teamId?: string | null;
  moveOpenIssuesToNext?: boolean;
}

export interface ReleaseInput {
  pipelineId?: string;
  name?: string;
  notes?: string | null;
  targetAt?: string | null;
  status?: ReleaseStatus;
}

export interface CompleteReleaseInput {
  moveOpenIssuesToDone?: boolean;
  /** Catalog id or legacy enum; required when the workspace catalog has no done status. */
  targetStatusId?: string;
  moveOpenIssuesToNext?: boolean;
}

/** Bump a trailing patch when the name looks like `v1.4.0`; otherwise append ` next`. */
export function nextDraftReleaseName(name: string): string {
  const trimmed = name.trim();
  const m = /^(v?)(\d+)\.(\d+)\.(\d+)$/i.exec(trimmed);
  if (m) return `${m[1]}${m[2]}.${m[3]}.${Number(m[4]) + 1}`;
  return `${trimmed} next`;
}

@Injectable()
export class ReleasesService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    private readonly issues: IssuesService,
    @InjectRepository(ReleasePipelineEntity)
    private readonly pipelines: Repository<ReleasePipelineEntity>,
    @InjectRepository(ReleaseEntity)
    private readonly releases: Repository<ReleaseEntity>,
  ) {}

  listPipelines(workspaceId: string) {
    return this.pipelines.find({
      where: { workspaceId },
      order: { createdAt: 'ASC' },
    });
  }

  async getPipeline(workspaceId: string, id: string) {
    const row = await this.pipelines.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Release pipeline', id);
    return row;
  }

  async createPipeline(
    workspaceId: string,
    actor: ActorRef,
    input: PipelineInput & { name: string },
  ) {
    const type = input.type ?? 'continuous';
    this.assertPipelineType(type);
    const teamId = await this.assertTeam(workspaceId, input.teamId);
    const row = await this.pipelines.save(
      this.pipelines.create({
        id: uid('rpl'),
        workspaceId,
        name: input.name.trim(),
        type,
        teamId,
        moveOpenIssuesToNext: input.moveOpenIssuesToNext === true,
      }),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'release_pipeline.created',
      subject: { type: 'release_pipeline', id: row.id },
      data: { name: row.name, type: row.type },
    });
    return row;
  }

  async updatePipeline(
    workspaceId: string,
    actor: ActorRef,
    id: string,
    patch: PipelineInput,
  ) {
    const row = await this.getPipeline(workspaceId, id);
    const fields: string[] = [];
    const set = <K extends keyof ReleasePipelineEntity>(
      k: K,
      v: ReleasePipelineEntity[K],
    ) => {
      if (JSON.stringify(row[k]) !== JSON.stringify(v)) {
        row[k] = v;
        fields.push(k);
      }
    };
    if (patch.name !== undefined) set('name', patch.name.trim());
    if (patch.type !== undefined) {
      this.assertPipelineType(patch.type);
      set('type', patch.type);
    }
    if (patch.teamId !== undefined)
      set('teamId', await this.assertTeam(workspaceId, patch.teamId));
    if (patch.moveOpenIssuesToNext !== undefined)
      set('moveOpenIssuesToNext', patch.moveOpenIssuesToNext);
    if (!fields.length) return row;
    row.updatedAt = new Date();
    await this.pipelines.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'release_pipeline.updated',
      subject: { type: 'release_pipeline', id },
      data: { name: row.name, fields },
    });
    return row;
  }

  async removePipeline(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.getPipeline(workspaceId, id);
    const blocking =
      (await this.releases.countBy({
        workspaceId,
        pipelineId: id,
        status: 'draft',
      })) +
      (await this.releases.countBy({
        workspaceId,
        pipelineId: id,
        status: 'released',
      }));
    if (blocking)
      throw new BadRequestException(
        'Delete or cancel every non-canceled release before deleting this pipeline',
      );
    await this.releases.delete({ workspaceId, pipelineId: id });
    await this.pipelines.delete({ id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'release_pipeline.deleted',
      subject: { type: 'release_pipeline', id },
      data: { name: row.name },
    });
  }

  async listReleases(workspaceId: string, f: { pipelineId?: string } = {}) {
    const rows = await this.releases.find({
      where: {
        workspaceId,
        ...(f.pipelineId ? { pipelineId: f.pipelineId } : {}),
      },
      order: { createdAt: 'DESC' },
    });
    return this.withCounts(workspaceId, rows);
  }

  async getRelease(workspaceId: string, id: string) {
    const row = await this.releases.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Release', id);
    const [withCount] = await this.withCounts(workspaceId, [row]);
    return withCount;
  }

  async createRelease(
    workspaceId: string,
    actor: ActorRef,
    input: ReleaseInput & { pipelineId: string; name: string },
  ) {
    await this.getPipeline(workspaceId, input.pipelineId);
    const row = await this.releases.save(
      this.releases.create({
        id: uid('rel'),
        workspaceId,
        pipelineId: input.pipelineId,
        name: input.name.trim(),
        status: 'draft',
        notes: input.notes?.trim() || null,
        targetAt: (toDate(input.targetAt) as Date | null | undefined) ?? null,
      }),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'release.created',
      subject: { type: 'release', id: row.id },
      data: { name: row.name, pipelineId: row.pipelineId },
    });
    return this.getRelease(workspaceId, row.id);
  }

  async updateRelease(
    workspaceId: string,
    actor: ActorRef,
    id: string,
    patch: Omit<ReleaseInput, 'pipelineId'>,
  ) {
    const row = await this.releases.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Release', id);
    if (patch.status === 'released')
      throw new BadRequestException('Use POST .../releases/:id/complete to mark a release as released');
    const fields: string[] = [];
    const set = <K extends keyof ReleaseEntity>(k: K, v: ReleaseEntity[K]) => {
      if (JSON.stringify(row[k]) !== JSON.stringify(v)) {
        row[k] = v;
        fields.push(k);
      }
    };
    if (patch.name !== undefined) set('name', patch.name.trim());
    if (patch.notes !== undefined) set('notes', patch.notes?.trim() || null);
    if (patch.targetAt !== undefined)
      set('targetAt', (toDate(patch.targetAt) as Date | null) ?? null);
    if (patch.status !== undefined) {
      this.assertReleaseStatus(patch.status);
      set('status', patch.status);
    }
    if (!fields.length) return this.getRelease(workspaceId, id);
    row.updatedAt = new Date();
    await this.releases.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'release.updated',
      subject: { type: 'release', id },
      data: { name: row.name, fields },
    });
    return this.getRelease(workspaceId, id);
  }

  async removeRelease(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.getRelease(workspaceId, id);
    await this.ds.getRepository(IssueEntity).update(
      { workspaceId, releaseId: id },
      { releaseId: null, updatedAt: new Date() },
    );
    await this.releases.delete({ id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'release.deleted',
      subject: { type: 'release', id },
      data: { name: row.name, pipelineId: row.pipelineId },
    });
  }

  async complete(
    workspaceId: string,
    actor: ActorRef,
    id: string,
    input: CompleteReleaseInput = {},
  ) {
    const row = await this.releases.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Release', id);
    if (row.status === 'canceled')
      throw new BadRequestException('A canceled release cannot be completed');
    if (row.status === 'released')
      throw new ConflictException('This release is already completed');
    const pipeline = await this.getPipeline(workspaceId, row.pipelineId);
    const catalog = (await loadStatusCatalog(this.ds, workspaceId)).issue;
    const assigned = await this.ds
      .getRepository(IssueEntity)
      .findBy({ workspaceId, releaseId: id });
    const open = assigned.filter((issue) => {
      const type = statusTypeOf(catalog, issue.status);
      return type !== undefined && OPEN_ISSUE_TYPES.includes(type);
    });

    const moveToDone = input.moveOpenIssuesToDone === true;
    const moveToNext =
      input.moveOpenIssuesToNext === true ||
      (pipeline.type === 'scheduled' && pipeline.moveOpenIssuesToNext);

    if (moveToDone && open.length) {
      const done = input.targetStatusId
        ? requireStatus(catalog, input.targetStatusId, 'status')
        : resolveStatusEntry(catalog, 'done');
      if (!done)
        throw new BadRequestException(
          'No done status in the workspace catalog; pass targetStatusId',
        );
      await this.issues.updateMany(workspaceId, actor, open, {
        status: done.id,
      });
    }

    const leftover = moveToDone
      ? []
      : open;
    if (moveToNext && leftover.length) {
      const next = await this.nextDraft(workspaceId, actor, pipeline.id, row);
      await this.ds.getRepository(IssueEntity).update(
        { id: In(leftover.map((issue) => issue.id)) },
        { releaseId: next.id, updatedAt: new Date() },
      );
      for (const issue of leftover)
        await this.events.record({
          workspaceId,
          actor,
          type: 'issue.updated',
          subject: { type: 'issue', id: issue.id },
          data: { key: issue.key, fields: ['releaseId'] },
        });
    }

    row.status = 'released';
    row.releasedAt = new Date();
    row.updatedAt = row.releasedAt;
    await this.releases.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'release.completed',
      subject: { type: 'release', id: row.id },
      data: {
        name: row.name,
        pipelineId: row.pipelineId,
        movedToDone: moveToDone,
        movedToNext: moveToNext && leftover.length > 0,
      },
    });
    return this.getRelease(workspaceId, row.id);
  }

  private async nextDraft(
    workspaceId: string,
    actor: ActorRef,
    pipelineId: string,
    completed: ReleaseEntity,
  ) {
    const drafts = await this.releases.find({
      where: { workspaceId, pipelineId, status: 'draft' },
      order: { createdAt: 'ASC' },
    });
    const existing = drafts.find((row) => row.id !== completed.id);
    if (existing) return existing;
    return this.createRelease(workspaceId, actor, {
      pipelineId,
      name: nextDraftReleaseName(completed.name),
    });
  }

  private async withCounts(workspaceId: string, rows: ReleaseEntity[]) {
    if (!rows.length) return rows;
    const counts = (await this.ds.query(
      `SELECT "releaseId" AS id, count(*)::int AS n
       FROM "issues" WHERE "workspaceId" = $1 AND "releaseId" = ANY($2::varchar[])
       GROUP BY 1`,
      [workspaceId, rows.map((row) => row.id)],
    )) as { id: string; n: number }[];
    const byId = new Map(counts.map((row) => [row.id, Number(row.n)]));
    for (const row of rows) row.issueCount = byId.get(row.id) ?? 0;
    return rows;
  }

  private assertPipelineType(type: ReleasePipelineType) {
    if (!PIPELINE_TYPES.includes(type))
      throw new BadRequestException(`Unknown pipeline type "${type}"`);
  }

  private assertReleaseStatus(status: ReleaseStatus) {
    if (!RELEASE_STATUSES.includes(status) || status === 'released')
      throw new BadRequestException(`Cannot set release status to "${status}"`);
  }

  private async assertTeam(
    workspaceId: string,
    teamId: string | null | undefined,
  ): Promise<string | null> {
    if (!teamId) return null;
    if (
      !(await this.ds
        .getRepository(TeamEntity)
        .existsBy({ id: teamId, workspaceId }))
    )
      throw new BadRequestException(`Unknown team "${teamId}"`);
    return teamId;
  }
}
