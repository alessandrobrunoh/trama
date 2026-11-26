import type { INestApplication } from '@nestjs/common';
import type { ThreadDecision, ThreadRecord, ThreadSyncResult } from '../src/contracts/domain.js';
import { Client, createTestApp } from './app.js';

interface TaskJson {
  id: string;
  key: string;
  threadUrl?: string;
}

interface TimeEntryJson {
  id: string;
  userId: string;
  issueId?: string;
  source: string;
  startedAt: string;
  endedAt?: string;
}

interface ArtifactJson {
  id: string;
  kind: string;
  provider: string;
  title: string;
  url: string;
  externalId?: string;
  repository?: string;
}

interface SearchHit {
  type: string;
  id: string;
  key?: string;
  issueId?: string;
  title: string;
  subtitle: string;
}

const THREAD_A = 'https://delta.dev/t/th_d93f10';
const THREAD_B = 'https://delta.dev/t/th_e01a77';
const PR_URL = 'https://github.com/acme/web/pull/423';

describe('thread records, decisions and suggestions', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(server, 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Threads Co' }).expect(201)).body;
    const w = `/api/w/${ws.slug as string}`;
    return { owner: owner.client, ownerId: owner.user.id, w };
  }
  type Scene = Awaited<ReturnType<typeof setup>>;

  async function task(ctx: Scene, body: object = {}): Promise<TaskJson> {
    return (
      await ctx.owner
        .post(`${ctx.w}/tasks`, { kind: 'feature', title: 'Alerting when refresh fails', ...body })
        .expect(201)
    ).body as TaskJson;
  }

  const sync = (ctx: Scene, key: string, body: object) =>
    ctx.owner.post(`${ctx.w}/tasks/${key}/thread/sync`, body);

  it('links the thread through the first sync and keeps one record per task', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    await ctx.owner.get(`${ctx.w}/tasks/${t.key}/thread`).expect(404);

    const first = (
      await sync(ctx, t.key, {
        threadUrl: THREAD_A,
        summary: 'Added a metric',
        files: ['src/auth/refresh.ts', 'src/auth/metrics.ts'],
        turns: 6,
      }).expect(200)
    ).body as ThreadSyncResult;
    expect(first.linked).toBe(true);
    expect(first.decisionsAdded).toBe(0);
    expect(first.artifact).toBeNull();
    expect(first.timeSuggestion).toBeNull();
    expect(first.record).toMatchObject({
      issueId: t.id,
      threadUrl: THREAD_A,
      summary: 'Added a metric',
      files: ['src/auth/refresh.ts', 'src/auth/metrics.ts'],
      turns: 6,
      syncCount: 1,
      lastSyncBy: { type: 'user', id: ctx.ownerId },
      decisions: [],
    });
    expect((await ctx.owner.get(`${ctx.w}/tasks/${t.key}`).expect(200)).body.threadUrl).toBe(THREAD_A);

    // the second sync keeps the link, replaces the summary and merges the files, newest first
    const second = (
      await sync(ctx, t.key, {
        threadUrl: THREAD_A,
        summary: 'Added a metric and an alert',
        files: ['src/auth/alerts.ts', 'src/auth/refresh.ts'],
      }).expect(200)
    ).body as ThreadSyncResult;
    expect(second.linked).toBe(false);
    expect(second.record.syncCount).toBe(2);
    expect(second.record.summary).toBe('Added a metric and an alert');
    expect(second.record.turns).toBe(6);
    expect(second.record.files).toEqual(['src/auth/alerts.ts', 'src/auth/refresh.ts', 'src/auth/metrics.ts']);

    const read = (await ctx.owner.get(`${ctx.w}/tasks/${t.key}/thread`).expect(200)).body as ThreadRecord;
    expect(read.syncCount).toBe(2);
    expect(new Date(read.lastSyncAt).getTime()).not.toBeNaN();

    const events = (await ctx.owner.get(`${ctx.w}/events?type=issue.thread_synced`).expect(200)).body as {
      subject: { id: string };
      data: Record<string, unknown>;
    }[];
    expect(events).toHaveLength(2);
    expect(events[0].subject.id).toBe(t.id);
    expect(events[0].data).toMatchObject({ key: t.key, decisions: 0, files: 3, pullRequest: false, minutes: null });
  });

  it('syncs without a thread when the task has none', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    const res = (await sync(ctx, t.key, { summary: 'No thread yet' }).expect(200)).body as ThreadSyncResult;
    expect(res.linked).toBe(false);
    expect(res.record.threadUrl).toBeNull();
    expect((await ctx.owner.get(`${ctx.w}/tasks/${t.key}`).expect(200)).body.threadUrl).toBeUndefined();
  });

  it('refuses a different thread with 409, from PATCH and from sync', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    await sync(ctx, t.key, { threadUrl: THREAD_A }).expect(200);

    const patch = await ctx.owner.patch(`${ctx.w}/tasks/${t.key}`, { threadUrl: THREAD_B }).expect(409);
    expect(patch.body).toMatchObject({ code: 'thread_already_linked', threadUrl: THREAD_A });
    expect(typeof patch.body.message).toBe('string');

    const synced = await sync(ctx, t.key, { threadUrl: THREAD_B, summary: 'Should not be stored', decisions: [{ text: 'Nope' }] }).expect(409);
    expect(synced.body).toMatchObject({ code: 'thread_already_linked', threadUrl: THREAD_A });
    // nothing from the refused sync was written
    const record = (await ctx.owner.get(`${ctx.w}/tasks/${t.key}/thread`).expect(200)).body as ThreadRecord;
    expect(record.summary).toBeNull();
    expect(record.decisions).toEqual([]);

    // the same URL is fine, and so is unlinking and linking another
    await ctx.owner.patch(`${ctx.w}/tasks/${t.key}`, { threadUrl: THREAD_A }).expect(200);
    await ctx.owner.patch(`${ctx.w}/tasks/${t.key}`, { threadUrl: null }).expect(200);
    await ctx.owner.patch(`${ctx.w}/tasks/${t.key}`, { threadUrl: THREAD_B }).expect(200);

    // a new task can be created with its thread, and a subtask links its own
    const created = await task(ctx, { title: 'Retry metrics', threadUrl: THREAD_A });
    expect(created.threadUrl).toBe(THREAD_A);
    const sub = await task(ctx, { title: 'Retry metrics', parentId: t.key, threadUrl: THREAD_A });
    expect(sub.threadUrl).toBe(THREAD_A);
  });

  it('adds decisions and finds them by path', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    const other = await task(ctx, { title: 'Billing export' });

    const res = (
      await sync(ctx, t.key, {
        threadUrl: THREAD_A,
        decisions: [
          { text: 'Refresh tokens stay server side', paths: ['src/auth/*'] },
          { text: 'Alerts go through the existing queue', paths: ['src/alerts/', 'docs/alerts.md'] },
          { text: 'Specs sit next to the code', paths: ['src/**/*.spec.ts'] },
          { text: 'Task wide note' },
        ],
      }).expect(200)
    ).body as ThreadSyncResult;
    expect(res.decisionsAdded).toBe(4);
    expect(res.record.decisions.map((d) => d.text)).toEqual([
      'Refresh tokens stay server side',
      'Alerts go through the existing queue',
      'Specs sit next to the code',
      'Task wide note',
    ]);
    expect(res.record.decisions[0]).toMatchObject({
      issueId: t.id,
      issueKey: t.key,
      paths: ['src/auth/*'],
      threadUrl: THREAD_A,
      createdBy: { type: 'user', id: ctx.ownerId },
    });
    await sync(ctx, other.key, { decisions: [{ text: 'Exports are CSV', paths: ['src/billing/export.ts'] }] }).expect(200);

    const texts = async (query: string): Promise<string[]> =>
      ((await ctx.owner.get(`${ctx.w}/decisions${query}`).expect(200)).body as ThreadDecision[]).map((d) => d.text);

    // glob, one segment: matches a file in the folder, not one deeper
    expect(await texts('?path=src/auth/session.ts')).toEqual(['Refresh tokens stay server side']);
    expect(await texts('?path=src/auth/token/refresh.ts')).toEqual([]);
    // directory prefix and exact path
    expect(await texts('?path=src/alerts/queue.ts')).toEqual(['Alerts go through the existing queue']);
    expect(await texts('?path=docs/alerts.md')).toEqual(['Alerts go through the existing queue']);
    // ** crosses folders
    expect(await texts('?path=src/auth/token/refresh.spec.ts')).toEqual(['Specs sit next to the code']);
    expect(await texts('?path=src/billing/export.ts')).toEqual(['Exports are CSV']);
    // decisions without paths only match together with their task
    expect(await texts('?path=anything.ts')).toEqual([]);
    expect(await texts(`?path=anything.ts&issue=${t.key}`)).toEqual(['Task wide note']);
    expect(await texts(`?path=src/auth/session.ts&issue=${t.key}`)).toEqual([
      'Task wide note',
      'Refresh tokens stay server side',
    ]);
    // without a path: everything, newest first, filtered by task when asked
    expect(await texts('')).toHaveLength(5);
    expect((await texts('')).slice(-1)).toEqual(['Refresh tokens stay server side']);
    expect(await texts(`?issue=${other.key}`)).toEqual(['Exports are CSV']);
    expect(await texts(`?issue=${t.id}&limit=2`)).toHaveLength(2);
    await ctx.owner.get(`${ctx.w}/decisions?limit=500`).expect(400);

    // later syncs append, never replace
    await sync(ctx, t.key, { decisions: [{ text: 'One more', paths: ['src/auth/'] }] }).expect(200);
    expect(await texts(`?issue=${t.key}`)).toHaveLength(5);
    expect(await texts('?path=src/auth/session.ts')).toEqual(['One more', 'Refresh tokens stay server side']);
  });

  it('refuses unsafe paths, empty decisions and oversized input', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    for (const body of [
      { files: ['../etc/passwd'] },
      { files: ['/etc/passwd'] },
      { decisions: [{ text: 'x', paths: ['src/../../secrets'] }] },
      { decisions: [{ text: '   ' }] },
      { decisions: Array.from({ length: 21 }, (_, i) => ({ text: `d${i}` })) },
      { summary: 'x'.repeat(4001) },
      { activeMinutes: 0 },
      { activeMinutes: 721 },
      { pullRequestUrl: 'javascript:alert(1)' },
      { threadUrl: 'ftp://delta.dev/t/1' },
    ])
      await sync(ctx, t.key, body).expect(400);
    await ctx.owner.get(`${ctx.w}/tasks/${t.key}/thread`).expect(404);
    await sync(ctx, 'NOPE-1', { summary: 'x' }).expect(404);
  });

  it('attaches the pull request once and refreshes it on the next sync', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    const first = (await sync(ctx, t.key, { pullRequestUrl: PR_URL }).expect(200)).body as ThreadSyncResult;
    expect(first.artifact).toMatchObject({
      kind: 'pull_request',
      provider: 'github',
      url: PR_URL,
      externalId: '#423',
      repository: 'acme/web',
      title: 'acme/web#423',
    });

    const again = (await sync(ctx, t.key, { pullRequestUrl: PR_URL, summary: 'More work' }).expect(200)).body as ThreadSyncResult;
    expect((again.artifact as unknown as ArtifactJson).id).toBe((first.artifact as unknown as ArtifactJson).id);

    const artifacts = (await ctx.owner.get(`${ctx.w}/tasks/${t.key}/artifacts`).expect(200)).body as ArtifactJson[];
    expect(artifacts.filter((a) => a.url === PR_URL)).toHaveLength(1);

    // another PR is another artifact
    await sync(ctx, t.key, { pullRequestUrl: 'https://github.com/acme/web/pull/424' }).expect(200);
    const all = (await ctx.owner.get(`${ctx.w}/tasks/${t.key}/artifacts`).expect(200)).body as ArtifactJson[];
    expect(all.filter((a) => a.kind === 'pull_request')).toHaveLength(2);

    const events = (await ctx.owner.get(`${ctx.w}/events?type=issue.thread_synced`).expect(200)).body as {
      data: { pullRequest: boolean };
    }[];
    expect(events.every((e) => e.data.pullRequest)).toBe(true);
  });

  it('suggests time that stays out of the list until it is accepted', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    const res = (await sync(ctx, t.key, { activeMinutes: 47 }).expect(200)).body as ThreadSyncResult;
    expect(res.timeSuggestion).toMatchObject({ userId: ctx.ownerId, minutes: 47 });
    const id = res.timeSuggestion!.id;

    // not in the default list, not a running timer
    expect((await ctx.owner.get(`${ctx.w}/time-entries`).expect(200)).body).toEqual([]);
    const suggested = (await ctx.owner.get(`${ctx.w}/time-entries?source=suggested`).expect(200)).body as TimeEntryJson[];
    expect(suggested).toHaveLength(1);
    expect(suggested[0]).toMatchObject({ id, userId: ctx.ownerId, issueId: t.id, source: 'suggested' });
    const length = new Date(suggested[0].endedAt!).getTime() - new Date(suggested[0].startedAt).getTime();
    expect(length).toBe(47 * 60_000);
    await ctx.owner.post(`${ctx.w}/time-entries/stop`).expect(400);
    const timer = (await ctx.owner.post(`${ctx.w}/time-entries/start`, {}).expect(201)).body as TimeEntryJson;
    expect(timer.source).toBe('timer');
    await ctx.owner.post(`${ctx.w}/time-entries/stop`).expect(201);

    // only the owner of the suggestion accepts it; for anyone else it does not exist
    const colleague = await Client.signup(server, 'Sam Colleague');
    await ctx.owner.post(`${ctx.w}/members`, { email: colleague.email, role: 'member' }).expect(201);
    await colleague.client.post(`${ctx.w}/time-entries/${id}/accept`).expect(404);
    await colleague.client.delete(`${ctx.w}/time-entries/${id}`).expect(404);

    const accepted = (await ctx.owner.post(`${ctx.w}/time-entries/${id}/accept`).expect(200)).body as TimeEntryJson;
    expect(accepted).toMatchObject({ id, source: 'manual' });
    const list = (await ctx.owner.get(`${ctx.w}/time-entries`).expect(200)).body as TimeEntryJson[];
    expect(list.map((e) => e.id)).toContain(id);
    expect((await ctx.owner.get(`${ctx.w}/time-entries?source=suggested`).expect(200)).body).toEqual([]);
    await ctx.owner.post(`${ctx.w}/time-entries/${id}/accept`).expect(400);

    // a dismissed suggestion is gone
    const next = (await sync(ctx, t.key, { activeMinutes: 10 }).expect(200)).body as ThreadSyncResult;
    await ctx.owner.delete(`${ctx.w}/time-entries/${next.timeSuggestion!.id}`).expect(204);
    expect((await ctx.owner.get(`${ctx.w}/time-entries?source=suggested`).expect(200)).body).toEqual([]);
  });

  it('suggests points from similar finished tasks', async () => {
    const ctx = await setup();
    const project = (await ctx.owner.post(`${ctx.w}/projects`, { name: 'Identity' }).expect(201)).body as { id: string };
    const elsewhere = (await ctx.owner.post(`${ctx.w}/projects`, { name: 'Billing' }).expect(201)).body as { id: string };
    const done = (title: string, estimate: number, projectId: string) =>
      task(ctx, { title, estimate, projectId, status: 'done' });
    await done('Rotate signing keys', 3, project.id);
    await done('Add session audit log', 5, project.id);
    await done('Expire stale sessions', 5, project.id);
    await done('Invoice rounding', 13, elsewhere.id);
    const target = await task(ctx, { title: 'Alert on token failures', projectId: project.id });

    const res = (await ctx.owner.get(`${ctx.w}/tasks/${target.key}/estimate-suggestion`).expect(200)).body as {
      issueId: string;
      suggestion: number | null;
      scale: number[];
      basis: { key: string; title: string; estimate: number; trackedMinutes: number | null }[];
      reason: string;
    };
    expect(res.issueId).toBe(target.id);
    expect(res.suggestion).toBe(5);
    expect(res.scale).toContain(5);
    expect(res.basis.map((b) => b.title).sort()).toEqual(['Add session audit log', 'Expire stale sessions', 'Rotate signing keys']);
    expect(res.basis.every((b) => b.trackedMinutes === null)).toBe(true);
    expect(res.reason).toContain('Median');

    // too little history: no suggestion, and it says why
    const lonely = await task(ctx, { title: 'Something unrelated entirely' });
    const none = (await ctx.owner.get(`${ctx.w}/tasks/${lonely.key}/estimate-suggestion`).expect(200)).body as {
      suggestion: number | null;
      basis: unknown[];
      reason: string;
    };
    expect(none.suggestion).toBeNull();
    expect(none.basis).toEqual([]);
    expect(none.reason.length).toBeGreaterThan(0);
    await ctx.owner.get(`${ctx.w}/tasks/NOPE-1/estimate-suggestion`).expect(404);
  });

  it('searches decisions and records', async () => {
    const ctx = await setup();
    const t = await task(ctx, { title: 'Quokka migration' });
    await sync(ctx, t.key, {
      summary: 'Moved the wombat tables over',
      decisions: [{ text: 'Keep the wombat index', paths: ['db/'] }],
    }).expect(200);

    const hits = async (q: string, types: string): Promise<SearchHit[]> =>
      ((await ctx.owner.get(`${ctx.w}/search?q=${q}&types=${types}`).expect(200)).body as { results: SearchHit[] }).results;

    const decisions = await hits('wombat', 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ type: 'decision', key: t.key, issueId: t.id, title: 'Keep the wombat index' });

    const records = await hits('wombat', 'record');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'record', id: t.id, key: t.key, issueId: t.id, title: 'Quokka migration' });
    expect(records[0].subtitle).toContain('wombat');

    const both = await hits('wombat', 'decision,record');
    expect(both.map((h) => h.type).sort()).toEqual(['decision', 'record']);
    expect(await hits('wombat', 'issue')).toEqual([]);
    await ctx.owner.get(`${ctx.w}/search?q=wombat&types=nonsense`).expect(400);
  });

  it('follows the task permissions: a viewer reads, a member syncs', async () => {
    const ctx = await setup();
    const t = await task(ctx);
    await sync(ctx, t.key, { summary: 'Done', decisions: [{ text: 'A decision', paths: ['src/'] }] }).expect(200);

    const viewer = await Client.signup(server, 'Vera Viewer');
    await ctx.owner.post(`${ctx.w}/members`, { email: viewer.email, role: 'viewer' }).expect(201);
    expect((await viewer.client.get(`${ctx.w}/tasks/${t.key}/thread`).expect(200)).body.summary).toBe('Done');
    expect((await viewer.client.get(`${ctx.w}/decisions?path=src/a.ts`).expect(200)).body).toHaveLength(1);
    await viewer.client.get(`${ctx.w}/tasks/${t.key}/estimate-suggestion`).expect(200);
    await viewer.client.post(`${ctx.w}/tasks/${t.key}/thread/sync`, { summary: 'No' }).expect(403);

    const member = await Client.signup(server, 'Mia Member');
    await ctx.owner.post(`${ctx.w}/members`, { email: member.email, role: 'member' }).expect(201);
    const res = (await member.client.post(`${ctx.w}/tasks/${t.key}/thread/sync`, { summary: 'Mine' }).expect(200)).body as ThreadSyncResult;
    expect(res.record.lastSyncBy).toMatchObject({ type: 'user', id: member.user.id });
  });

  it('hides the records of a project the caller cannot see', async () => {
    const ctx = await setup();
    const alpha = (await ctx.owner.post(`${ctx.w}/projects`, { name: 'Alpha' }).expect(201)).body as { id: string };
    const beta = (await ctx.owner.post(`${ctx.w}/projects`, { name: 'Beta' }).expect(201)).body as { id: string };
    const secret = await task(ctx, { title: 'Alpha work', projectId: alpha.id });
    await sync(ctx, secret.key, { summary: 'Alpha only', decisions: [{ text: 'Alpha decision', paths: ['src/'] }] }).expect(200);

    const person = await Client.signup(server, 'Ivan Insider');
    await ctx.owner.post(`${ctx.w}/members`, { email: person.email, role: 'member' }).expect(201);
    const rows = (await ctx.owner.get(`${ctx.w}/members`).expect(200)).body as { id: string; userId: string }[];
    const row = rows.find((r) => r.userId === person.user.id)!;
    await ctx.owner
      .patch(`${ctx.w}/members/${row.id}`, {
        access: { projects: { all: false, projectIds: [beta.id] }, includeUnassigned: false, grants: [] },
      })
      .expect(200);

    await person.client.get(`${ctx.w}/tasks/${secret.key}/thread`).expect(404);
    await person.client.get(`${ctx.w}/tasks/${secret.key}/estimate-suggestion`).expect(404);
    await person.client.post(`${ctx.w}/tasks/${secret.key}/thread/sync`, { summary: 'Sneaking in' }).expect(404);
    expect((await person.client.get(`${ctx.w}/decisions?path=src/a.ts`).expect(200)).body).toEqual([]);
    expect((await person.client.get(`${ctx.w}/decisions`).expect(200)).body).toEqual([]);
    await person.client.get(`${ctx.w}/decisions?issue=${secret.key}`).expect(404);
    const found = ((await person.client.get(`${ctx.w}/search?q=Alpha&types=decision,record`).expect(200)).body as { results: unknown[] }).results;
    expect(found).toEqual([]);
  });
});
