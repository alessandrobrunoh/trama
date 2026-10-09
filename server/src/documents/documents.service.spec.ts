import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, type DataSource, type Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import type { RefsService } from '../common/refs.service.js';
import {
  DOCUMENT_LIMITS,
  type ActorRef,
  type Role,
} from '../contracts/domain.js';
import {
  ArtifactEntity,
  DocumentEntity,
  DocumentRevisionEntity,
  IssueEntity,
  ProjectEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import type { WorkstreamBus } from '../events/workstream-bus.js';
import { DocumentsService } from './documents.service.js';

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

/** In-memory stand-in for a TypeORM repository: just what the services under test call. */
function fakeRepo<T extends Row>(
  rows: T[],
  Entity: new () => object,
  hooks: { updateAffected?: () => number | undefined } = {},
) {
  const matches = (r: T, where: Where) =>
    Object.entries(where).every(([k, v]) => {
      if (v instanceof FindOperator)
        return (v.value as unknown[]).includes(r[k]);
      return r[k] === v;
    });
  const sorted = (list: T[], order?: Record<string, 'ASC' | 'DESC'>) => {
    const [key, dir] = Object.entries(order ?? {})[0] ?? [];
    if (!key) return list;
    const val = (r: T) =>
      r[key] instanceof Date ? (r[key] as Date).getTime() : (r[key] as number);
    return [...list].sort(
      (a, b) => (val(a) - val(b)) * (dir === 'DESC' ? -1 : 1),
    );
  };
  return {
    rows,
    create: (x: Partial<T>) => Object.assign(new Entity(), x) as T,
    save: async (x: T) => {
      const i = rows.findIndex((r) => r.id === x.id);
      if (i >= 0) rows[i] = x;
      else rows.push(x);
      return x;
    },
    findOneBy: async (where: Where) =>
      rows.find((r) => matches(r, where)) ?? null,
    findOne: async ({ where }: { where: Where }) =>
      rows.find((r) => matches(r, where)) ?? null,
    existsBy: async (where: Where) => rows.some((r) => matches(r, where)),
    find: async ({
      where,
      order,
      take,
    }: {
      where: Where;
      order?: Record<string, 'ASC' | 'DESC'>;
      take?: number;
    }) => {
      const found = sorted(
        rows.filter((r) => matches(r, where)),
        order,
      );
      return take ? found.slice(0, take) : found;
    },
    update: async (where: Where, patch: Partial<T>) => {
      const hit = rows.filter((r) => matches(r, where));
      const affected = hooks.updateAffected?.() ?? hit.length;
      if (affected) for (const r of hit) Object.assign(r, patch);
      return { affected };
    },
    delete: async (where: Where) => {
      for (const r of rows.filter((x) => matches(x, where)))
        rows.splice(rows.indexOf(r), 1);
    },
  };
}

const WS = 'ws_1';
const ME: ActorRef = { type: 'user', id: 'u_me' };
const OTHER: ActorRef = { type: 'user', id: 'u_other' };
const AGENT: ActorRef = { type: 'agent', id: 'ag_1' };

function ctx(
  actor: ActorRef = ME,
  role: Role = 'member',
  workspaceId = WS,
): WorkspaceContext {
  return {
    workspace: { id: workspaceId },
    actor,
    userId: actor.id,
    role,
  } as unknown as WorkspaceContext;
}

function setup(opts: { raceOnce?: boolean } = {}) {
  let race = opts.raceOnce ?? false;
  const docs = fakeRepo<DocumentEntity & Row>([], DocumentEntity, {
    updateAffected: () => {
      if (!race) return undefined;
      race = false;
      return 0;
    },
  });
  const revs = fakeRepo<DocumentRevisionEntity & Row>(
    [],
    DocumentRevisionEntity,
  );
  const arts = fakeRepo<ArtifactEntity & Row>([], ArtifactEntity);
  const projects = fakeRepo<ProjectEntity & Row>(
    [
      { id: 'pj_1', workspaceId: WS } as ProjectEntity & Row,
      { id: 'pj_x', workspaceId: 'ws_2' } as ProjectEntity & Row,
    ],
    ProjectEntity,
  );
  const issues = fakeRepo<IssueEntity & Row>(
    [
      {
        id: 'in_1',
        key: 'BUG-1',
        workspaceId: WS,
        aliases: [],
      } as unknown as IssueEntity & Row,
    ],
    IssueEntity,
  );
  const workstreams = fakeRepo<WorkstreamEntity & Row>(
    [
      {
        id: 'wk_1',
        key: 'AUTH-1',
        workspaceId: WS,
      } as unknown as WorkstreamEntity & Row,
    ],
    WorkstreamEntity,
  );
  const queries: { sql: string; params?: unknown[] }[] = [];
  const byEntity = new Map<unknown, unknown>([
    [DocumentEntity, docs],
    [DocumentRevisionEntity, revs],
    [ArtifactEntity, arts],
    [ProjectEntity, projects],
    [IssueEntity, issues],
    [WorkstreamEntity, workstreams],
  ]);
  const manager = {
    getRepository: (e: unknown) => byEntity.get(e),
    query: async (sql: string, params?: unknown[]) =>
      void queries.push({ sql, params }),
  };
  const ds = {
    getRepository: (e: unknown) => byEntity.get(e),
    transaction: async <R>(cb: (m: typeof manager) => Promise<R>) =>
      cb(manager),
    query: async () => [],
  } as unknown as DataSource;
  const events = { record: vi.fn(async () => ({})), publish: vi.fn() };
  const touch = vi.fn(async () => undefined);
  const bus = { touch } as unknown as WorkstreamBus;
  const refs = {
    workstreams: async () => undefined,
    repositories: async () => undefined,
  } as unknown as RefsService;
  const artifactsService = new ArtifactsService(
    ds,
    refs,
    events as unknown as EventsService,
    bus,
    arts as unknown as Repository<ArtifactEntity>,
  );
  const service = new DocumentsService(
    ds,
    events as unknown as EventsService,
    bus,
    artifactsService,
    docs as unknown as Repository<DocumentEntity>,
  );
  return { service, docs, revs, arts, events, queries, touch };
}

describe('DocumentsService.create', () => {
  it('starts at version 1 with a first revision, and records who wrote it', async () => {
    const { service, revs, events } = setup();
    const doc = await service.create(ctx(), {
      title: '  Launch   plan \n',
      body: '# Hi',
    });
    expect(doc).toMatchObject({
      title: 'Launch plan',
      body: '# Hi',
      version: 1,
      author: ME,
      lastEditor: ME,
      links: [],
    });
    expect(revs.rows).toHaveLength(1);
    expect(revs.rows[0]).toMatchObject({
      documentId: doc.id,
      version: 1,
      body: '# Hi',
      editor: ME,
    });
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.created',
        subject: { type: 'document', id: doc.id },
      }),
    );
  });

  it('refuses an empty title and a body over the limit', async () => {
    const { service } = setup();
    await expect(service.create(ctx(), { title: '  ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.create(ctx(), {
        title: 'x',
        body: 'a'.repeat(DOCUMENT_LIMITS.bodyMax + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(ctx(), {
        title: 'x',
        body: 'a'.repeat(DOCUMENT_LIMITS.bodyMax),
      }),
    ).resolves.toMatchObject({ version: 1 });
  });

  it('accepts an emoji icon only', async () => {
    const { service } = setup();
    await expect(
      service.create(ctx(), { title: 'x', icon: '🚀' }),
    ).resolves.toMatchObject({ icon: '🚀' });
    await expect(
      service.create(ctx(), {
        title: 'x',
        icon: '<img src=x onerror=alert(1)>',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const doc = await service.create(ctx(), { title: 'x' });
    await expect(
      service.update(ctx(), doc.id, { baseVersion: 1, icon: 'rocket' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(ctx(), doc.id, { baseVersion: 1, icon: '📝' }),
    ).resolves.toMatchObject({ icon: '📝', version: 2 });
    await expect(
      service.update(ctx(), doc.id, { baseVersion: 2, icon: null }),
    ).resolves.toMatchObject({ version: 3 });
  });

  it('attaches to a project and an issue (by key) as document artifacts that follow the title', async () => {
    const { service, arts } = setup();
    const doc = await service.create(ctx(), {
      title: 'Spec',
      projectId: 'pj_1',
      issueId: 'bug-1',
    });
    expect(arts.rows).toHaveLength(2);
    expect(
      arts.rows.every(
        (a) =>
          a.kind === 'document' &&
          a.documentId === doc.id &&
          a.title === 'Spec' &&
          a.provider === 'docs',
      ),
    ).toBe(true);
    expect(
      doc.links
        .map((l) => l.projectId ?? l.issueId)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(['in_1', 'pj_1']);
  });

  it('does not create the document when an owner does not exist', async () => {
    const { service, docs } = setup();
    await expect(
      service.create(ctx(), { title: 'Spec', workstreamId: 'NOPE-9' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.create(ctx(), { title: 'Spec', projectId: 'pj_x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(docs.rows).toHaveLength(0);
  });
});

describe('workspace scoping', () => {
  it('never reads, edits, archives, deletes or attaches a document of another workspace', async () => {
    const { service } = setup();
    const doc = await service.create(ctx(), { title: 'Mine' });
    const foreign = ctx(ME, 'owner', 'ws_2');
    await expect(service.get('ws_2', doc.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.update(foreign, doc.id, { baseVersion: 1, title: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.archive(foreign, doc.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(foreign, doc.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.attach(foreign, doc.id, { projectId: 'pj_x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.revisions('ws_2', doc.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.revision('ws_2', doc.id, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cannot attach to a project of another workspace', async () => {
    const { service } = setup();
    const doc = await service.create(ctx(), { title: 'Mine' });
    await expect(
      service.attach(ctx(), doc.id, { projectId: 'pj_x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('optimistic concurrency', () => {
  it('bumps the version and the last editor on a change', async () => {
    const { service } = setup();
    const doc = await service.create(ctx(), { title: 'A', body: 'one' });
    const next = await service.update(ctx(OTHER), doc.id, {
      baseVersion: 1,
      body: 'two',
    });
    expect(next).toMatchObject({
      version: 2,
      body: 'two',
      lastEditor: OTHER,
      author: ME,
    });
  });

  it('answers 409 with the current document when the base version is stale, and writes nothing', async () => {
    const { service, docs } = setup();
    const doc = await service.create(ctx(), { title: 'A', body: 'one' });
    await service.update(ctx(OTHER), doc.id, { baseVersion: 1, body: 'two' });
    const err = await service
      .update(ctx(), doc.id, { baseVersion: 1, body: 'mine' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      code: string;
      current: { version: number; body: string };
    };
    expect(body).toMatchObject({
      code: 'document_conflict',
      current: { version: 2, body: 'two' },
    });
    expect(docs.rows[0]).toMatchObject({ version: 2, body: 'two' });
  });

  it('answers 409 when someone saved between the read and the write (lost race)', async () => {
    const { service } = setup({ raceOnce: true });
    const doc = await service.create(ctx(), { title: 'A', body: 'one' });
    await expect(
      service.update(ctx(), doc.id, { baseVersion: 1, body: 'two' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('is a no-op (same version) when nothing changes', async () => {
    const { service, revs, events } = setup();
    const doc = await service.create(ctx(), { title: 'A', body: 'one' });
    events.record.mockClear();
    const same = await service.update(ctx(), doc.id, {
      baseVersion: 1,
      title: 'A',
      body: 'one',
    });
    expect(same.version).toBe(1);
    expect(revs.rows).toHaveLength(1);
    expect(events.record).not.toHaveBeenCalled();
  });

  it('refuses edits to an archived document until it is restored', async () => {
    const { service } = setup();
    const doc = await service.create(ctx(), { title: 'A' });
    await service.archive(ctx(), doc.id);
    await expect(
      service.update(ctx(), doc.id, { baseVersion: 1, body: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.restore(ctx(), doc.id);
    await expect(
      service.update(ctx(), doc.id, { baseVersion: 1, body: 'x' }),
    ).resolves.toMatchObject({ version: 2 });
  });
});

describe('revisions', () => {
  it('merges saves of the same person inside the window into the newest revision', async () => {
    const { service, revs, events } = setup();
    const doc = await service.create(ctx(), { title: 'A', body: 'v1' });
    events.record.mockClear();
    await service.update(ctx(), doc.id, { baseVersion: 1, body: 'v2' });
    await service.update(ctx(), doc.id, { baseVersion: 2, body: 'v3' });
    expect(revs.rows).toHaveLength(1);
    expect(revs.rows[0]).toMatchObject({ version: 3, body: 'v3' });
    // autosaves are not activity, but other tabs are told
    expect(events.record).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenCalledWith(WS, {
      type: 'updated',
      entity: 'document',
      id: doc.id,
    });
  });

  it('starts a new revision for another editor, and records that as activity', async () => {
    const { service, revs, events } = setup();
    const doc = await service.create(ctx(), { title: 'A', body: 'v1' });
    await service.update(ctx(AGENT), doc.id, { baseVersion: 1, body: 'v2' });
    expect(
      revs.rows.map((r) => [r.version, r.body, (r.editor as ActorRef).id]),
    ).toEqual([
      [1, 'v1', 'u_me'],
      [2, 'v2', 'ag_1'],
    ]);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.updated',
        data: expect.objectContaining({ version: 2, fields: ['body'] }),
      }),
    );
  });

  it('starts a new revision when the window has passed', async () => {
    vi.useFakeTimers();
    try {
      const { service, revs } = setup();
      const doc = await service.create(ctx(), { title: 'A', body: 'v1' });
      vi.advanceTimersByTime(DOCUMENT_LIMITS.revisionWindowMs + 1000);
      await service.update(ctx(), doc.id, { baseVersion: 1, body: 'v2' });
      expect(revs.rows).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes the history to the newest N after adding a checkpoint', async () => {
    const { service, queries } = setup();
    const doc = await service.create(ctx(), { title: 'A', body: 'v1' });
    await service.update(ctx(OTHER), doc.id, { baseVersion: 1, body: 'v2' });
    const prune = queries.find((q) =>
      q.sql.includes('DELETE FROM "document_revisions"'),
    );
    expect(prune?.params).toEqual([doc.id, DOCUMENT_LIMITS.revisionsKept]);
  });

  it('lists newest first and reads one revision with its body', async () => {
    const { service } = setup();
    const doc = await service.create(ctx(), { title: 'A', body: 'v1' });
    await service.update(ctx(OTHER), doc.id, { baseVersion: 1, body: 'v2' });
    expect((await service.revisions(WS, doc.id)).map((r) => r.version)).toEqual(
      [2, 1],
    );
    expect(await service.revision(WS, doc.id, 1)).toMatchObject({ body: 'v1' });
    await expect(service.revision(WS, doc.id, 9)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('restores an earlier revision as a new version with its own checkpoint, and needs the base version', async () => {
    const { service, revs } = setup();
    const doc = await service.create(ctx(), { title: 'Old title', body: 'v1' });
    await service.update(ctx(), doc.id, {
      baseVersion: 1,
      title: 'New title',
      body: 'v2',
    });
    expect(revs.rows).toHaveLength(1); // merged into the first revision, which now holds version 2
    await service.update(ctx(OTHER), doc.id, { baseVersion: 2, body: 'v3' });
    await expect(
      service.restoreRevision(ctx(), doc.id, 2, 2),
    ).rejects.toBeInstanceOf(ConflictException);
    const restored = await service.restoreRevision(ctx(), doc.id, 2, 3);
    expect(restored).toMatchObject({
      version: 4,
      body: 'v2',
      title: 'New title',
    });
    expect(revs.rows.map((r) => r.version)).toEqual([2, 3, 4]);
    expect(revs.rows.at(-1)).toMatchObject({
      version: 4,
      body: 'v2',
      editor: ME,
    });
    await expect(
      service.restoreRevision(ctx(), doc.id, 99, 4),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('artifact linking', () => {
  it('renames the attached artifacts and touches their workstreams when the title changes', async () => {
    const { service, arts, touch } = setup();
    const doc = await service.create(ctx(), {
      title: 'Spec',
      workstreamId: 'AUTH-1',
    });
    touch.mockClear();
    await service.update(ctx(), doc.id, { baseVersion: 1, title: 'Spec v2' });
    expect(arts.rows[0]).toMatchObject({ title: 'Spec v2' });
    expect(touch).toHaveBeenCalledWith(WS, 'wk_1', 'artifact.updated');
  });

  it('attach is idempotent and needs exactly one owner; detach removes only that link', async () => {
    const { service, arts } = setup();
    const doc = await service.create(ctx(), { title: 'Spec' });
    await expect(service.attach(ctx(), doc.id, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.attach(ctx(), doc.id, { projectId: 'pj_1', issueId: 'BUG-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.attach(ctx(), doc.id, { projectId: 'pj_1' });
    const twice = await service.attach(ctx(), doc.id, { projectId: 'pj_1' });
    expect(twice.links).toHaveLength(1);
    const withIssue = await service.attach(ctx(), doc.id, { issueId: 'BUG-1' });
    expect(withIssue.links).toHaveLength(2);
    const after = await service.detach(ctx(), doc.id, arts.rows[0].id);
    expect(after.links).toHaveLength(1);
    expect(after.title).toBe('Spec');
    await expect(
      service.detach(ctx(), doc.id, 'ar_nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleting the document removes its attachments and the comments on them', async () => {
    const { service, arts, queries, events } = setup();
    const doc = await service.create(ctx(), {
      title: 'Spec',
      projectId: 'pj_1',
    });
    const artifactId = arts.rows[0].id;
    await service.remove(ctx(), doc.id);
    expect(arts.rows).toHaveLength(0);
    expect(
      queries.find((q) => q.sql.includes('DELETE FROM "comments"'))?.params,
    ).toEqual([WS, [doc.id, artifactId]]);
    expect(events.publish).toHaveBeenCalledWith(WS, {
      type: 'deleted',
      entity: 'artifact',
      id: artifactId,
    });
    await expect(service.get(WS, doc.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('permissions', () => {
  it('deletes only for the author or an admin', async () => {
    const { service } = setup();
    const doc = await service.create(ctx(ME, 'member'), { title: 'Mine' });
    await expect(
      service.remove(ctx(OTHER, 'member'), doc.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.remove(ctx(OTHER, 'viewer'), doc.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.remove(ctx(OTHER, 'admin'), doc.id),
    ).resolves.toBeUndefined();
    const second = await service.create(ctx(ME, 'member'), {
      title: 'Mine too',
    });
    await expect(
      service.remove(ctx(ME, 'member'), second.id),
    ).resolves.toBeUndefined();
  });

  it('lets any writer edit and archive someone else’s document (wiki rules)', async () => {
    const { service } = setup();
    const doc = await service.create(ctx(ME), { title: 'Shared' });
    await expect(
      service.update(ctx(OTHER, 'member'), doc.id, {
        baseVersion: 1,
        body: 'x',
      }),
    ).resolves.toMatchObject({ lastEditor: OTHER });
    await expect(
      service.archive(ctx(OTHER, 'member'), doc.id),
    ).resolves.toMatchObject({ archivedAt: expect.any(Date) });
  });
});
