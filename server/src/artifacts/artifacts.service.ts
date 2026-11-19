import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
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
import { currentAccess, projectHidden } from '../auth/member-access.js';
import { ArtifactEntity, IssueEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { isWorkspaceUploadUrl } from '../uploads/upload-rules.js';
import { UploadsService } from '../uploads/uploads.service.js';

/** `undefined` leaves a field alone; `null` clears it (an artifact must keep a task owner). */
export interface ArtifactInput {
  issueId?: string | null;
  repository?: string | null;
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
  issueId?: string;
  repository?: string;
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
export function artifactOwners(row: Pick<ArtifactEntity, 'issueId'>) {
  return row.issueId ? { issueId: row.issueId } : {};
}

@Injectable()
export class ArtifactsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    @InjectRepository(ArtifactEntity)
    private readonly repo: Repository<ArtifactEntity>,
    @Optional()
    @Inject(UploadsService)
    private readonly uploads?: UploadsService,
  ) {}

  list(workspaceId: string, f: ArtifactFilter = {}) {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.workspaceId = :workspaceId', { workspaceId })
      .orderBy('a.createdAt', 'DESC');
    if (f.issueId) qb.andWhere('a.issueId = :i', { i: f.issueId });
    if (f.repository)
      qb.andWhere('a.repository = :r', { r: f.repository });
    if (f.kind) qb.andWhere('a.kind = :k', { k: f.kind });
    if (f.state) qb.andWhere('a.state = :s', { s: f.state });
    const access = currentAccess();
    if (access && !access.projects.all) {
      const ids = access.projects.projectIds;
      const scope = ids.length
        ? `(EXISTS (SELECT 1 FROM issues i WHERE i.id = a."issueId" AND (i."projectId" IN (:...memberProjectIds)${access.includeUnassigned ? ' OR i."projectId" IS NULL' : ''}))${access.includeUnassigned ? ' OR a."issueId" IS NULL' : ''})`
        : access.includeUnassigned
          ? '(a."issueId" IS NULL OR EXISTS (SELECT 1 FROM issues i WHERE i.id = a."issueId" AND i."projectId" IS NULL))'
          : '1 = 0';
      qb.andWhere(scope, ids.length ? { memberProjectIds: ids } : undefined);
    }
    return qb.getMany();
  }

  /** Counts the artifacts of an issue the caller can already see, without loading artifact rows. */
  countForIssue(workspaceId: string, issueId: string): Promise<number> {
    return this.repo
      .createQueryBuilder('a')
      .where('a.workspaceId = :workspaceId', { workspaceId })
      .andWhere('a.issueId = :issueId', { issueId })
      .getCount();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row || (await this.isHidden(row))) throw notFound('Artifact', id);
    return row;
  }

  private async isHidden(row: ArtifactEntity): Promise<boolean> {
    if (row.issueId) {
      const issue = await this.ds.getRepository(IssueEntity).findOne({
        where: { id: row.issueId, workspaceId: row.workspaceId },
        select: { projectId: true },
      });
      return projectHidden(currentAccess(), issue?.projectId);
    }
    return projectHidden(currentAccess(), null);
  }

  /** Resolves an issue by id, project key (`CORA-12`) or alias; 404 when unknown. */
  async resolveIssueId(workspaceId: string, idOrKey: string): Promise<string> {
    const repo = this.ds.getRepository(IssueEntity);
    let row: IssueEntity | null = null;
    if (ISSUE_KEY_RE.test(idOrKey)) {
      const key = idOrKey.toUpperCase();
      row =
        (await repo.findOne({
          where: { workspaceId, key },
          select: { id: true },
        })) ??
        (await repo
          .createQueryBuilder('i')
          .select('i.id')
          .where('i.workspaceId = :workspaceId', { workspaceId })
          .andWhere('i.aliases @> :a::jsonb', { a: JSON.stringify([key]) })
          .getOne());
    } else {
      row = await repo.findOne({
        where: { workspaceId, id: idOrKey },
        select: { id: true },
      });
    }
    if (!row) throw notFound('Issue', idOrKey);
    return row.id;
  }

  /** The referenced task must exist in the workspace and be visible to the caller. */
  private async validateOwners(
    workspaceId: string,
    o: { issueId?: string | null },
  ) {
    if (o.issueId) {
      const issue = await this.ds.getRepository(IssueEntity).findOne({
        where: { id: o.issueId, workspaceId },
        select: { id: true, projectId: true },
      });
      if (!issue) throw new BadRequestException(`Unknown issue "${o.issueId}"`);
      if (projectHidden(currentAccess(), issue.projectId))
        throw new BadRequestException(`Unknown issue "${o.issueId}"`);
    }
  }

  private async validate(workspaceId: string, input: ArtifactInput) {
    await this.validateOwners(workspaceId, input);
  }

  /**
   * Client urls are http(s). A workspace upload path is allowed only when this artifact already owns that
   * file (`uploadId`); callers cannot point an artifact at someone else's upload by setting `url`.
   */
  private assertLinkUrl(
    kind: ArtifactKind,
    url: string | null | undefined,
    uploadId?: string | null,
  ) {
    if (kind === 'link' && !url)
      throw new BadRequestException(
        'A link artifact needs a valid http(s) url',
      );
    if (!url || isHttpUrl(url)) return;
    if (
      uploadId &&
      isWorkspaceUploadUrl(url) &&
      url.endsWith(`/uploads/${uploadId}`)
    )
      return;
    throw new BadRequestException(
      'An artifact url must be a valid http(s) url',
    );
  }

  async create(
    workspaceId: string,
    actor: ActorRef,
    input: ArtifactInput & { kind: ArtifactKind },
  ) {
    if (!input.issueId)
      throw new BadRequestException('An artifact needs a task: issueId');
    this.assertLinkUrl(input.kind, input.url);
    await this.validate(workspaceId, input);
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('An artifact needs a title');
    const isPr =
      input.kind === 'pull_request' || input.kind === 'merge_request';
    const row = await this.repo.save(
      this.repo.create({
        id: uid('ar'),
        workspaceId,
        issueId: input.issueId,
        repository: input.repository ?? null,
        description: input.description?.trim() || null,
        kind: input.kind,
        provider:
          input.provider ??
          (input.kind === 'merge_request'
            ? 'gitlab'
            : input.kind === 'pull_request'
              ? 'github'
              : 'other'),
        title,
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
      data: {
        kind: row.kind,
        title: row.title,
        externalId: row.externalId,
        state: row.state,
        ...artifactOwners(row),
      },
    });
    if (row.review === 'requested') await this.reviewRequested(row, actor);
    return row;
  }

  private reviewRequested(row: ArtifactEntity, actor: ActorRef) {
    return this.events.record(
      {
        workspaceId: row.workspaceId,
        actor,
        type: 'review.requested',
        subject: { type: 'artifact', id: row.id },
        data: {
          title: row.title,
          externalId: row.externalId,
          ...artifactOwners(row),
        },
      },
      false,
    );
  }

  async update(
    workspaceId: string,
    actor: ActorRef,
    id: string,
    patch: ArtifactInput,
  ) {
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
    if (patch.description !== undefined)
      set('description', patch.description?.trim() || null);
    for (const k of [
      'issueId',
      'repository',
      'provider',
      'url',
      'externalId',
      'state',
      'ci',
      'review',
      'hasConflicts',
      'environment',
    ] as const)
      set(k, patch[k]);
    let released: string | null = null;
    if (row.uploadId && !row.url?.includes(`/uploads/${row.uploadId}`)) {
      released = row.uploadId;
      row.uploadId = null;
      fields.push('uploadId');
    }
    if (!fields.length) return row;
    if (!row.issueId)
      throw new BadRequestException('An artifact needs a task: issueId');
    this.assertLinkUrl(row.kind, row.url, row.uploadId);
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'artifact.updated',
      subject: { type: 'artifact', id },
      data: {
        title: row.title,
        externalId: row.externalId,
        ...artifactOwners(row),
        changes,
      },
    });
    if (released) {
      await this.uploads?.forgetSubjects(workspaceId, [
        { type: 'artifact', id },
      ]);
      await this.uploads?.releaseIds(workspaceId, [released]);
    }
    if (changes.review && row.review === 'requested')
      await this.reviewRequested(row, actor);
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    const uploadId = row.uploadId;
    await this.ds.query(
      `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`,
      [workspaceId, id],
    );
    await this.repo.delete({ id });
    if (uploadId) {
      await this.uploads?.forgetSubjects(workspaceId, [
        { type: 'artifact', id },
      ]);
      await this.uploads?.releaseIds(workspaceId, [uploadId]);
    }
    await this.events.record({
      workspaceId,
      actor,
      type: 'artifact.deleted',
      subject: { type: 'artifact', id },
      data: { title: row.title, ...artifactOwners(row) },
    });
  }
}
