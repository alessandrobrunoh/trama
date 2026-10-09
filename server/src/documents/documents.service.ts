import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import { hasRole, type WorkspaceContext } from '../auth/request-context.js';
import {
  DOCUMENT_LIMITS,
  type ActorRef,
  type DocumentConflict,
  type DocumentLink,
} from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  ArtifactEntity,
  DocumentEntity,
  DocumentRevisionEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import {
  MARK_END,
  MARK_START,
  buildTsQuery,
  cleanTitle,
  excerptOf,
  isEmoji,
  mergesIntoHead,
  sameActor,
  snippetToHtml,
} from './document-rules.js';

export interface DocumentOwners {
  projectId?: string;
  /** Workstream id or key. */
  workstreamId?: string;
  /** Issue id or key. */
  issueId?: string;
}

export interface CreateDocumentInput extends DocumentOwners {
  title: string;
  body?: string;
  icon?: string | null;
}

export interface UpdateDocumentInput {
  /** The `version` the edit is based on. A stale one is refused with 409. */
  baseVersion: number;
  title?: string;
  body?: string;
  icon?: string | null;
}

export interface ListDocumentsFilter extends DocumentOwners {
  q?: string;
  /** `true` = only documents attached somewhere, `false` = only loose ones. */
  attached?: boolean;
  /** Default `false` (live documents only); `only` = just the archived ones; `all` = both. */
  archived?: 'false' | 'only' | 'all';
  /** Actor id of the author. */
  authorId?: string;
  sort?: 'updated' | 'created' | 'title';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 200;

type RawRow = { head: string | null; snippet?: string | null };

@Injectable()
export class DocumentsService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    private readonly artifacts: ArtifactsService,
    @InjectRepository(DocumentEntity)
    private readonly repo: Repository<DocumentEntity>,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  private async load(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Document', id);
    return row;
  }

  /** The attachments of these documents, grouped by document id. */
  private async linksOf(
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, DocumentLink[]>> {
    const out = new Map<string, DocumentLink[]>();
    if (!ids.length) return out;
    const rows = await this.ds
      .getRepository(ArtifactEntity)
      .find({
        where: { workspaceId, documentId: In(ids) },
        order: { createdAt: 'ASC' },
      });
    for (const a of rows) {
      const list = out.get(a.documentId!) ?? [];
      list.push({
        artifactId: a.id,
        ...(a.projectId ? { projectId: a.projectId } : {}),
        ...(a.workstreamId ? { workstreamId: a.workstreamId } : {}),
        ...(a.issueId ? { issueId: a.issueId } : {}),
      });
      out.set(a.documentId!, list);
    }
    return out;
  }

  /** One document with its body and attachments. */
  async get(workspaceId: string, id: string) {
    const row = await this.load(workspaceId, id);
    return this.withLinks(workspaceId, row);
  }

  private async withLinks(workspaceId: string, row: DocumentEntity) {
    const links = (await this.linksOf(workspaceId, [row.id])).get(row.id) ?? [];
    return Object.assign(row, { links });
  }

  /** Resolves the owner filters/inputs (id or key) to ids; 404 when one does not exist. */
  private async resolveOwners(workspaceId: string, o: DocumentOwners) {
    const out: { projectId?: string; workstreamId?: string; issueId?: string } =
      {};
    if (o.projectId) {
      await this.artifacts.assertProject(workspaceId, o.projectId);
      out.projectId = o.projectId;
    }
    if (o.workstreamId)
      out.workstreamId = await this.artifacts.resolveWorkstreamId(
        workspaceId,
        o.workstreamId,
      );
    if (o.issueId)
      out.issueId = await this.artifacts.resolveIssueId(workspaceId, o.issueId);
    return out;
  }

  /**
   * Documents of the workspace without their body. With `q`, full-text matches (every word as a prefix) ranked
   * by relevance, each with the passage that matched. Filters by attachment, author and archive state.
   */
  async list(workspaceId: string, f: ListDocumentsFilter = {}) {
    const tsQuery = f.q?.trim() ? buildTsQuery(f.q) : null;
    if (f.q?.trim() && !tsQuery) return [];
    const owners = await this.resolveOwners(workspaceId, f);
    const qb = this.repo
      .createQueryBuilder('d')
      .select([
        'd.id',
        'd.workspaceId',
        'd.title',
        'd.icon',
        'd.version',
        'd.author',
        'd.lastEditor',
        'd.archivedAt',
        'd.createdAt',
        'd.updatedAt',
      ])
      .addSelect('left(d.body, 600)', 'head')
      .where('d.workspaceId = :workspaceId', { workspaceId });
    if (f.archived === 'only') qb.andWhere('d.archivedAt IS NOT NULL');
    else if (f.archived !== 'all') qb.andWhere('d.archivedAt IS NULL');
    if (f.authorId)
      qb.andWhere(`d.author->>'id' = :authorId`, { authorId: f.authorId });
    const linked = (column: string, param: string, value: string) =>
      qb.andWhere(
        `EXISTS (SELECT 1 FROM artifacts a WHERE a."documentId" = d.id AND a."${column}" = :${param})`,
        { [param]: value },
      );
    if (owners.projectId) linked('projectId', 'ownerProject', owners.projectId);
    if (owners.workstreamId)
      linked('workstreamId', 'ownerWorkstream', owners.workstreamId);
    if (owners.issueId) linked('issueId', 'ownerIssue', owners.issueId);
    if (f.attached !== undefined)
      qb.andWhere(
        `${f.attached ? '' : 'NOT '}EXISTS (SELECT 1 FROM artifacts a WHERE a."documentId" = d.id)`,
      );
    if (tsQuery) {
      qb.andWhere(`d."searchVector" @@ to_tsquery('simple', :tsq)`, {
        tsq: tsQuery,
      });
      qb.addSelect(
        `ts_headline('simple', left(d.body, 20000), to_tsquery('simple', :tsq), :opts)`,
        'snippet',
      ).setParameter(
        'opts',
        `StartSel=${MARK_START}, StopSel=${MARK_END}, MaxFragments=1, MinWords=8, MaxWords=26, ShortWord=2`,
      );
    }
    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    if (tsQuery && !f.sort)
      qb.orderBy(
        `ts_rank_cd(d."searchVector", to_tsquery('simple', :tsq))`,
        'DESC',
      ).addOrderBy('d.updatedAt', 'DESC');
    else if (f.sort === 'title')
      qb.orderBy('lower(d.title)', f.order === 'desc' ? 'DESC' : 'ASC');
    else qb.orderBy(f.sort === 'created' ? 'd.createdAt' : 'd.updatedAt', dir);
    qb.addOrderBy('d.id', 'ASC')
      .limit(Math.min(f.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT))
      .offset(f.offset ?? 0);
    const { entities, raw } = await qb.getRawAndEntities<RawRow>();
    const links = await this.linksOf(
      workspaceId,
      entities.map((e) => e.id),
    );
    return entities.map((e, i) => {
      const snippet = snippetToHtml(raw[i]?.snippet);
      return {
        ...e.toJSON(),
        excerpt: excerptOf(raw[i]?.head),
        ...(snippet ? { snippet } : {}),
        links: links.get(e.id) ?? [],
      };
    });
  }

  // ───────────────────────────── writes ─────────────────────────────

  private assertBody(body: string | undefined) {
    if (body !== undefined && body.length > DOCUMENT_LIMITS.bodyMax)
      throw new BadRequestException(
        `A document is limited to ${DOCUMENT_LIMITS.bodyMax} characters`,
      );
  }

  /** `null` clears the icon; anything else must be one emoji. */
  private cleanIcon(icon: string | null | undefined): string | null {
    const value = icon?.trim() || null;
    if (value && !isEmoji(value))
      throw new BadRequestException('A document icon is a single emoji');
    return value;
  }

  private conflict(current: DocumentEntity): ConflictException {
    const body: Omit<DocumentConflict, 'current'> & { current: unknown } = {
      statusCode: 409,
      code: 'document_conflict',
      message: `The document changed (now at version ${current.version}). Reload or merge before saving again.`,
      current: current.toJSON(),
    };
    return new ConflictException(body);
  }

  /** Anyone who can write can create; attaches to the given project / workstream / issue in the same call. */
  async create(ctx: WorkspaceContext, input: CreateDocumentInput) {
    const workspaceId = ctx.workspace.id;
    const title = cleanTitle(input.title);
    if (!title) throw new BadRequestException('A document needs a title');
    this.assertBody(input.body);
    const owners = await this.resolveOwners(workspaceId, input);
    const now = new Date();
    const row = await this.ds.transaction(async (m) => {
      const saved = await m.getRepository(DocumentEntity).save(
        m.getRepository(DocumentEntity).create({
          id: uid('doc'),
          workspaceId,
          title,
          body: input.body ?? '',
          icon: this.cleanIcon(input.icon),
          version: 1,
          author: ctx.actor,
          lastEditor: ctx.actor,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await m.getRepository(DocumentRevisionEntity).save(
        m.getRepository(DocumentRevisionEntity).create({
          id: uid('rev'),
          workspaceId,
          documentId: saved.id,
          version: 1,
          title,
          body: saved.body,
          editor: ctx.actor,
          createdAt: now,
        }),
      );
      return saved;
    });
    for (const [key, value] of Object.entries(owners))
      await this.attachTo(workspaceId, ctx.actor, row.id, { [key]: value });
    await this.events.record({
      workspaceId,
      actor: ctx.actor,
      type: 'document.created',
      subject: { type: 'document', id: row.id },
      data: { title, ...owners },
    });
    return this.withLinks(workspaceId, row);
  }

  /**
   * Changes the title, body and/or icon of a document. `baseVersion` must be the current `version`; otherwise
   * nothing is written and the caller gets 409 with the current document. Archived documents are read-only.
   * A change that touches nothing is a no-op (no new version).
   */
  async update(ctx: WorkspaceContext, id: string, input: UpdateDocumentInput) {
    const workspaceId = ctx.workspace.id;
    const row = await this.load(workspaceId, id);
    if (row.archivedAt)
      throw new BadRequestException(
        'This document is archived: restore it to edit it',
      );
    if (row.version !== input.baseVersion) throw this.conflict(row);
    this.assertBody(input.body);
    const patch: Partial<Pick<DocumentEntity, 'title' | 'body' | 'icon'>> = {};
    const fields: string[] = [];
    if (input.title !== undefined) {
      const title = cleanTitle(input.title);
      if (!title) throw new BadRequestException('A document needs a title');
      if (title !== row.title) {
        patch.title = title;
        fields.push('title');
      }
    }
    if (input.body !== undefined && input.body !== row.body) {
      patch.body = input.body;
      fields.push('body');
    }
    if (input.icon !== undefined) {
      const icon = this.cleanIcon(input.icon);
      if (icon !== row.icon) {
        patch.icon = icon;
        fields.push('icon');
      }
    }
    if (!fields.length) return this.withLinks(workspaceId, row);
    return this.write(ctx, row, patch, fields, false);
  }

  /** Applies a patch at `row.version`, adds or merges the revision, and announces it. */
  private async write(
    ctx: WorkspaceContext,
    row: DocumentEntity,
    patch: Partial<Pick<DocumentEntity, 'title' | 'body' | 'icon'>>,
    fields: string[],
    forceCheckpoint: boolean,
    extra: Record<string, unknown> = {},
  ) {
    const workspaceId = ctx.workspace.id;
    const baseVersion = row.version;
    const now = new Date();
    const next = {
      title: patch.title ?? row.title,
      body: patch.body ?? row.body,
    };
    const checkpoint = await this.ds.transaction(async (m) => {
      const res = await m
        .getRepository(DocumentEntity)
        .update(
          { id: row.id, workspaceId, version: baseVersion },
          {
            ...patch,
            version: baseVersion + 1,
            lastEditor: ctx.actor,
            updatedAt: now,
          },
        );
      // somebody saved between our read and this write
      if (!res.affected) return null;
      const revisions = m.getRepository(DocumentRevisionEntity);
      const [head] = await revisions.find({
        where: { documentId: row.id },
        order: { version: 'DESC' },
        take: 1,
      });
      if (!forceCheckpoint && mergesIntoHead(head, ctx.actor, now)) {
        await revisions.update(
          { id: head.id },
          { version: baseVersion + 1, ...next },
        );
        return false;
      }
      await revisions.save(
        revisions.create({
          id: uid('rev'),
          workspaceId,
          documentId: row.id,
          version: baseVersion + 1,
          ...next,
          editor: ctx.actor,
          createdAt: now,
        }),
      );
      await m.query(
        `DELETE FROM "document_revisions" WHERE "documentId" = $1 AND "id" IN (SELECT "id" FROM "document_revisions" WHERE "documentId" = $1 ORDER BY "version" DESC OFFSET $2)`,
        [row.id, DOCUMENT_LIMITS.revisionsKept],
      );
      return true;
    });
    if (checkpoint === null)
      throw this.conflict(await this.load(workspaceId, row.id));
    if (patch.title !== undefined)
      await this.ds
        .getRepository(ArtifactEntity)
        .update(
          { workspaceId, documentId: row.id },
          { title: patch.title, updatedAt: now },
        );
    Object.assign(row, patch, {
      version: baseVersion + 1,
      lastEditor: ctx.actor,
      updatedAt: now,
    });
    if (checkpoint)
      await this.events.record({
        workspaceId,
        actor: ctx.actor,
        type: 'document.updated',
        subject: { type: 'document', id: row.id },
        data: { title: row.title, version: row.version, fields, ...extra },
      });
    // Autosaves inside one revision window are not activity, but other tabs still want the new text.
    else
      this.events.publish(workspaceId, {
        type: 'updated',
        entity: 'document',
        id: row.id,
      });
    if (patch.title !== undefined)
      await this.touchWorkstreams(workspaceId, row.id);
    return this.withLinks(workspaceId, row);
  }

  private async touchWorkstreams(workspaceId: string, documentId: string) {
    const rows = await this.ds
      .getRepository(ArtifactEntity)
      .find({
        where: { workspaceId, documentId },
        select: { workstreamId: true },
      });
    for (const w of new Set(
      rows.map((r) => r.workstreamId).filter((w): w is string => !!w),
    ))
      await this.bus.touch(workspaceId, w, 'artifact.updated');
  }

  /** Hides the document from lists; it stays readable, linked and restorable. */
  async archive(ctx: WorkspaceContext, id: string) {
    return this.setArchived(ctx, id, true);
  }

  async restore(ctx: WorkspaceContext, id: string) {
    return this.setArchived(ctx, id, false);
  }

  private async setArchived(
    ctx: WorkspaceContext,
    id: string,
    archived: boolean,
  ) {
    const workspaceId = ctx.workspace.id;
    const row = await this.load(workspaceId, id);
    if (!!row.archivedAt === archived) return this.withLinks(workspaceId, row);
    row.archivedAt = archived ? new Date() : null;
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor: ctx.actor,
      type: archived ? 'document.archived' : 'document.restored',
      subject: { type: 'document', id },
      data: { title: row.title },
    });
    return this.withLinks(workspaceId, row);
  }

  /** The author, or an admin. Removes the document, its revisions, its attachments and their comments. */
  async remove(ctx: WorkspaceContext, id: string) {
    const workspaceId = ctx.workspace.id;
    const row = await this.load(workspaceId, id);
    if (!sameActor(row.author, ctx.actor) && !hasRole(ctx.role, 'admin'))
      throw new ForbiddenException(
        'Only the author or an admin can delete a document (archive it instead)',
      );
    const attached = await this.ds
      .getRepository(ArtifactEntity)
      .find({ where: { workspaceId, documentId: id } });
    await this.ds.transaction(async (m) => {
      const ids = [id, ...attached.map((a) => a.id)];
      await m.query(
        `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`,
        [workspaceId, ids],
      );
      await m
        .getRepository(ArtifactEntity)
        .delete({ workspaceId, documentId: id });
      await m.getRepository(DocumentEntity).delete({ id, workspaceId });
    });
    await this.events.record({
      workspaceId,
      actor: ctx.actor,
      type: 'document.deleted',
      subject: { type: 'document', id },
      data: { title: row.title },
    });
    for (const a of attached)
      this.events.publish(workspaceId, {
        type: 'deleted',
        entity: 'artifact',
        id: a.id,
      });
    for (const w of new Set(
      attached.map((a) => a.workstreamId).filter((w): w is string => !!w),
    ))
      await this.bus.touch(workspaceId, w, 'artifact.deleted');
  }

  // ───────────────────────────── revisions ─────────────────────────────

  /** Newest first, without bodies. */
  async revisions(workspaceId: string, id: string) {
    await this.load(workspaceId, id);
    return this.ds.getRepository(DocumentRevisionEntity).find({
      where: { workspaceId, documentId: id },
      order: { version: 'DESC' },
      select: {
        id: true,
        documentId: true,
        version: true,
        title: true,
        editor: true,
        createdAt: true,
      },
    });
  }

  async revision(workspaceId: string, id: string, version: number) {
    const rev = await this.ds
      .getRepository(DocumentRevisionEntity)
      .findOneBy({ workspaceId, documentId: id, version });
    if (!rev) throw notFound('Revision', `${id}@${version}`);
    return rev;
  }

  /**
   * Makes an earlier revision the current text as a new version (history is never rewritten). Needs the
   * `baseVersion` like any edit, and always leaves a revision of its own.
   */
  async restoreRevision(
    ctx: WorkspaceContext,
    id: string,
    version: number,
    baseVersion: number,
  ) {
    const workspaceId = ctx.workspace.id;
    const rev = await this.revision(workspaceId, id, version);
    const row = await this.load(workspaceId, id);
    if (row.archivedAt)
      throw new BadRequestException(
        'This document is archived: restore it to edit it',
      );
    if (row.version !== baseVersion) throw this.conflict(row);
    if (rev.title === row.title && rev.body === row.body)
      return this.withLinks(workspaceId, row);
    const patch: Partial<Pick<DocumentEntity, 'title' | 'body'>> = {};
    const fields: string[] = [];
    if (rev.title !== row.title) {
      patch.title = rev.title;
      fields.push('title');
    }
    if (rev.body !== row.body) {
      patch.body = rev.body;
      fields.push('body');
    }
    return this.write(ctx, row, patch, fields, true, { restoredFrom: version });
  }

  // ───────────────────────────── attachments ─────────────────────────────

  /** Attaches the document to one project / workstream / issue (id or key) as a `document` artifact. Idempotent. */
  async attach(ctx: WorkspaceContext, id: string, owner: DocumentOwners) {
    const workspaceId = ctx.workspace.id;
    await this.load(workspaceId, id);
    const keys = Object.entries(owner).filter(([, v]) => !!v);
    if (keys.length !== 1)
      throw new BadRequestException(
        'Give exactly one of projectId, workstreamId or issueId',
      );
    const resolved = await this.resolveOwners(workspaceId, owner);
    await this.attachTo(workspaceId, ctx.actor, id, resolved);
    this.events.publish(workspaceId, {
      type: 'updated',
      entity: 'document',
      id,
    });
    return this.get(workspaceId, id);
  }

  private async attachTo(
    workspaceId: string,
    actor: ActorRef,
    documentId: string,
    owner: { projectId?: string; workstreamId?: string; issueId?: string },
  ) {
    const exists = await this.ds
      .getRepository(ArtifactEntity)
      .existsBy({ workspaceId, documentId, ...owner });
    if (exists) return;
    await this.artifacts.create(workspaceId, actor, {
      kind: 'document',
      documentId,
      ...owner,
    });
  }

  /** Removes one attachment (a `document` artifact of this document). The document itself stays. */
  async detach(ctx: WorkspaceContext, id: string, artifactId: string) {
    const workspaceId = ctx.workspace.id;
    await this.load(workspaceId, id);
    const art = await this.ds
      .getRepository(ArtifactEntity)
      .findOneBy({ workspaceId, documentId: id, id: artifactId });
    if (!art) throw notFound('Attachment', artifactId);
    await this.artifacts.remove(workspaceId, ctx.actor, artifactId);
    this.events.publish(workspaceId, {
      type: 'updated',
      entity: 'document',
      id,
    });
    return this.get(workspaceId, id);
  }
}
