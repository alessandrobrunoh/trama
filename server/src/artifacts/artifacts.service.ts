import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
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
import { applyProjectScope, currentAccess, projectHidden } from '../auth/member-access.js';
import { ArtifactEntity, DocumentEntity, IssueEntity, ProjectEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

/** `null` detaches an owner (PATCH); `undefined` leaves it alone. */
export interface ArtifactInput {
  workstreamId?: string | null;
  projectId?: string | null;
  issueId?: string | null;
  repositoryId?: string | null;
  /** Create only: points the artifact at a Trama document (kind `document`); the title and provider follow it. */
  documentId?: string | null;
  description?: string | null;
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

export interface ArtifactFilter {
  workstreamId?: string;
  projectId?: string;
  issueId?: string;
  repositoryId?: string;
  kind?: ArtifactKind;
  state?: ArtifactState;
}

/** Initial state when none is given. */
const DEFAULT_STATE: Record<ArtifactKind, ArtifactState> = {
  pull_request: 'open',
  merge_request: 'open',
  document: 'published',
  link: 'published',
  design: 'published',
  image: 'published',
  file: 'published',
  build: 'pending',
  test_report: 'succeeded',
  deployment: 'pending',
  release: 'published',
};

const ISSUE_KEY_RE = /^[A-Za-z]+-\d+$/;

/** A `link` artifact must point to a http(s) URL. */
export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The owner ids of an artifact row (only the ones that are set). */
export function artifactOwners(row: Pick<ArtifactEntity, 'workstreamId' | 'projectId' | 'issueId'>) {
  return {
    ...(row.workstreamId ? { workstreamId: row.workstreamId } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.issueId ? { issueId: row.issueId } : {}),
  };
}

@Injectable()
export class ArtifactsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(ArtifactEntity) private readonly repo: Repository<ArtifactEntity>,
  ) {}

  list(workspaceId: string, f: ArtifactFilter = {}) {
    const qb = this.repo.createQueryBuilder('a').where('a.workspaceId = :workspaceId', { workspaceId }).orderBy('a.createdAt', 'DESC');
    if (f.workstreamId) qb.andWhere('a.workstreamId = :w', { w: f.workstreamId });
    if (f.projectId) qb.andWhere('a.projectId = :p', { p: f.projectId });
    if (f.issueId) qb.andWhere('a.issueId = :i', { i: f.issueId });
    if (f.repositoryId) qb.andWhere('a.repositoryId = :r', { r: f.repositoryId });
    if (f.kind) qb.andWhere('a.kind = :k', { k: f.kind });
    if (f.state) qb.andWhere('a.state = :s', { s: f.state });
    applyProjectScope(qb, 'a', 'projectId');
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row || projectHidden(currentAccess(), row.projectId)) throw notFound('Artifact', id);
    return row;
  }

  /** Resolves a workstream by id or key; 404 when unknown. */
  async resolveWorkstreamId(workspaceId: string, idOrKey: string): Promise<string> {
    const repo = this.ds.getRepository(WorkstreamEntity);
    const row = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(idOrKey)
      ? await repo.findOne({ where: { workspaceId, key: idOrKey.toUpperCase() }, select: { id: true } })
      : await repo.findOne({ where: { workspaceId, id: idOrKey }, select: { id: true } });
    if (!row) throw notFound('Workstream', idOrKey);
    return row.id;
  }

  /** 404 when the project does not exist in the workspace. */
  async assertProject(workspaceId: string, projectId: string): Promise<void> {
    if (!(await this.ds.getRepository(ProjectEntity).existsBy({ id: projectId, workspaceId })))
      throw notFound('Project', projectId);
  }

  /** Resolves an issue by id, key (`BUG-12`) or alias; 404 when unknown. */
  async resolveIssueId(workspaceId: string, idOrKey: string): Promise<string> {
    const repo = this.ds.getRepository(IssueEntity);
    let row: IssueEntity | null = null;
    if (ISSUE_KEY_RE.test(idOrKey)) {
      const key = idOrKey.toUpperCase();
      row =
        (await repo.findOne({ where: { workspaceId, key }, select: { id: true } })) ??
        (await repo
          .createQueryBuilder('i')
          .select('i.id')
          .where('i.workspaceId = :workspaceId', { workspaceId })
          .andWhere('i.aliases @> :a::jsonb', { a: JSON.stringify([key]) })
          .getOne());
    } else {
      row = await repo.findOne({ where: { workspaceId, id: idOrKey }, select: { id: true } });
    }
    if (!row) throw notFound('Issue', idOrKey);
    return row.id;
  }

  /** Every referenced owner must exist in the workspace. */
  private async validateOwners(workspaceId: string, o: { workstreamId?: string | null; projectId?: string | null; issueId?: string | null }) {
    if (o.workstreamId) await this.refs.workstreams(workspaceId, [o.workstreamId]);
    if (o.projectId && !(await this.ds.getRepository(ProjectEntity).existsBy({ id: o.projectId, workspaceId })))
      throw new BadRequestException(`Unknown project "${o.projectId}"`);
    if (o.issueId && !(await this.ds.getRepository(IssueEntity).existsBy({ id: o.issueId, workspaceId })))
      throw new BadRequestException(`Unknown issue "${o.issueId}"`);
  }

  private async validate(workspaceId: string, input: ArtifactInput) {
    if (input.repositoryId) await this.refs.repositories(workspaceId, [input.repositoryId]);
    await this.validateOwners(workspaceId, input);
  }

  /** Every artifact url is http(s) (never `javascript:`, `data:`…); a `link` must have one. */
  private assertLinkUrl(kind: ArtifactKind, url: string | null | undefined) {
    if (kind === 'link' && !url) throw new BadRequestException('A link artifact needs a valid http(s) url');
    if (url && !isHttpUrl(url)) throw new BadRequestException('An artifact url must be a valid http(s) url');
  }

  /** The document a `document` artifact points to: it must exist in the workspace and not already be attached to the same owner. */
  private async resolveDocument(workspaceId: string, input: ArtifactInput & { kind: ArtifactKind }) {
    if (!input.documentId) return null;
    if (input.kind !== 'document') throw new BadRequestException('documentId needs kind "document"');
    const doc = await this.ds.getRepository(DocumentEntity).findOne({ where: { workspaceId, id: input.documentId }, select: { id: true, title: true } });
    if (!doc) throw new BadRequestException(`Unknown document "${input.documentId}"`);
    for (const owner of ['workstreamId', 'projectId', 'issueId'] as const) {
      if (input[owner] && (await this.repo.existsBy({ workspaceId, documentId: doc.id, [owner]: input[owner] })))
        throw new ConflictException('This document is already attached there');
    }
    return doc;
  }

  async create(workspaceId: string, actor: ActorRef, input: ArtifactInput & { kind: ArtifactKind }) {
    if (!input.workstreamId && !input.projectId && !input.issueId)
      throw new BadRequestException('An artifact needs at least one owner: workstreamId, projectId or issueId');
    this.assertLinkUrl(input.kind, input.url);
    await this.validate(workspaceId, input);
    const doc = await this.resolveDocument(workspaceId, input);
    const title = doc?.title ?? input.title?.trim();
    if (!title) throw new BadRequestException('An artifact needs a title');
    const isPr = input.kind === 'pull_request' || input.kind === 'merge_request';
    const row = await this.repo.save(
      this.repo.create({
        id: uid('ar'),
        workspaceId,
        workstreamId: input.workstreamId ?? null,
        projectId: input.projectId ?? null,
        issueId: input.issueId ?? null,
        repositoryId: input.repositoryId ?? null,
        description: input.description?.trim() || null,
        kind: input.kind,
        provider: doc ? 'docs' : (input.provider ?? (input.kind === 'merge_request' ? 'gitlab' : input.kind === 'pull_request' ? 'github' : 'other')),
        title,
        documentId: doc?.id ?? null,
        url: doc ? null : (input.url ?? null),
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
      workstreamId: row.workstreamId ?? undefined,
      data: { kind: row.kind, title: row.title, externalId: row.externalId, state: row.state, ...artifactOwners(row) },
    });
    if (row.review === 'requested') await this.reviewRequested(row, actor);
    if (row.workstreamId) await this.bus.touch(workspaceId, row.workstreamId, 'artifact.attached');
    return row;
  }

  private reviewRequested(row: ArtifactEntity, actor: ActorRef) {
    return this.events.record(
      {
        workspaceId: row.workspaceId,
        actor,
        type: 'review.requested',
        subject: { type: 'artifact', id: row.id },
        workstreamId: row.workstreamId ?? undefined,
        data: { title: row.title, externalId: row.externalId, ...artifactOwners(row) },
      },
      false,
    );
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: ArtifactInput) {
    const row = await this.get(workspaceId, id);
    const before = artifactOwners(row);
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
    if (patch.title !== undefined) {
      if (row.documentId) throw new BadRequestException('The title of a document artifact follows the document; rename the document instead');
      set('title', patch.title.trim());
    }
    if (patch.description !== undefined) set('description', patch.description?.trim() || null);
    for (const k of ['workstreamId', 'projectId', 'issueId', 'repositoryId', 'provider', 'url', 'externalId', 'state', 'ci', 'review', 'hasConflicts', 'environment'] as const)
      set(k, patch[k]);
    if (!fields.length) return row;
    if (!row.workstreamId && !row.projectId && !row.issueId)
      throw new BadRequestException('An artifact needs at least one owner: workstreamId, projectId or issueId');
    this.assertLinkUrl(row.kind, row.url);
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'artifact.updated',
      subject: { type: 'artifact', id },
      workstreamId: row.workstreamId ?? undefined,
      data: { title: row.title, externalId: row.externalId, ...artifactOwners(row), changes },
    });
    if (changes.review && row.review === 'requested') await this.reviewRequested(row, actor);
    // Both the workstream it left and the one it joined care about the change.
    const touched = new Set([before.workstreamId, row.workstreamId].filter((w): w is string => !!w));
    for (const w of touched) await this.bus.touch(workspaceId, w, 'artifact.updated');
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
      workstreamId: row.workstreamId ?? undefined,
      data: { title: row.title, ...artifactOwners(row) },
    });
    if (row.workstreamId) await this.bus.touch(workspaceId, row.workstreamId, 'artifact.deleted');
  }
}
