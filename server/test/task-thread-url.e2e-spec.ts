import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('task thread link', () => {
  let app: INestApplication;
  let c: Client;
  let w: string;

  beforeAll(async () => {
    app = await createTestApp();
    c = (await Client.signup(app.getHttpServer(), 'Thread Link User')).client;
    const workspace = (await c.post('/api/workspaces', { name: 'Thread Link Workspace' }).expect(201)).body;
    w = `/api/w/${workspace.slug}`;
  });

  afterAll(() => app.close());

  it('stores an http(s) URL on create and PATCH, returns it, and clears it with null', async () => {
    const url = 'https://delta.dev/t/login-loop-1f2e';
    const task = (await c.post(`${w}/tasks`, { kind: 'bug', title: 'Login loops', threadUrl: url }).expect(201)).body;
    expect(task.threadUrl).toBe(url);

    const other = (await c.post(`${w}/tasks`, { kind: 'bug', title: 'No thread' }).expect(201)).body;
    expect(other.threadUrl).toBeUndefined();

    const next = 'http://localhost:4300/t/abc?x=1#top';
    expect((await c.patch(`${w}/tasks/${task.key}`, { threadUrl: next }).expect(200)).body.threadUrl).toBe(next);
    expect((await c.get(`${w}/tasks/${task.key}`).expect(200)).body.threadUrl).toBe(next);
    expect((await c.get(`${w}/snapshot`).expect(200)).body.issues.find((i: { id: string }) => i.id === task.id).threadUrl).toBe(next);

    expect((await c.patch(`${w}/tasks/${task.key}`, { title: 'Login loops again' }).expect(200)).body.threadUrl).toBe(next);
    const cleared = (await c.patch(`${w}/tasks/${task.key}`, { threadUrl: null }).expect(200)).body;
    expect(cleared.threadUrl).toBeUndefined();
  });

  it('rejects other schemes, non-URLs, padding and anything over 2048 characters', async () => {
    const task = (await c.post(`${w}/tasks`, { kind: 'bug', title: 'Validation' }).expect(201)).body;
    const bad = [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'ftp://delta.dev/t/1',
      'file:///etc/passwd',
      'delta.dev/t/1',
      ' https://delta.dev/t/1',
      'https://',
      '',
      `https://delta.dev/${'a'.repeat(2048)}`,
    ];
    for (const threadUrl of bad) {
      await c.post(`${w}/tasks`, { kind: 'bug', title: 'Bad', threadUrl }).expect(400);
      await c.patch(`${w}/tasks/${task.key}`, { threadUrl }).expect(400);
    }
    await c.patch(`${w}/tasks/${task.key}`, { threadUrl: 12 }).expect(400);
    const longest = `https://delta.dev/${'a'.repeat(2048 - 'https://delta.dev/'.length)}`;
    expect(longest).toHaveLength(2048);
    expect((await c.patch(`${w}/tasks/${task.key}`, { threadUrl: longest }).expect(200)).body.threadUrl).toBe(longest);
  });

  it('puts the thread in the task markdown for agents', async () => {
    const url = 'https://delta.dev/t/briefing-77aa';
    const task = (await c.post(`${w}/tasks`, { kind: 'feature', title: 'Briefing', threadUrl: url }).expect(201)).body;
    const md = await c.get(`${w}/tasks/${task.key}/context?format=markdown`).expect(200);
    expect(md.text).toContain(`Thread: ${url}`);
    const json = (await c.get(`${w}/tasks/${task.key}/context?format=json`).expect(200)).body;
    expect(json.issue.threadUrl).toBe(url);
  });
});
