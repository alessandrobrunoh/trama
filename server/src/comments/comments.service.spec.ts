import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, type Repository } from 'typeorm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMENT_PAGE_SIZE } from '../contracts/domain.js';
import * as entities from '../database/entities/index.js';
import { CommentEntity } from '../database/entities/index.js';
import { SnapshotQuery } from '../snapshot/snapshot.controller.js';
import { decodeCommentCursor, encodeCommentCursor, parseCommentLimit } from './comment-cursor.js';
import { PageCommentsQuery } from './comments.controller.js';
import { CommentsService } from './comments.service.js';

const errorsOf = async (cls: new () => object, plain: object) =>
  (await validate(plainToInstance(cls, plain))).map((e) => e.property);

describe('comment cursor', () => {
  it('round-trips (createdAt, id)', () => {
    const at = new Date('2026-03-04T05:06:07.089Z');
    expect(decodeCommentCursor(encodeCommentCursor({ at, id: 'cm_abc-1' }))).toEqual({ at, id: 'cm_abc-1' });
  });

  it('rejects anything not produced by the encoder', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const bad = [
      '',
      'not a cursor!',
      '%%%',
      b64('nope'),
      b64('2026-03-04|cm_1'),
      b64('2026-03-04T05:06:07.089Z|cm 1; drop'),
      b64('2026-13-45T25:61:61.000Z|cm_1'),
      'a'.repeat(300),
    ];
    for (const raw of bad) expect(() => decodeCommentCursor(raw), raw).toThrow(BadRequestException);
  });
});

describe('comment page limit', () => {
  it('defaults and accepts 1..max', () => {
    expect(parseCommentLimit(undefined)).toBe(COMMENT_PAGE_SIZE.default);
    expect(parseCommentLimit(1)).toBe(1);
    expect(parseCommentLimit(COMMENT_PAGE_SIZE.max)).toBe(COMMENT_PAGE_SIZE.max);
  });

  it('rejects zero, negatives, fractions, too large and non-numbers', () => {
    for (const bad of [0, -1, 1.5, COMMENT_PAGE_SIZE.max + 1, Number.NaN, '10']) {
      expect(() => parseCommentLimit(bad)).toThrow(BadRequestException);
    }
  });
});

describe('query DTOs', () => {
  const base = { subjectType: 'issue', subjectId: 'in_1' };

  it('requires a subject and bounds limit/cursor on /comments/page', async () => {
    expect(await errorsOf(PageCommentsQuery, { ...base, limit: '25', cursor: 'abc' })).toEqual([]);
    expect(await errorsOf(PageCommentsQuery, {})).toEqual(expect.arrayContaining(['subjectType', 'subjectId']));
    expect(await errorsOf(PageCommentsQuery, { ...base, subjectType: 'bogus' })).toEqual(['subjectType']);
    expect(await errorsOf(PageCommentsQuery, { ...base, limit: '0' })).toEqual(['limit']);
    expect(await errorsOf(PageCommentsQuery, { ...base, limit: String(COMMENT_PAGE_SIZE.max + 1) })).toEqual(['limit']);
    expect(await errorsOf(PageCommentsQuery, { ...base, limit: 'x' })).toEqual(['limit']);
    expect(await errorsOf(PageCommentsQuery, { ...base, cursor: 'x'.repeat(201) })).toEqual(['cursor']);
  });

  it('accepts only known snapshot comment modes', async () => {
    expect(await errorsOf(SnapshotQuery, {})).toEqual([]);
    expect(await errorsOf(SnapshotQuery, { comments: 'index' })).toEqual([]);
    expect(await errorsOf(SnapshotQuery, { comments: 'full' })).toEqual([]);
    expect(await errorsOf(SnapshotQuery, { comments: 'none' })).toEqual(['comments']);
  });
});

/** A real query builder over the real entity metadata (no connection needed) to inspect the generated SQL. */
let repo: Repository<CommentEntity>;
beforeAll(async () => {
  const ds = new DataSource({ type: 'postgres', entities: Object.values(entities).filter((e) => typeof e === 'function') });
  await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  repo = ds.getRepository(CommentEntity);
});

const service = () => new CommentsService({} as never, {} as never, {} as never, repo);
const sqlOf = (cursor?: string) =>
  service().pageQuery('ws_1', { subjectType: 'issue', subjectId: 'in_1', cursor }, 50).getQueryAndParameters();

describe('CommentsService.pageQuery scoping', () => {
  it('always filters by workspace and subject, newest first, one extra row', () => {
    const [sql, params] = sqlOf();
    expect(sql).toContain('"c"."workspaceId" = $1');
    expect(sql).toContain("c.subject->>'type' = $2");
    expect(sql).toContain("c.subject->>'id' = $3");
    expect(params).toEqual(['ws_1', 'issue', 'in_1']);
    expect(sql).toMatch(/ORDER BY "c_ts" DESC, "c"."id" DESC/);
    expect(sql).toMatch(/LIMIT 51$/);
  });

  it('adds a keyset condition for a cursor and keeps the scope parameters', () => {
    const at = new Date('2026-03-04T05:06:07.089Z');
    const [sql, params] = sqlOf(encodeCommentCursor({ at, id: 'cm_9' }));
    expect(sql).toContain(`date_trunc('milliseconds', "c"."createdAt") <`);
    expect(params).toEqual(['ws_1', 'issue', 'in_1', at, 'cm_9']);
  });

  it('rejects an invalid cursor before touching the database', () => {
    expect(() => sqlOf('garbage!!')).toThrow(BadRequestException);
  });
});

describe('CommentsService.page', () => {
  const row = (id: string, ms: number) => ({ id, createdAt: new Date(ms) }) as CommentEntity;
  const withRows = (rows: CommentEntity[]) => {
    const svc = service();
    const getMany = vi.fn(async () => rows);
    vi.spyOn(svc, 'pageQuery').mockReturnValue({ getMany } as never);
    return svc;
  };
  const subject = { subjectType: 'issue', subjectId: 'in_1' } as const;

  it('returns a next cursor pointing at the last item when more rows exist', async () => {
    const page = await withRows([row('cm_3', 3000), row('cm_2', 2000), row('cm_1', 1000)]).page('ws_1', { ...subject, limit: 2 });
    expect(page.items.map((c) => c.id)).toEqual(['cm_3', 'cm_2']);
    expect(decodeCommentCursor(page.nextCursor!)).toEqual({ at: new Date(2000), id: 'cm_2' });
  });

  it('has no next cursor on the last page', async () => {
    const page = await withRows([row('cm_2', 2000), row('cm_1', 1000)]).page('ws_1', { ...subject, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect((await withRows([]).page('ws_1', subject)).nextCursor).toBeNull();
  });

  it('rejects a bad limit', async () => {
    await expect(service().page('ws_1', { ...subject, limit: 500 })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CommentsService.index', () => {
  it('maps grouped rows to per-subject, per-author counts, scoped to the workspace', async () => {
    const getRawMany = vi.fn(async () => [
      { st: 'issue', sid: 'in_1', at: 'user', aid: 'u_1', n: '3' },
      { st: 'workstream', sid: 'wk_1', at: 'system', aid: null, n: '1' },
    ]);
    const qb: Record<string, unknown> = { getRawMany };
    for (const m of ['select', 'addSelect', 'where', 'groupBy', 'addGroupBy']) qb[m] = vi.fn(() => qb);
    const svc = new CommentsService({} as never, {} as never, {} as never, { createQueryBuilder: () => qb } as never);
    expect(await svc.index('ws_1')).toEqual([
      { subject: { type: 'issue', id: 'in_1' }, author: { type: 'user', id: 'u_1' }, count: 3 },
      { subject: { type: 'workstream', id: 'wk_1' }, author: { type: 'system' }, count: 1 },
    ]);
    expect(qb.where).toHaveBeenCalledWith('c.workspaceId = :workspaceId', { workspaceId: 'ws_1' });
  });
});
