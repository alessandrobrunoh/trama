import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type {
  ActorRef,
  ArtifactKind,
  ArtifactProvider,
  ArtifactState,
  CiState,
  ReviewState,
} from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { ArtifactEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

export interface ArtifactInput {
  workstreamId?: string;
  repositoryId?: string | null;
  kind?: ArtifactKind;
  provider?: ArtifactProvider;
  title?: string;
  url?: string | null;
  externalId?: string | null;
  state?: ArtifactState;
  ci?: CiState | null;
  review?: ReviewState | null;
  hasConflicts?: boolean | null;
  environment?: string | null;
}

/** Initial state when none is given. */
const DEFAULT_STATE: Record<ArtifactKind, ArtifactState> = {
  pull_request: 'open',
  merge_request: 'open',
  commit: 'merged',
  branch: 'open',
  document: 'published',
  design: 'published',
  image: 'published',
  file: 'published',
  build: 'pending',
  test_report: 'succeeded',
  deployment: 'pending',
  release: 'published',
};

@Injectable()
export class ArtifactsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(ArtifactEntity) private readonly repo: Repository<ArtifactEntity>,
  ) {}

  list(workspaceId: string, f: { workstreamId?: string; repositoryId?: string; kind?: ArtifactKind; state?: ArtifactState } = {}) {
    const qb = this.repo.createQueryBuilder('a').where('a.workspaceId = :workspaceId', { workspaceId }).orderBy('a.createdAt', 'DESC');
    if (f.workstreamId) qb.andWhere('a.workstreamId = :w', { w: f.workstreamId });
    if (f.repositoryId) qb.andWhere('a.repositoryId = :r', { r: f.repositoryId });
    if (f.kind) qb.andWhere('a.kind = :k', { k: f.kind });
    if (f.state) qb.andWhere('a.state = :s', { s: f.state });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Artifact', id);
    return row;
  }

  private async validate(workspaceId: string, input: ArtifactInput) {
    if (input.repositoryId) await this.refs.repositories(workspaceId, [input.repositoryId]);
  }

  async create(workspaceId: string, actor: ActorRef, input: ArtifactInput & { workstreamId: string; kind: ArtifactKind; title: string }) {
    if (!(await this.ds.getRepository(WorkstreamEntity).existsBy({ id: input.workstreamId, workspaceId })))
      throw new BadRequestException(`Unknown workstream "${input.workstreamId}"`);
    await this.validate(workspaceId, input);
    const isPr = input.kind === 'pull_request' || input.kind === 'merge_request';
    const row = await this.repo.save(
      this.repo.create({
        id: uid('ar'),
        workspaceId,
        workstreamId: input.workstreamId,
        repositoryId: input.repositoryId ?? null,
        kind: input.kind,
        provider: input.provider ?? (input.kind === 'merge_request' ? 'gitlab' : input.kind === 'pull_request' ? 'github' : 'other'),
        title: input.title.trim(),
        url: input.url ?? null,
        externalId: input.externalId ?? null,
        state: input.state ?? DEFAULT_STATE[input.kind],
        ci: input.ci ?? (isPr ? 'pending' : null),
        review: input.review ?? (isPr ? 'none' : null),
        hasConflicts: input.hasConflicts ?? (isPr ? false : null),
        environment: input.environment ?? null,
        authorRef: actor,
      }),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'artifact.attached',
      subject: { type: 'artifact', id: row.id },
      workstreamId: row.workstreamId,
      data: { kind: row.kind, title: row.title, externalId: row.externalId, state: row.state },
    });
    if (row.review === 'requested') await this.reviewRequested(row, actor);
    await this.bus.touch(workspaceId, row.workstreamId, 'artifact.attached');
    return row;
  }

  private reviewRequested(row: ArtifactEntity, actor: ActorRef) {
    return this.events.record(
      {
        workspaceId: row.workspaceId,
        actor,
        type: 'review.requested',
        subject: { type: 'artifact', id: row.id },
        workstreamId: row.workstreamId,
        data: { title: row.title, externalId: row.externalId },
      },
      false,
    );
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: ArtifactInput) {
    const row = await this.get(workspaceId, id);
    await this.validate(workspaceId, patch);
    const fields: string[] = [];
    const changes: Record<string, [unknown, unknown]> = {};
    const set = (k: keyof ArtifactEntity, v: unknown) => {
      if (v !== undefined && JSON.stringify(row[k]) !== JSON.stringify(v)) {
        changes[k] = [row[k], v];
        (row as unknown as Record<string, unknown>)[k] = v;
        fields.push(k);
      }
    };
    if (patch.title !== undefined) set('title', patch.title.trim());
    for (const k of ['repositoryId', 'provider', 'url', 'externalId', 'state', 'ci', 'review', 'hasConflicts', 'environment'] as const)
      set(k, patch[k]);
    if (!fields.length) return row;
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'artifact.updated',
      subject: { type: 'artifact', id },
      workstreamId: row.workstreamId,
      data: { title: row.title, externalId: row.externalId, changes },
    });
    if (changes.review && row.review === 'requested') await this.reviewRequested(row, actor);
    await this.bus.touch(workspaceId, row.workstreamId, 'artifact.updated');
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, id]);
    await this.repo.delete({ id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'artifact.deleted',
      subject: { type: 'artifact', id },
      workstreamId: row.workstreamId,
      data: { title: row.title },
    });
    await this.bus.touch(workspaceId, row.workstreamId, 'artifact.deleted');
  }
}
