import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('issue sub-issues', () => {
  let app: INestApplication;
  let c: Client;
  let w: string;
  let otherW: string;

  beforeAll(async () => {
    app = await createTestApp();
    c = (await Client.signup(app.getHttpServer(), 'Issue Parent User')).client;
    const workspace = (
      await c.post('/api/workspaces', { name: 'Issue Parent Workspace' }).expect(201)
    ).body;
    const otherWorkspace = (
      await c.post('/api/workspaces', { name: 'Other Issue Parent Workspace' }).expect(201)
    ).body;
    w = `/api/w/${workspace.slug}`;
    otherW = `/api/w/${otherWorkspace.slug}`;
  });

  afterAll(() => app.close());

  it('supports arbitrary nesting with flat parent IDs and independent statuses', async () => {
    const root = (
      await c.post(`${w}/issues`, {
        kind: 'feature',
        title: 'Root issue',
        status: 'done',
      }).expect(201)
    ).body;
    const child = (
      await c.post(`${w}/issues`, {
        kind: 'bug',
        title: 'Child issue',
        parentId: root.id,
      }).expect(201)
    ).body;
    const grandchild = (
      await c.post(`${w}/issues`, {
        kind: 'tech_debt',
        title: 'Grandchild issue',
        parentId: child.key,
      }).expect(201)
    ).body;

    expect(child).toMatchObject({ parentId: root.id, status: 'backlog' });
    expect(grandchild).toMatchObject({ parentId: child.id, status: 'backlog' });
    const snapshot = (await c.get(`${w}/snapshot`).expect(200)).body;
    const snapshotGrandchild = snapshot.issues.find(
      (issue: { id: string }) => issue.id === grandchild.id,
    );
    expect(snapshotGrandchild).toMatchObject({ parentId: child.id });
    expect(snapshotGrandchild).not.toHaveProperty('children');
  });

  it('allows reparenting and clearing, and rejects self-parenting and ancestor cycles', async () => {
    const root = (
      await c.post(`${w}/issues`, { kind: 'feature', title: 'Cycle root' }).expect(201)
    ).body;
    const otherRoot = (
      await c.post(`${w}/issues`, { kind: 'feature', title: 'Alternate root' }).expect(201)
    ).body;
    const child = (
      await c.post(`${w}/issues`, {
        kind: 'bug',
        title: 'Cycle child',
        parentId: root.id,
      }).expect(201)
    ).body;
    const grandchild = (
      await c.post(`${w}/issues`, {
        kind: 'bug',
        title: 'Cycle grandchild',
        parentId: child.id,
      }).expect(201)
    ).body;

    await c.patch(`${w}/issues/${child.id}`, { parentId: child.id }).expect(400);
    await c.patch(`${w}/issues/${root.id}`, { parentId: grandchild.id }).expect(400);
    expect((await c.get(`${w}/issues/${child.id}`).expect(200)).body.parentId).toBe(root.id);

    const moved = (
      await c.patch(`${w}/issues/${child.id}`, { parentId: otherRoot.key }).expect(200)
    ).body;
    expect(moved.parentId).toBe(otherRoot.id);
    const cleared = (
      await c.patch(`${w}/issues/${child.id}`, { parentId: null }).expect(200)
    ).body;
    expect(cleared).not.toHaveProperty('parentId');
    expect((await c.get(`${w}/issues/${grandchild.id}`).expect(200)).body.parentId).toBe(
      child.id,
    );
  });

  it('keeps children when their parent is deleted and rejects cross-workspace links', async () => {
    const parent = (
      await c.post(`${w}/issues`, { kind: 'feature', title: 'Deleted parent' }).expect(201)
    ).body;
    const child = (
      await c.post(`${w}/issues`, {
        kind: 'bug',
        title: 'Surviving child',
        parentId: parent.id,
      }).expect(201)
    ).body;
    await c.delete(`${w}/issues/${parent.id}`).expect(204);
    const surviving = (await c.get(`${w}/issues/${child.id}`).expect(200)).body;
    expect(surviving.id).toBe(child.id);
    expect(surviving).not.toHaveProperty('parentId');

    const foreignParent = (
      await c.post(`${otherW}/issues`, {
        kind: 'feature',
        title: 'Foreign parent',
      }).expect(201)
    ).body;
    await c
      .post(`${w}/issues`, {
        kind: 'bug',
        title: 'Cross-workspace child',
        parentId: foreignParent.id,
      })
      .expect(404);
    await c.patch(`${w}/issues/${child.id}`, { parentId: foreignParent.id }).expect(404);
  });
});
