import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('task due date', () => {
  let app: INestApplication;
  let c: Client;
  let w: string;

  beforeAll(async () => {
    app = await createTestApp();
    c = (await Client.signup(app.getHttpServer(), 'Due Date User')).client;
    const workspace = (await c.post('/api/workspaces', { name: 'Due Date Workspace' }).expect(201)).body;
    w = `/api/w/${workspace.slug}`;
  });

  afterAll(() => app.close());

  it('stores the due date on create and PATCH, keeps it on other edits, and clears it with null', async () => {
    const task = (await c.post(`${w}/tasks`, { kind: 'bug', title: 'Ship it', dueDate: '2026-12-02' }).expect(201)).body;
    expect(task.dueDate).toBe('2026-12-02T00:00:00.000Z');

    const other = (await c.post(`${w}/tasks`, { kind: 'bug', title: 'Someday' }).expect(201)).body;
    expect(other.dueDate).toBeUndefined();

    const next = '2026-12-05T00:00:00.000Z';
    expect((await c.patch(`${w}/tasks/${task.key}`, { dueDate: next }).expect(200)).body.dueDate).toBe(next);
    expect((await c.get(`${w}/snapshot`).expect(200)).body.issues.find((i: { id: string }) => i.id === task.id).dueDate).toBe(next);
    expect((await c.patch(`${w}/tasks/${task.key}`, { title: 'Ship it now' }).expect(200)).body.dueDate).toBe(next);

    const cleared = (await c.patch(`${w}/tasks/${task.key}`, { dueDate: null }).expect(200)).body;
    expect(cleared.dueDate).toBeUndefined();
  });

  it('rejects values that are not ISO 8601 dates', async () => {
    const task = (await c.post(`${w}/tasks`, { kind: 'bug', title: 'Validation' }).expect(201)).body;
    for (const dueDate of ['tomorrow', '12/02/2026', '', 42]) {
      await c.post(`${w}/tasks`, { kind: 'bug', title: 'Bad', dueDate }).expect(400);
      await c.patch(`${w}/tasks/${task.key}`, { dueDate }).expect(400);
    }
  });
});
