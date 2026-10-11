import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { currentAccess, projectHidden } from '../auth/member-access.js';
import { currentUploadCaller } from '../auth/upload-caller.js';
import type { ActorRef } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  ArtifactEntity,
  IssueEntity,
  ProjectEntity,
  UploadEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import {
  canAttachArtifact,
  canStageUpload,
  inspectUpload,
  isUploadId,
  markdownFor,
  sameActor,
  uploadIdsIn,
  uploadPath,
  uploadVisible,
  type UploadCaller,
  type UploadRef,
} from './upload-rules.js';

const ISSUE_KEY = /^[A-Za-z]+-\d+$/;
const WORKSTREAM_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export interface IncomingUpload {
  buffer: Buffer;
  size: number;
  originalname: string;
  mimetype?: string;
}

export interface StagedUpload {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  kind: 'image' | 'file';
  url: string;
  markdown: string;
}

/**
 * Files live in Postgres, next to documents, because a document is versioned markdown with a
 * full-text index and cannot hold a blob. Bytes are returned only when a live reference on a
 * record the caller can read still points at them.
 */
@Injectable()
export class UploadsService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(UploadEntity)
    private readonly uploads: Repository<UploadEntity>,
    @InjectRepository(ArtifactEntity)
    private readonly artifacts: Repository<ArtifactEntity>,
  ) {}

  async stage(
    workspaceId: string,
    slug: string,
    caller: UploadCaller,
    file: IncomingUpload,
  ): Promise<StagedUpload> {
    if (!canStageUpload(caller, currentAccess()))
      throw new ForbiddenException('You cannot upload files here');
    const row = await this.insert(workspaceId, caller.actor, file, false);
    const url = uploadPath(slug, row.id);
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      byteSize: row.byteSize,
      kind: row.contentType.startsWith('image/') ? 'image' : 'file',
      url,
      markdown: markdownFor(
        row.contentType.startsWith('image/') ? 'image' : 'file',
        row.filename,
        url,
      ),
    };
  }

  /** Store the file and attach it as an `image` or `file` artifact. The URL field stays available for links. */
  async attachArtifact(
    workspaceId: string,
    slug: string,
    caller: UploadCaller,
    file: IncomingUpload,
    owner: { issueId?: string; workstreamId?: string; projectId?: string },
  ): Promise<ArtifactEntity> {
    if (!canAttachArtifact(caller, currentAccess()))
      throw new ForbiddenException('You cannot attach files here');
    const resolved = await this.resolveOwner(workspaceId, owner);
    const accepted = this.accept(file);
    const id = uid('upl');
    const url = uploadPath(slug, id);
    const artifact = await this.ds.transaction(async (m) => {
      await m.save(
        m.create(UploadEntity, {
          id,
          workspaceId,
          filename: accepted.filename,
          contentType: accepted.contentType,
          byteSize: accepted.byteSize,
          bytes: file.buffer,
          referenced: true,
          createdBy: caller.actor,
        }),
      );
      return m.save(
        m.create(ArtifactEntity, {
          id: uid('ar'),
          workspaceId,
          workstreamId: resolved.workstreamId,
          projectId: resolved.projectId,
          issueId: resolved.issueId,
          repositoryId: null,
          description: null,
          kind: accepted.kind,
          provider: 'other',
          title: accepted.filename,
          documentId: null,
          url,
          uploadId: id,
          externalId: null,
          state: 'published',
          ci: null,
          review: null,
          hasConflicts: null,
          environment: null,
          authorRef: caller.actor,
        }),
      );
    });
    await this.events.record({
      workspaceId,
      actor: caller.actor,
      type: 'artifact.attached',
      subject: { type: 'artifact', id: artifact.id },
      workstreamId: artifact.workstreamId ?? undefined,
      data: {
        kind: artifact.kind,
        title: artifact.title,
        state: artifact.state,
        ...(artifact.workstreamId
          ? { workstreamId: artifact.workstreamId }
          : {}),
        ...(artifact.projectId ? { projectId: artifact.projectId } : {}),
        ...(artifact.issueId ? { issueId: artifact.issueId } : {}),
      },
    });
    if (resolved.touch)
      await this.bus.touch(workspaceId, resolved.touch, 'artifact.attached');
    return artifact;
  }

  /**
   * The bytes, or 404. A staged file (not yet saved onto a record) is readable only by its uploader.
   * Once it was referenced and the reference is gone, the row is deleted so it cannot be fetched again.
   */
  async open(
    workspaceId: string,
    id: string,
    caller: UploadCaller,
  ): Promise<UploadEntity> {
    if (!isUploadId(id)) throw notFound('File', id);
    const row = await this.uploads.findOneBy({ workspaceId, id });
    if (!row) throw notFound('File', id);
    const refs = await this.references(workspaceId, id);
    if (
      refs.some((ref) =>
        uploadVisible(ref, currentAccess(), caller.permissions),
      )
    )
      return row;
    const staged =
      refs.length === 0 &&
      !row.referenced &&
      sameActor(row.createdBy, caller.actor);
    if (staged) return row;
    if (refs.length === 0 && row.referenced)
      await this.uploads.delete({ workspaceId, id });
    throw notFound('File', id);
  }

  /** Drop a file that was uploaded and then never saved onto a record. Referenced files stay. */
  async discard(
    workspaceId: string,
    caller: UploadCaller,
    id: string,
  ): Promise<void> {
    if (!isUploadId(id)) throw notFound('File', id);
    const row = await this.uploads.findOne({
      where: { workspaceId, id },
      select: { id: true, createdBy: true, referenced: true },
    });
    if (!row || !sameActor(row.createdBy, caller.actor))
      throw notFound('File', id);
    const refs = await this.references(workspaceId, id);
    if (refs.length || row.referenced)
      throw new BadRequestException(
        'Remove the attachment from the record instead',
      );
    await this.uploads.delete({ workspaceId, id });
  }

  /** Refuse a description or comment that points at a file the caller cannot read. Call before saving. */
  async assertAttachable(
    workspaceId: string,
    text: string | null | undefined,
  ): Promise<void> {
    const caller = currentUploadCaller();
    for (const id of uploadIdsIn(text)) {
      if (!(await this.readable(workspaceId, caller, id))) {
        throw new BadRequestException(
          'That file is not available to attach here',
        );
      }
    }
  }

  /** After the text is saved: keep the files it still mentions and delete the ones it dropped. */
  async retained(
    workspaceId: string,
    before: string | null | undefined,
    after: string | null | undefined,
  ): Promise<void> {
    const next = new Set(uploadIdsIn(after));
    for (const id of next)
      await this.uploads.update({ workspaceId, id }, { referenced: true });
    const dropped = uploadIdsIn(before).filter((id) => !next.has(id));
    await this.releaseIds(workspaceId, dropped);
  }

  /**
   * Ids that will have no row left after `owner` is deleted: files named in `texts` or in comments on that
   * record, and uploads whose only artifact owner is that record. Call before the delete, then `releaseIds`.
   */
  async idsLostWith(
    workspaceId: string,
    owner: { issueId?: string; workstreamId?: string; projectId?: string },
    texts: readonly (string | null | undefined)[],
  ): Promise<string[]> {
    const ids = new Set<string>();
    for (const text of texts) for (const id of uploadIdsIn(text)) ids.add(id);
    const issueId = owner.issueId ?? null;
    const workstreamId = owner.workstreamId ?? null;
    const projectId = owner.projectId ?? null;
    const artifacts = await this.ds.query<
      { id: string; uploadId: string | null }[]
    >(
      `SELECT "id", "uploadId" FROM "artifacts"
       WHERE "workspaceId" = $1
         AND "issueId" IS NOT DISTINCT FROM $2
         AND "workstreamId" IS NOT DISTINCT FROM $3
         AND "projectId" IS NOT DISTINCT FROM $4`,
      [workspaceId, issueId, workstreamId, projectId],
    );
    const subjects = [
      issueId,
      workstreamId,
      projectId,
      ...artifacts.map((row) => row.id),
    ].filter((id): id is string => !!id);
    for (const row of artifacts) if (row.uploadId) ids.add(row.uploadId);
    if (subjects.length) {
      const comments = await this.ds.query<{ body: string }[]>(
        `SELECT "body" FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`,
        [workspaceId, subjects],
      );
      for (const comment of comments)
        for (const id of uploadIdsIn(comment.body)) ids.add(id);
    }
    return [...ids];
  }

  async releaseIds(workspaceId: string, ids: readonly string[]): Promise<void> {
    for (const id of new Set(ids)) {
      if (!isUploadId(id)) continue;
      if ((await this.references(workspaceId, id)).length === 0)
        await this.uploads.delete({ workspaceId, id });
    }
  }

  private async readable(
    workspaceId: string,
    caller: UploadCaller | null,
    id: string,
  ): Promise<boolean> {
    if (!caller || !isUploadId(id)) return false;
    const row = await this.uploads.findOne({
      where: { workspaceId, id },
      select: { id: true, createdBy: true, referenced: true },
    });
    if (!row) return false;
    const refs = await this.references(workspaceId, id);
    if (
      refs.some((ref) =>
        uploadVisible(ref, currentAccess(), caller.permissions),
      )
    )
      return true;
    return (
      refs.length === 0 &&
      !row.referenced &&
      sameActor(row.createdBy, caller.actor)
    );
  }

  private accept(file: IncomingUpload) {
    const inspected = inspectUpload({
      originalName: file.originalname,
      bytes: file.buffer,
    });
    if (!inspected.ok) throw new BadRequestException(inspected.reason);
    return inspected.file;
  }

  private async insert(
    workspaceId: string,
    actor: ActorRef,
    file: IncomingUpload,
    referenced: boolean,
  ): Promise<UploadEntity> {
    const accepted = this.accept(file);
    return this.uploads.save(
      this.uploads.create({
        id: uid('upl'),
        workspaceId,
        filename: accepted.filename,
        contentType: accepted.contentType,
        byteSize: accepted.byteSize,
        bytes: file.buffer,
        referenced,
        createdBy: actor,
      }),
    );
  }

  private async resolveOwner(
    workspaceId: string,
    owner: { issueId?: string; workstreamId?: string; projectId?: string },
  ) {
    const chosen = [owner.issueId, owner.workstreamId, owner.projectId].filter(
      Boolean,
    );
    if (chosen.length !== 1)
      throw new BadRequestException(
        'Attach the file to one issue, workstream or project',
      );
    if (owner.projectId) {
      const row = await this.ds.getRepository(ProjectEntity).findOne({
        where: { workspaceId, id: owner.projectId },
        select: { id: true },
      });
      if (!row || projectHidden(currentAccess(), row.id))
        throw notFound('Project', owner.projectId);
      return {
        issueId: null,
        workstreamId: null,
        projectId: row.id,
        touch: null as string | null,
      };
    }
    if (owner.workstreamId) {
      const repo = this.ds.getRepository(WorkstreamEntity);
      const row = WORKSTREAM_KEY.test(owner.workstreamId)
        ? await repo.findOne({
            where: { workspaceId, key: owner.workstreamId.toUpperCase() },
            select: { id: true, projectId: true },
          })
        : await repo.findOne({
            where: { workspaceId, id: owner.workstreamId },
            select: { id: true, projectId: true },
          });
      if (!row || projectHidden(currentAccess(), row.projectId))
        throw notFound('Workstream', owner.workstreamId);
      return {
        issueId: null,
        workstreamId: row.id,
        projectId: null,
        touch: row.id,
      };
    }
    const issueId = owner.issueId!;
    const repo = this.ds.getRepository(IssueEntity);
    let row: IssueEntity | null = null;
    if (ISSUE_KEY.test(issueId)) {
      const key = issueId.toUpperCase();
      row =
        (await repo.findOne({
          where: { workspaceId, key },
          select: { id: true, projectId: true },
        })) ??
        (await repo
          .createQueryBuilder('i')
          .select(['i.id', 'i.projectId'])
          .where('i.workspaceId = :workspaceId', { workspaceId })
          .andWhere('i.aliases @> :alias::jsonb', {
            alias: JSON.stringify([key]),
          })
          .getOne());
    } else {
      row = await repo.findOne({
        where: { workspaceId, id: issueId },
        select: { id: true, projectId: true },
      });
    }
    if (!row || projectHidden(currentAccess(), row.projectId))
      throw notFound('Issue', issueId);
    return {
      issueId: row.id,
      workstreamId: null,
      projectId: null,
      touch: null as string | null,
    };
  }

  /** Every current mention of this file in the workspace. An empty list means the blob is unreferenced. */
  private async references(
    workspaceId: string,
    id: string,
  ): Promise<UploadRef[]> {
    const token = `/uploads/${id}`;
    const out: UploadRef[] = [];
    const artifacts = await this.ds.query<{ projectId: string | null }[]>(
      `SELECT COALESCE(a."projectId", i."projectId", w."projectId") AS "projectId"
       FROM "artifacts" a
       LEFT JOIN "issues" i ON i."id" = a."issueId" AND i."workspaceId" = a."workspaceId"
       LEFT JOIN "workstreams" w ON w."id" = a."workstreamId" AND w."workspaceId" = a."workspaceId"
       WHERE a."workspaceId" = $1 AND a."uploadId" = $2`,
      [workspaceId, id],
    );
    for (const row of artifacts)
      out.push({
        resource: 'artifacts',
        projectScoped: true,
        projectId: row.projectId,
      });

    const issues = await this.ds.query<{ projectId: string | null }[]>(
      `SELECT "projectId" FROM "issues" WHERE "workspaceId" = $1 AND strpos(coalesce("body", ''), $2) > 0`,
      [workspaceId, token],
    );
    for (const row of issues)
      out.push({
        resource: 'issues',
        projectScoped: true,
        projectId: row.projectId,
      });

    const streams = await this.ds.query<{ projectId: string | null }[]>(
      `SELECT "projectId" FROM "workstreams"
       WHERE "workspaceId" = $1 AND (
         strpos(coalesce("description", ''), $2) > 0 OR
         strpos(coalesce("objective", ''), $2) > 0 OR
         strpos(coalesce("context", ''), $2) > 0
       )`,
      [workspaceId, token],
    );
    for (const row of streams)
      out.push({
        resource: 'workstreams',
        projectScoped: true,
        projectId: row.projectId,
      });

    const projects = await this.ds.query<{ id: string }[]>(
      `SELECT "id" FROM "projects" WHERE "workspaceId" = $1 AND strpos(coalesce("description", ''), $2) > 0`,
      [workspaceId, token],
    );
    for (const row of projects)
      out.push({
        resource: 'projects',
        projectScoped: true,
        projectId: row.id,
      });

    const comments = await this.ds.query<{ type: string; id: string }[]>(
      `SELECT "subject"->>'type' AS "type", "subject"->>'id' AS "id"
       FROM "comments" WHERE "workspaceId" = $1 AND strpos("body", $2) > 0`,
      [workspaceId, token],
    );
    if (comments.length) await this.pushCommentRefs(workspaceId, comments, out);
    return out;
  }

  private async pushCommentRefs(
    workspaceId: string,
    comments: { type: string; id: string }[],
    out: UploadRef[],
  ) {
    const ids = (type: string) =>
      comments.filter((c) => c.type === type).map((c) => c.id);
    const tables = {
      issues: 'issues',
      workstreams: 'workstreams',
      milestones: 'milestones',
    } as const;
    const projectOf = async (table: keyof typeof tables, wanted: string[]) => {
      if (!wanted.length) return new Map<string, string | null>();
      const rows = await this.ds.query<
        { id: string; projectId: string | null }[]
      >(
        `SELECT "id", "projectId" FROM "${tables[table]}" WHERE "workspaceId" = $1 AND "id" = ANY($2)`,
        [workspaceId, wanted],
      );
      return new Map(rows.map((row) => [row.id, row.projectId]));
    };
    const issues = await projectOf('issues', ids('issue'));
    const streams = await projectOf('workstreams', ids('workstream'));
    const milestones = await projectOf('milestones', ids('milestone'));
    for (const comment of comments) {
      if (comment.type === 'issue')
        out.push({
          resource: 'comments',
          projectScoped: true,
          projectId: issues.get(comment.id) ?? null,
        });
      else if (comment.type === 'workstream')
        out.push({
          resource: 'comments',
          projectScoped: true,
          projectId: streams.get(comment.id) ?? null,
        });
      else if (comment.type === 'milestone')
        out.push({
          resource: 'comments',
          projectScoped: true,
          projectId: milestones.get(comment.id) ?? null,
        });
      else if (comment.type === 'project')
        out.push({
          resource: 'comments',
          projectScoped: true,
          projectId: comment.id,
        });
      else
        out.push({
          resource: 'comments',
          projectScoped: false,
          projectId: null,
        });
    }
  }
}
