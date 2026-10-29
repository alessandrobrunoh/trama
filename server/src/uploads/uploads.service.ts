import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type EntityManager, type Repository } from 'typeorm';
import { currentAccess, projectHidden } from '../auth/member-access.js';
import { currentUploadCaller } from '../auth/upload-caller.js';
import type { ActorRef } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  ArtifactEntity,
  IssueEntity,
  ProjectEntity,
  UploadEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
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
const UPLOAD_TOKEN = `'/uploads/(upl_[a-z0-9]{10,24})'`;

/** Text scans used only by `reconcileUploadReferences`, never by GET. */
const SCAN_INSERTS = [
  `INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'issue', i."id", i."projectId"
   FROM "issues" i
   CROSS JOIN LATERAL regexp_matches(coalesce(i."body", ''), ${UPLOAD_TOKEN}, 'g') AS m(match)
   WHERE i."workspaceId" = $1
   ON CONFLICT DO NOTHING`,
  `INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'project', p."id", p."id"
   FROM "projects" p
   CROSS JOIN LATERAL regexp_matches(coalesce(p."description", ''), ${UPLOAD_TOKEN}, 'g') AS m(match)
   WHERE p."workspaceId" = $1
   ON CONFLICT DO NOTHING`,
  `INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'document', d."id", NULL
   FROM "documents" d
   CROSS JOIN LATERAL regexp_matches(d."body", ${UPLOAD_TOKEN}, 'g') AS m(match)
   WHERE d."workspaceId" = $1
   ON CONFLICT DO NOTHING`,
  `INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'document_revision', r."id", NULL
   FROM "document_revisions" r
   CROSS JOIN LATERAL regexp_matches(r."body", ${UPLOAD_TOKEN}, 'g') AS m(match)
   WHERE r."workspaceId" = $1
   ON CONFLICT DO NOTHING`,
  `INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'comment', c."id", NULL
   FROM "comments" c
   CROSS JOIN LATERAL regexp_matches(c."body", ${UPLOAD_TOKEN}, 'g') AS m(match)
   WHERE c."workspaceId" = $1
   ON CONFLICT DO NOTHING`,
  `INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT a."uploadId", 'artifact', a."id", COALESCE(a."projectId", i."projectId")
   FROM "artifacts" a
   LEFT JOIN "issues" i ON i."id" = a."issueId" AND i."workspaceId" = a."workspaceId"
   WHERE a."workspaceId" = $1 AND a."uploadId" IS NOT NULL
   ON CONFLICT DO NOTHING`,
];

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

export type UploadSubjectType =
  | 'issue'
  | 'project'
  | 'document'
  | 'document_revision'
  | 'comment'
  | 'artifact';

/** A record whose text or upload column keeps a file alive. */
export interface UploadSubject {
  type: UploadSubjectType;
  id: string;
  projectId?: string | null;
}

interface StoredMention {
  uploadId: string;
  subjectType: string;
  subjectId: string;
  projectId: string | null;
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
    owner: { issueId?: string; projectId?: string },
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
    await this.linkArtifact(workspaceId, artifact.id, id, resolved.projectId);
    await this.events.record({
      workspaceId,
      actor: caller.actor,
      type: 'artifact.attached',
      subject: { type: 'artifact', id: artifact.id },
      data: {
        kind: artifact.kind,
        title: artifact.title,
        state: artifact.state,
        ...(artifact.projectId ? { projectId: artifact.projectId } : {}),
        ...(artifact.issueId ? { issueId: artifact.issueId } : {}),
      },
    });
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
    const ids = [...new Set(uploadIdsIn(text))];
    if (!ids.length) return;
    const caller = currentUploadCaller();
    const rows = await this.uploads.find({
      where: { workspaceId, id: In(ids) },
      select: { id: true, createdBy: true, referenced: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const refs = await this.referencesFor(workspaceId, ids);
    for (const id of ids) {
      const row = byId.get(id);
      const list = refs.get(id) ?? [];
      const ok =
        !!row &&
        !!caller &&
        (list.some((ref) =>
          uploadVisible(ref, currentAccess(), caller.permissions),
        ) ||
          (list.length === 0 &&
            !row.referenced &&
            sameActor(row.createdBy, caller.actor)));
      if (!ok)
        throw new BadRequestException(
          'That file is not available to attach here',
        );
    }
  }

  /**
   * After the text is saved: keep the files it still mentions and delete the ones it dropped.
   * `subject` is the record that owns this text. Without it, only the `referenced` flag moves.
   */
  async retained(
    workspaceId: string,
    before: string | null | undefined,
    after: string | null | undefined,
    subject?: UploadSubject,
  ): Promise<void> {
    const next = new Set(uploadIdsIn(after));
    if (!subject) {
      if (next.size)
        await this.uploads.update(
          { workspaceId, id: In([...next]) },
          { referenced: true },
        );
      const dropped = uploadIdsIn(before).filter((id) => !next.has(id));
      await this.releaseIds(workspaceId, dropped);
      return;
    }
    const existing = await this.subjectUploadIds(workspaceId, subject);
    await this.replaceSubject(workspaceId, subject, [...next]);
    if (next.size)
      await this.uploads.update(
        { workspaceId, id: In([...next]) },
        { referenced: true },
      );
    const dropped = existing.filter((id) => !next.has(id));
    await this.releaseIds(workspaceId, dropped);
  }

  /** Record that an artifact row is what keeps this file alive. */
  async linkArtifact(
    workspaceId: string,
    artifactId: string,
    uploadId: string,
    projectId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const query = manager?.query.bind(manager) ?? this.ds.query.bind(this.ds);
    await query(
      `INSERT INTO "upload_references"
         ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
       VALUES ($1, $2, 'artifact', $3, $4)
       ON CONFLICT ("workspaceId", "uploadId", "subjectType", "subjectId")
       DO UPDATE SET "projectId" = EXCLUDED."projectId"`,
      [workspaceId, uploadId, artifactId, projectId],
    );
    await this.uploads.update(
      { workspaceId, id: uploadId },
      { referenced: true },
    );
  }

  /** Drop mention rows for records that were just deleted, then release files nothing else names. */
  async forgetSubjects(
    workspaceId: string,
    subjects: readonly UploadSubject[],
  ): Promise<void> {
    if (!subjects.length) return;
    const removed = await this.ds.query<{ uploadId: string }[]>(
      `DELETE FROM "upload_references"
       WHERE "workspaceId" = $1
         AND ("subjectType", "subjectId") IN (
           SELECT * FROM unnest($2::varchar[], $3::varchar[])
         )
       RETURNING "uploadId"`,
      [workspaceId, subjects.map((s) => s.type), subjects.map((s) => s.id)],
    );
    await this.releaseIds(
      workspaceId,
      removed.map((row) => row.uploadId),
    );
  }

  /**
   * Ids that will have no row left after `owner` is deleted: files named in `texts` or in comments on that
   * record, and uploads whose only artifact owner is that record. Call before the delete, then `releaseIds`.
   * A document owner also loses the files named in its revisions and in its linked artifacts.
   */
  async idsLostWith(
    workspaceId: string,
    owner: {
      issueId?: string;
      projectId?: string;
      documentId?: string;
    },
    texts: readonly (string | null | undefined)[],
  ): Promise<string[]> {
    const ids = new Set<string>();
    for (const text of texts) for (const id of uploadIdsIn(text)) ids.add(id);
    const issueId = owner.issueId ?? null;
    const projectId = owner.projectId ?? null;
    const documentId = owner.documentId ?? null;
    const artifacts = await this.ds.query<
      { id: string; uploadId: string | null }[]
    >(
      documentId
        ? `SELECT "id", "uploadId" FROM "artifacts"
           WHERE "workspaceId" = $1 AND "documentId" = $2`
        : `SELECT "id", "uploadId" FROM "artifacts"
           WHERE "workspaceId" = $1
             AND "issueId" IS NOT DISTINCT FROM $2
             AND "projectId" IS NOT DISTINCT FROM $3`,
      documentId
        ? [workspaceId, documentId]
        : [workspaceId, issueId, projectId],
    );
    const subjects = [
      issueId,
      projectId,
      documentId,
      ...artifacts.map((row) => row.id),
    ].filter((id): id is string => !!id);
    for (const row of artifacts) if (row.uploadId) ids.add(row.uploadId);
    if (documentId) {
      const revisions = await this.ds.query<{ body: string }[]>(
        `SELECT "body" FROM "document_revisions" WHERE "workspaceId" = $1 AND "documentId" = $2`,
        [workspaceId, documentId],
      );
      for (const rev of revisions)
        for (const id of uploadIdsIn(rev.body)) ids.add(id);
    }
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
    const unique = [...new Set(ids)].filter((id) => isUploadId(id));
    if (!unique.length) return;
    const refs = await this.referencesFor(workspaceId, unique);
    const gone = unique.filter((id) => (refs.get(id) ?? []).length === 0);
    if (gone.length) await this.uploads.delete({ workspaceId, id: In(gone) });
  }

  /**
   * Rebuild mention rows for one workspace from the text and artifact columns the read path used to scan.
   * Not called from GET. Inserts mentions a write missed and drops rows whose text is gone, then releases
   * blobs that no longer have a mention. Staged drafts (never referenced) are left alone.
   */
  async reconcileUploadReferences(workspaceId: string): Promise<void> {
    const removed = await this.ds.transaction(async (m) => {
      await m.query(
        `CREATE TEMP TABLE "upload_reference_scan" (
           "uploadId" character varying NOT NULL,
           "subjectType" character varying NOT NULL,
           "subjectId" character varying NOT NULL,
           "projectId" character varying,
           PRIMARY KEY ("uploadId", "subjectType", "subjectId")
         ) ON COMMIT DROP`,
      );
      for (const sql of SCAN_INSERTS) await m.query(sql, [workspaceId]);
      await m.query(
        `DELETE FROM "upload_reference_scan" s
         WHERE NOT EXISTS (
           SELECT 1 FROM "uploads" u
           WHERE u."id" = s."uploadId" AND u."workspaceId" = $1
         )`,
        [workspaceId],
      );
      const dropped = await m.query<{ uploadId: string }[]>(
        `DELETE FROM "upload_references" r
         WHERE r."workspaceId" = $1
           AND NOT EXISTS (
             SELECT 1 FROM "upload_reference_scan" s
             WHERE s."uploadId" = r."uploadId"
               AND s."subjectType" = r."subjectType"
               AND s."subjectId" = r."subjectId"
           )
         RETURNING r."uploadId"`,
        [workspaceId],
      );
      await m.query(
        `INSERT INTO "upload_references"
           ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
         SELECT $1, s."uploadId", s."subjectType", s."subjectId", s."projectId"
         FROM "upload_reference_scan" s
         ON CONFLICT ("workspaceId", "uploadId", "subjectType", "subjectId")
         DO UPDATE SET "projectId" = EXCLUDED."projectId"`,
        [workspaceId],
      );
      await m.query(
        `UPDATE "uploads" u SET "referenced" = true
         WHERE u."workspaceId" = $1 AND u."referenced" = false
           AND EXISTS (
             SELECT 1 FROM "upload_references" r
             WHERE r."workspaceId" = u."workspaceId" AND r."uploadId" = u."id"
           )`,
        [workspaceId],
      );
      return dropped ?? [];
    });
    await this.releaseIds(
      workspaceId,
      removed.map((row) => row.uploadId),
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
    owner: { issueId?: string; projectId?: string },
  ) {
    const chosen = [owner.issueId, owner.projectId].filter(Boolean);
    if (chosen.length !== 1)
      throw new BadRequestException('Attach the file to one issue or project');
    if (owner.projectId) {
      const row = await this.ds.getRepository(ProjectEntity).findOne({
        where: { workspaceId, id: owner.projectId },
        select: { id: true },
      });
      if (!row || projectHidden(currentAccess(), row.id))
        throw notFound('Project', owner.projectId);
      return {
        issueId: null,
        projectId: row.id,
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
      projectId: null,
    };
  }

  /** Every current mention of this file. An empty list means the blob is unreferenced. */
  private async references(
    workspaceId: string,
    id: string,
  ): Promise<UploadRef[]> {
    const map = await this.referencesFor(workspaceId, [id]);
    return map.get(id) ?? [];
  }

  /** Live visibility for many uploads. Dead subjects are ignored, matching a scan of rows that still exist. */
  private async referencesFor(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<Map<string, UploadRef[]>> {
    const out = new Map<string, UploadRef[]>();
    if (!ids.length) return out;
    const rows = await this.ds.query<StoredMention[]>(
      `SELECT "uploadId", "subjectType", "subjectId", "projectId"
       FROM "upload_references"
       WHERE "workspaceId" = $1 AND "uploadId" = ANY($2::varchar[])`,
      [workspaceId, [...ids]],
    );
    if (!rows.length) return out;
    const idsOf = (type: string) => [
      ...new Set(
        rows
          .filter((row) => row.subjectType === type)
          .map((row) => row.subjectId),
      ),
    ];
    const [issues, projects, documents, revisions, comments, artifacts] =
      await Promise.all([
        this.projectById('issues', workspaceId, idsOf('issue')),
        this.existingIds('projects', workspaceId, idsOf('project')),
        this.existingIds('documents', workspaceId, idsOf('document')),
        this.existingIds(
          'document_revisions',
          workspaceId,
          idsOf('document_revision'),
        ),
        this.commentSubjects(workspaceId, idsOf('comment')),
        this.artifactProjects(workspaceId, idsOf('artifact')),
      ]);
    const push = (uploadId: string, ref: UploadRef) => {
      const list = out.get(uploadId) ?? [];
      list.push(ref);
      out.set(uploadId, list);
    };
    for (const row of rows) {
      if (row.subjectType === 'issue') {
        if (!issues.has(row.subjectId)) continue;
        push(row.uploadId, {
          resource: 'issues',
          projectScoped: true,
          projectId: issues.get(row.subjectId) ?? null,
        });
      } else if (row.subjectType === 'project') {
        if (!projects.has(row.subjectId)) continue;
        push(row.uploadId, {
          resource: 'projects',
          projectScoped: true,
          projectId: row.subjectId,
        });
      } else if (
        row.subjectType === 'document' ||
        row.subjectType === 'document_revision'
      ) {
        const live = row.subjectType === 'document' ? documents : revisions;
        if (!live.has(row.subjectId)) continue;
        push(row.uploadId, {
          resource: 'documents',
          projectScoped: false,
          projectId: null,
        });
      } else if (row.subjectType === 'comment') {
        const comment = comments.get(row.subjectId);
        if (!comment) continue;
        push(row.uploadId, comment);
      } else if (row.subjectType === 'artifact') {
        if (!artifacts.has(row.subjectId)) continue;
        push(row.uploadId, {
          resource: 'artifacts',
          projectScoped: true,
          projectId: artifacts.get(row.subjectId) ?? null,
        });
      }
    }
    return out;
  }

  private async subjectUploadIds(
    workspaceId: string,
    subject: UploadSubject,
  ): Promise<string[]> {
    const rows = await this.ds.query<{ uploadId: string }[]>(
      `SELECT "uploadId" FROM "upload_references"
       WHERE "workspaceId" = $1 AND "subjectType" = $2 AND "subjectId" = $3`,
      [workspaceId, subject.type, subject.id],
    );
    return rows.map((row) => row.uploadId);
  }

  private async replaceSubject(
    workspaceId: string,
    subject: UploadSubject,
    uploadIds: readonly string[],
  ): Promise<void> {
    await this.ds.query(
      `DELETE FROM "upload_references"
       WHERE "workspaceId" = $1 AND "subjectType" = $2 AND "subjectId" = $3`,
      [workspaceId, subject.type, subject.id],
    );
    if (!uploadIds.length) return;
    await this.ds.query(
      `INSERT INTO "upload_references"
         ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
       SELECT $1, u, $3, $4, $5 FROM unnest($2::varchar[]) AS u
       ON CONFLICT ("workspaceId", "uploadId", "subjectType", "subjectId")
       DO UPDATE SET "projectId" = EXCLUDED."projectId"`,
      [
        workspaceId,
        [...uploadIds],
        subject.type,
        subject.id,
        subject.projectId ?? null,
      ],
    );
  }

  private async existingIds(
    table: 'projects' | 'documents' | 'document_revisions',
    workspaceId: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.ds.query<{ id: string }[]>(
      `SELECT "id" FROM "${table}" WHERE "workspaceId" = $1 AND "id" = ANY($2::varchar[])`,
      [workspaceId, [...ids]],
    );
    return new Set(rows.map((row) => row.id));
  }

  private async projectById(
    table: 'issues' | 'milestones',
    workspaceId: string,
    ids: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await this.ds.query<
      { id: string; projectId: string | null }[]
    >(
      `SELECT "id", "projectId" FROM "${table}" WHERE "workspaceId" = $1 AND "id" = ANY($2::varchar[])`,
      [workspaceId, [...ids]],
    );
    return new Map(rows.map((row) => [row.id, row.projectId]));
  }

  private async artifactProjects(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await this.ds.query<
      { id: string; projectId: string | null }[]
    >(
      `SELECT a."id", COALESCE(a."projectId", i."projectId") AS "projectId"
       FROM "artifacts" a
       LEFT JOIN "issues" i ON i."id" = a."issueId" AND i."workspaceId" = a."workspaceId"
       WHERE a."workspaceId" = $1 AND a."id" = ANY($2::varchar[])`,
      [workspaceId, [...ids]],
    );
    return new Map(rows.map((row) => [row.id, row.projectId]));
  }

  private async commentSubjects(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<Map<string, UploadRef>> {
    if (!ids.length) return new Map();
    const comments = await this.ds.query<
      { id: string; type: string; subjectId: string }[]
    >(
      `SELECT "id", "subject"->>'type' AS "type", "subject"->>'id' AS "subjectId"
       FROM "comments" WHERE "workspaceId" = $1 AND "id" = ANY($2::varchar[])`,
      [workspaceId, [...ids]],
    );
    const wanted = (type: string) =>
      comments.filter((row) => row.type === type).map((row) => row.subjectId);
    const [issues, milestones] = await Promise.all([
      this.projectById('issues', workspaceId, wanted('issue')),
      this.projectById('milestones', workspaceId, wanted('milestone')),
    ]);
    const out = new Map<string, UploadRef>();
    for (const comment of comments) {
      if (comment.type === 'issue')
        out.set(comment.id, {
          resource: 'comments',
          projectScoped: true,
          projectId: issues.get(comment.subjectId) ?? null,
        });
      else if (comment.type === 'milestone')
        out.set(comment.id, {
          resource: 'comments',
          projectScoped: true,
          projectId: milestones.get(comment.subjectId) ?? null,
        });
      else if (comment.type === 'project')
        out.set(comment.id, {
          resource: 'comments',
          projectScoped: true,
          projectId: comment.subjectId,
        });
      else
        out.set(comment.id, {
          resource: 'comments',
          projectScoped: false,
          projectId: null,
        });
    }
    return out;
  }
}
