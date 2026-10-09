import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

describe('customers', () => {
  let app: INestApplication;
  let owner: Client;
  let slug: string;
  const base = () => `/api/w/${slug}`;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Customer Owner');
    owner = u.client;
    slug = (await owner.post('/api/workspaces', { name: 'Customers Co' }).expect(201)).body.slug;
  });
  afterAll(() => app.close());

  it('creates and updates a customer with a normalized, workspace-unique domain', async () => {
    const created = (await owner.post(`${base()}/customers`, { name: '  Acme  ', domain: 'https://WWW.Acme.com/pricing' }).expect(201)).body;
    expect(created).toMatchObject({ name: 'Acme', domain: 'acme.com' });
    expect(created.id).toMatch(/^cus_/);
    expect(created.createdBy.type).toBe('user');

    await owner.post(`${base()}/customers`, { name: 'Other', domain: 'acme.com' }).expect(409);
    await owner.post(`${base()}/customers`, { name: 'Nope', domain: 'not a domain' }).expect(400);

    const renamed = (await owner.patch(`${base()}/customers/${created.id}`, { name: 'Acme Inc', domain: 'ACME.com' }).expect(200)).body;
    expect(renamed).toMatchObject({ name: 'Acme Inc', domain: 'acme.com' });

    const issue = (await owner.post(`${base()}/issues`, { title: 'Need SSO', kind: 'feature' }).expect(201)).body;
    expect(issue.customerCount).toBe(0);
  });

  it('keeps several domains and company attributes, and configurable tiers', async () => {
    const ws = (await owner.post(`${base()}/customer-tiers`, { name: 'Enterprise' }).expect(201)).body;
    const tier = ws.settings.customerTiers[0];
    const c = (await owner.post(`${base()}/customers`, { name: 'Multi', domains: ['multi.com', 'multi.io'], size: 40, revenue: 1000, tierId: tier.id }).expect(201)).body;
    expect(c).toMatchObject({ domain: 'multi.com', domains: ['multi.com', 'multi.io'], size: 40, revenue: 1000, tierId: tier.id, status: 'active' });
    await owner.post(`${base()}/customers`, { name: 'Clash', domains: ['fresh.com', 'multi.io'] }).expect(409);
    await owner.patch(`${base()}/customers/${c.id}`, { tierId: 'ct_unknown' }).expect(400);
    await owner.delete(`${base()}/customer-tiers/${tier.id}`).expect(200);
    expect((await owner.get(`${base()}/customers/${c.id}`).expect(200)).body.tierId).toBeUndefined();
  });

  it('attaches a request to a project', async () => {
    const customer = (await owner.post(`${base()}/customers`, { name: 'Proj', domain: 'proj.dev' }).expect(201)).body;
    const project = (await owner.post(`${base()}/projects`, { name: 'Onboarding' }).expect(201)).body;
    const req = (await owner.post(`${base()}/customers/${customer.id}/requests`, { projectId: project.id, body: 'Faster setup' }).expect(201)).body;
    expect(req).toMatchObject({ projectId: project.id, project: { name: 'Onboarding' } });
    expect(req.issueId).toBeUndefined();
    expect((await owner.get(`${base()}/customer-requests?projectId=${project.id}`).expect(200)).body).toHaveLength(1);
  });

  it('links a customer to an issue, and unlinking keeps the issue', async () => {
    const customer = (await owner.post(`${base()}/customers`, { name: 'Beta', domain: 'beta.io' }).expect(201)).body;
    const issue = (await owner.post(`${base()}/issues`, { title: 'Export', kind: 'feature' }).expect(201)).body;

    const link = (await owner.post(`${base()}/customers/${customer.id}/requests`, { issueId: issue.id, body: 'Asked in the QBR' }).expect(201)).body;
    expect(link).toMatchObject({ customerId: customer.id, issueId: issue.id, body: 'Asked in the QBR' });
    expect(link.issue).toMatchObject({ id: issue.id, key: issue.key, status: 'backlog', title: 'Export' });

    // several requests from one customer on the same issue are allowed; the customer counts once
    const second = (await owner.post(`${base()}/customers/${customer.id}/requests`, { issueId: issue.id, body: 'Again', important: true, sourceUrl: 'https://beta.example/ticket/1' }).expect(201)).body;
    expect(second).toMatchObject({ important: true, sourceUrl: 'https://beta.example/ticket/1' });
    const requests = (await owner.get(`${base()}/customers/${customer.id}/requests`).expect(200)).body;
    expect(requests).toHaveLength(2);
    const edited = (await owner.patch(`${base()}/customers/${customer.id}/requests/${second.id}`, { body: 'Edited', important: false }).expect(200)).body;
    expect(edited).toMatchObject({ body: 'Edited', important: false });
    await owner.post(`${base()}/customers/${customer.id}/requests`, {}).expect(400);
    await owner.post(`${base()}/customers/${customer.id}/requests`, { issueId: issue.id, sourceUrl: 'javascript:alert(1)' }).expect(400);
    await owner.post(`${base()}/customers/${customer.id}/requests/${second.id}/unlink`).expect(204);

    const listed = (await owner.get(`${base()}/issues?customerId=${customer.id}`).expect(200)).body;
    expect(listed.map((i: { id: string }) => i.id)).toEqual([issue.id]);
    expect(listed[0].customerCount).toBe(1);
    expect((await owner.get(`${base()}/issues/${issue.key}`).expect(200)).body.customerCount).toBe(1);

    const other = (await owner.post(`${base()}/issues`, { title: 'Alone', kind: 'bug' }).expect(201)).body;
    expect((await owner.get(`${base()}/issues?minCustomers=1`).expect(200)).body.map((i: { id: string }) => i.id)).toContain(issue.id);
    expect((await owner.get(`${base()}/issues?minCustomers=1`).expect(200)).body.map((i: { id: string }) => i.id)).not.toContain(other.id);

    await owner.post(`${base()}/customers/${customer.id}/requests/${link.id}/unlink`).expect(204);
    expect((await owner.get(`${base()}/customers/${customer.id}/requests`).expect(200)).body).toEqual([]);
    expect((await owner.get(`${base()}/issues/${issue.key}`).expect(200)).body).toMatchObject({ id: issue.id, title: 'Export', customerCount: 0 });
  });

  it('does not leak customers across workspaces', async () => {
    const customer = (await owner.post(`${base()}/customers`, { name: 'Gamma', domain: 'gamma.dev' }).expect(201)).body;
    const issue = (await owner.post(`${base()}/issues`, { title: 'Here', kind: 'bug' }).expect(201)).body;

    const other = await Client.signup(app.getHttpServer(), 'Other Owner');
    const otherSlug = (await other.client.post('/api/workspaces', { name: 'Elsewhere' }).expect(201)).body.slug;
    const otherBase = `/api/w/${otherSlug}`;
    const foreignIssue = (await other.client.post(`${otherBase}/issues`, { title: 'There', kind: 'bug' }).expect(201)).body;

    await other.client.get(`${otherBase}/customers/${customer.id}`).expect(404);
    await other.client.get(`${base()}/customers`).expect(404);
    expect((await other.client.get(`${otherBase}/customers`).expect(200)).body).toEqual([]);
    await owner.post(`${base()}/customers/${customer.id}/requests`, { issueId: foreignIssue.id }).expect(404);
    await other.client.post(`${otherBase}/customers/${customer.id}/requests`, { issueId: issue.id }).expect(404);

    const snap = (await owner.get(`${base()}/snapshot`).expect(200)).body;
    expect(snap.customers.map((c: { id: string }) => c.id)).toContain(customer.id);
    expect(snap.customers.every((c: { workspaceId: string }) => c.workspaceId === snap.workspace.id)).toBe(true);
  });

  it('follows role and token permissions', async () => {
    const viewer = await Client.signup(app.getHttpServer(), 'Viewer');
    await owner.post(`${base()}/members`, { email: viewer.email, role: 'viewer' }).expect(201);
    await viewer.client.get(`${base()}/customers`).expect(200);
    await viewer.client.post(`${base()}/customers`, { name: 'Nope', domain: 'nope.com' }).expect(403);

    const read = (await owner.post(`${base()}/tokens`, { name: 'read', permissions: ['customers:read'] }).expect(201)).body;
    const asRead = new TokenClient(app.getHttpServer(), read.secret);
    await asRead.get(`${base()}/customers`).expect(200);
    await asRead.post(`${base()}/customers`, { name: 'Token', domain: 'token.com' }).expect(403);

    const issuesOnly = (await owner.post(`${base()}/tokens`, { name: 'issues', permissions: ['issues:read'] }).expect(201)).body;
    await new TokenClient(app.getHttpServer(), issuesOnly.secret).get(`${base()}/customers`).expect(403);

    const write = (await owner.post(`${base()}/tokens`, { name: 'write', permissions: ['customers:write', 'issues:read'] }).expect(201)).body;
    const asWrite = new TokenClient(app.getHttpServer(), write.secret);
    const customer = (await asWrite.post(`${base()}/customers`, { name: 'Token Co', domain: 'token.co' }).expect(201)).body;
    await asWrite.delete(`${base()}/customers/${customer.id}`).expect(403);
  });

  it('archive keeps links and issues; delete removes links only', async () => {
    const customer = (await owner.post(`${base()}/customers`, { name: 'Delta', domain: 'delta.example' }).expect(201)).body;
    const issue = (await owner.post(`${base()}/issues`, { title: 'Keep me', kind: 'idea' }).expect(201)).body;
    await owner.post(`${base()}/customers/${customer.id}/requests`, { issueId: issue.id }).expect(201);

    const archived = (await owner.patch(`${base()}/customers/${customer.id}`, { archived: true }).expect(200)).body;
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect((await owner.get(`${base()}/customers`).expect(200)).body.map((c: { id: string }) => c.id)).not.toContain(customer.id);
    expect((await owner.get(`${base()}/customers?archived=all`).expect(200)).body.map((c: { id: string }) => c.id)).toContain(customer.id);
    expect((await owner.get(`${base()}/customers/${customer.id}/requests`).expect(200)).body).toHaveLength(1);
    expect((await owner.get(`${base()}/issues/${issue.key}`).expect(200)).body.customerCount).toBe(1);

    const restored = (await owner.patch(`${base()}/customers/${customer.id}`, { archived: false }).expect(200)).body;
    expect(restored.archivedAt).toBeUndefined();

    await owner.delete(`${base()}/customers/${customer.id}`).expect(204);
    await owner.get(`${base()}/customers/${customer.id}`).expect(404);
    expect((await owner.get(`${base()}/customers/${customer.id}/requests`).expect(404)).body).toBeTruthy();
    const kept = (await owner.get(`${base()}/issues/${issue.key}`).expect(200)).body;
    expect(kept).toMatchObject({ id: issue.id, title: 'Keep me', customerCount: 0 });
    const snap = (await owner.get(`${base()}/snapshot`).expect(200)).body;
    expect(snap.customerRequests.filter((r: { customerId: string }) => r.customerId === customer.id)).toEqual([]);
    expect(snap.issues.map((i: { id: string }) => i.id)).toContain(issue.id);

    const keptCustomer = (await owner.post(`${base()}/customers`, { name: 'Still here', domain: 'still.example' }).expect(201)).body;
    const doomed = (await owner.post(`${base()}/issues`, { title: 'Doomed', kind: 'bug' }).expect(201)).body;
    await owner.post(`${base()}/customers/${keptCustomer.id}/requests`, { issueId: doomed.id }).expect(201);
    await owner.delete(`${base()}/issues/${doomed.key}`).expect(204);
    expect((await owner.get(`${base()}/customers/${keptCustomer.id}`).expect(200)).body.name).toBe('Still here');
    expect((await owner.get(`${base()}/customers/${keptCustomer.id}/requests`).expect(200)).body).toEqual([]);
  });
});
