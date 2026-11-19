import { DataSource } from 'typeorm';
import pg from 'pg';
import { MIGRATIONS } from '../src/database/migrations/index.js';
import { RemoveProjectUpdatesDocumentsContext1793870000000 } from '../src/database/migrations/1793870000000-RemoveProjectUpdatesDocumentsContext.js';
import { TEST_DATABASE_URL } from './global-setup.js';

describe('RemoveProjectUpdatesDocumentsContext migration', () => {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = `${decodeURIComponent(url.pathname.slice(1))}_rm_features`;
  url.pathname = `/${dbName}`;
  const user = { type: 'user', id: 'u1', name: 'User' };
  let ds: DataSource;

  async function insert(table: string, values: Record<string, unknown>) {
    const cols = await ds.query<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
      [table],
    );
    const dummy = (type: string) =>
      type === 'jsonb'
        ? '[]'
        : type === 'boolean'
          ? false
          : /int|double|numeric/.test(type)
            ? 0
            : /timestamp/.test(type)
              ? new Date()
              : 'x';
    const row: Record<string, unknown> = {};
    for (const column of cols)
      row[column.column_name] = dummy(column.data_type);
    Object.assign(row, values);
    const keys = Object.keys(row);
    await ds.query(
      `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(', ')})
       VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
      keys.map((key) =>
        row[key] !== null &&
        typeof row[key] === 'object' &&
        !(row[key] instanceof Date)
          ? JSON.stringify(row[key])
          : row[key],
      ),
    );
  }

  const ids = async (sql: string) =>
    (await ds.query<{ id: string }[]>(sql)).map((row) => row.id);
  const count = async (sql: string) =>
    (await ds.query<{ count: number }[]>(sql))[0].count;

  beforeAll(async () => {
    const admin = new pg.Client({
      connectionString: TEST_DATABASE_URL.replace(/\/[^/]*$/, '/postgres'),
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    ds = new DataSource({
      type: 'postgres',
      url: url.toString(),
      migrations: MIGRATIONS.slice(
        0,
        MIGRATIONS.indexOf(RemoveProjectUpdatesDocumentsContext1793870000000),
      ),
      migrationsRun: false,
    });
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.destroy();
    const admin = new pg.Client({
      connectionString: TEST_DATABASE_URL.replace(/\/[^/]*$/, '/postgres'),
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  it('purges removed features and keeps tasks and their git artifacts', async () => {
    const roles = [
      {
        id: 'owner',
        name: 'Owner',
        owner: true,
        capabilities: [],
        grants: ['issues:view', 'documents:view', 'documents:update'],
      },
    ];
    await insert('users', { id: 'u1', email: 'rm@test.dev' });
    await insert('workspaces', {
      id: 'w1',
      slug: 'rm',
      settings: { roles, labels: [] },
    });
    await insert('memberships', {
      id: 'm1',
      workspaceId: 'w1',
      userId: 'u1',
      role: 'owner',
      access: {
        projects: { all: true, projectIds: [] },
        includeUnassigned: true,
        grants: ['comments:update', 'documents:create'],
      },
    });
    await insert('projects', {
      id: 'pj_1',
      workspaceId: 'w1',
      name: 'Project',
      key: 'PRJ',
      health: 'at_risk',
      lastUpdateAt: new Date(),
    });
    await insert('issues', {
      id: 'in_1',
      workspaceId: 'w1',
      key: 'PRJ-1',
      number: 1,
      kind: 'bug',
      title: 'With goal and PR',
      projectId: 'pj_1',
      goal: 'Ship it',
    });
    await insert('issues', {
      id: 'in_2',
      workspaceId: 'w1',
      key: 'PRJ-2',
      number: 2,
      kind: 'feature',
      title: 'Plain task',
      projectId: 'pj_1',
    });
    await insert('project_updates', {
      id: 'pu_1',
      workspaceId: 'w1',
      projectId: 'pj_1',
      health: 'on_track',
      body: 'All good',
      author: user,
    });
    await insert('documents', {
      id: 'doc_1',
      workspaceId: 'w1',
      title: 'Spec',
      body: 'See /uploads/upl_docfile00001',
      author: user,
      lastEditor: user,
    });
    await insert('document_revisions', {
      id: 'rev_1',
      workspaceId: 'w1',
      documentId: 'doc_1',
      version: 1,
      title: 'Spec',
      body: 'old',
      editor: user,
    });
    for (const [id, name] of [
      ['upl_docfile00001', 'doc.png'],
      ['upl_projfile0001', 'proj.png'],
      ['upl_taskfile0001', 'task.png'],
    ])
      await insert('uploads', {
        id,
        workspaceId: 'w1',
        filename: name,
        contentType: 'image/png',
        byteSize: 1,
        bytes: Buffer.from('x'),
        referenced: true,
        createdBy: user,
      });
    // Task-level PR (kept), task artifact that also names the project (kept),
    // project-only artifact (purged), artifact pointing at a document (purged).
    await insert('artifacts', {
      id: 'ar_pr',
      workspaceId: 'w1',
      issueId: 'in_1',
      kind: 'pull_request',
      title: 'Fix',
      review: 'requested',
      ci: 'failing',
    });
    await insert('artifacts', {
      id: 'ar_both',
      workspaceId: 'w1',
      issueId: 'in_1',
      projectId: 'pj_1',
      kind: 'link',
      title: 'Both owners',
    });
    await insert('artifacts', {
      id: 'ar_task_file',
      workspaceId: 'w1',
      issueId: 'in_2',
      kind: 'file',
      title: 'task.png',
      uploadId: 'upl_taskfile0001',
    });
    await insert('artifacts', {
      id: 'ar_proj',
      workspaceId: 'w1',
      projectId: 'pj_1',
      kind: 'file',
      title: 'proj.png',
      uploadId: 'upl_projfile0001',
    });
    await insert('artifacts', {
      id: 'ar_doc',
      workspaceId: 'w1',
      issueId: 'in_2',
      kind: 'document',
      title: 'Spec',
      documentId: 'doc_1',
    });
    await insert('artifact_sources', {
      artifactId: 'ar_pr',
      workspaceId: 'w1',
      headSha: 'abc',
    });
    await insert('artifact_sources', {
      artifactId: 'ar_proj',
      workspaceId: 'w1',
      headSha: 'def',
    });
    for (const [uploadId, subjectType, subjectId] of [
      ['upl_docfile00001', 'document', 'doc_1'],
      ['upl_projfile0001', 'artifact', 'ar_proj'],
      ['upl_taskfile0001', 'artifact', 'ar_task_file'],
    ])
      await insert('upload_references', {
        workspaceId: 'w1',
        uploadId,
        subjectType,
        subjectId,
      });
    for (const [id, subject] of [
      ['cm_update', { type: 'project_update', id: 'pu_1' }],
      ['cm_doc', { type: 'document', id: 'doc_1' }],
      ['cm_proj_artifact', { type: 'artifact', id: 'ar_proj' }],
      ['cm_pr', { type: 'artifact', id: 'ar_pr' }],
      ['cm_issue', { type: 'issue', id: 'in_1' }],
      ['cm_project', { type: 'project', id: 'pj_1' }],
    ] as const)
      await insert('comments', {
        id,
        workspaceId: 'w1',
        subject,
        author: user,
        body: id,
      });
    for (const [id, type, subject] of [
      ['ev_update', 'project_update.created', { type: 'project_update', id: 'pu_1' }],
      ['ev_doc', 'document.updated', { type: 'document', id: 'doc_1' }],
      ['ev_proj_artifact', 'artifact.attached', { type: 'artifact', id: 'ar_proj' }],
      ['ev_pr', 'artifact.attached', { type: 'artifact', id: 'ar_pr' }],
      ['ev_issue', 'issue.created', { type: 'issue', id: 'in_1' }],
    ] as const)
      await insert('domain_events', {
        id,
        workspaceId: 'w1',
        actor: user,
        type,
        subject,
      });
    for (const [id, targetId, type] of [
      ['fv_doc', 'doc_1', 'document'],
      ['fv_issue', 'in_1', 'issue'],
    ])
      await insert('favorites', {
        id,
        workspaceId: 'w1',
        userId: 'u1',
        type,
        subjectId: targetId,
      });
    for (const [id, subject] of [
      ['nt_update', { type: 'project_update', id: 'pu_1' }],
      ['nt_doc', { type: 'document', id: 'doc_1' }],
      ['nt_pr', { type: 'artifact', id: 'ar_pr' }],
    ] as const)
      await insert('notifications', {
        id,
        workspaceId: 'w1',
        userId: 'u1',
        kind: 'comment',
        title: id,
        actor: user,
        subject,
        link: 'x',
      });
    await insert('dependencies', {
      id: 'dep_doc',
      workspaceId: 'w1',
      fromType: 'issue',
      fromId: 'in_1',
      toType: 'document',
      toId: 'doc_1',
    });
    await insert('dependencies', {
      id: 'dep_issue',
      workspaceId: 'w1',
      fromType: 'issue',
      fromId: 'in_1',
      toType: 'issue',
      toId: 'in_2',
    });
    for (const itemId of ['ci_failed:ar_pr', 'review_requested:ar_proj'])
      await insert('attention_state', {
        userId: 'u1',
        workspaceId: 'w1',
        itemId,
        state: 'dismissed',
        since: new Date(),
      });
    await insert('saved_views', {
      id: 'vw_health',
      workspaceId: 'w1',
      ownerId: 'u1',
      name: 'By health',
      entity: 'project',
      filters: [
        { field: 'health', op: 'is', value: 'at_risk' },
        { field: 'status', op: 'is', value: 'in_progress' },
      ],
      sort: { field: 'health', direction: 'asc' },
      groupBy: 'health',
    });
    await insert('api_tokens', {
      id: 'tk_1',
      workspaceId: 'w1',
      name: 'custom',
      tokenHash: 'hash-1',
      scope: 'custom',
      permissions: ['tasks:read', 'documents:write', 'artifacts:read'],
    });
    await insert('outgoing_webhooks', {
      id: 'wh_mixed',
      workspaceId: 'w1',
      name: 'mixed',
      url: 'https://example.test/a',
      secret: 'x',
      events: ['issue.created', 'document.*', 'project_update.created'],
    });
    await insert('outgoing_webhooks', {
      id: 'wh_only',
      workspaceId: 'w1',
      name: 'only removed',
      url: 'https://example.test/b',
      secret: 'x',
      events: ['document.created'],
    });
    for (const [id, event] of [
      ['wd_1', 'document.created'],
      ['wd_2', 'issue.created'],
    ])
      await insert('outgoing_webhook_deliveries', {
        id,
        webhookId: 'wh_mixed',
        event,
      });

    const issuesBefore = await ds.query(
      `SELECT id, key, "projectId", title FROM issues ORDER BY id`,
    );

    await new RemoveProjectUpdatesDocumentsContext1793870000000().up(
      ds.createQueryRunner(),
    );

    // Tasks are untouched; the goal column is gone.
    expect(
      await ds.query(
        `SELECT id, key, "projectId", title FROM issues ORDER BY id`,
      ),
    ).toEqual(issuesBefore);
    expect(
      await count(
        `SELECT count(*)::int AS count FROM information_schema.columns
         WHERE (table_name = 'issues' AND column_name = 'goal')
            OR (table_name = 'projects' AND column_name = 'lastUpdateAt')
            OR (table_name = 'artifacts' AND column_name IN ('projectId', 'documentId'))`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS count FROM information_schema.tables
         WHERE table_name IN ('project_updates', 'documents', 'document_revisions')`,
      ),
    ).toBe(0);

    // Task artifacts stay (with their git sources); project-only and document artifacts go.
    expect(await ids(`SELECT id FROM artifacts ORDER BY id`)).toEqual([
      'ar_both',
      'ar_pr',
      'ar_task_file',
    ]);
    expect(
      await ds.query(`SELECT "artifactId" FROM artifact_sources`),
    ).toEqual([{ artifactId: 'ar_pr' }]);
    expect(
      await ds.query(`SELECT ci, review FROM artifacts WHERE id = 'ar_pr'`),
    ).toEqual([{ ci: 'failing', review: 'requested' }]);

    // Rows pointing at removed subjects are purged; the rest stays.
    expect(await ids(`SELECT id FROM comments ORDER BY id`)).toEqual([
      'cm_issue',
      'cm_pr',
      'cm_project',
    ]);
    expect(await ids(`SELECT id FROM domain_events ORDER BY id`)).toEqual([
      'ev_issue',
      'ev_pr',
    ]);
    expect(await ids(`SELECT id FROM favorites`)).toEqual(['fv_issue']);
    expect(await ids(`SELECT id FROM notifications`)).toEqual(['nt_pr']);
    expect(await ids(`SELECT id FROM dependencies`)).toEqual(['dep_issue']);
    expect(await ds.query(`SELECT "itemId" FROM attention_state`)).toEqual([
      { itemId: 'ci_failed:ar_pr' },
    ]);

    // Uploads: only the task file is still mentioned.
    expect(await ids(`SELECT id FROM uploads`)).toEqual(['upl_taskfile0001']);
    expect(
      await ds.query(
        `SELECT "subjectType", "subjectId" FROM upload_references`,
      ),
    ).toEqual([{ subjectType: 'artifact', subjectId: 'ar_task_file' }]);

    // Views, permissions, grants and webhook subscriptions.
    expect(
      await ds.query(
        `SELECT filters, sort, "groupBy" FROM saved_views WHERE id = 'vw_health'`,
      ),
    ).toEqual([
      {
        filters: [
          { field: 'health', op: 'is', value: 'at_risk' },
          { field: 'status', op: 'is', value: 'in_progress' },
        ],
        sort: { field: 'health', direction: 'asc' },
        groupBy: 'health',
      },
    ]);
    // Health is a manual field now: the column and its value stay.
    expect(
      await ds.query(`SELECT health FROM projects WHERE id = 'pj_1'`),
    ).toEqual([{ health: 'at_risk' }]);
    expect(
      await ds.query(`SELECT permissions FROM api_tokens WHERE id = 'tk_1'`),
    ).toEqual([{ permissions: ['tasks:read', 'artifacts:read'] }]);
    expect(
      (await ds.query(`SELECT settings FROM workspaces WHERE id = 'w1'`))[0]
        .settings.roles[0].grants,
    ).toEqual(['issues:view']);
    expect(
      await ds.query(`SELECT access FROM memberships WHERE id = 'm1'`),
    ).toEqual([
      {
        access: {
          projects: { all: true, projectIds: [] },
          includeUnassigned: true,
          grants: ['comments:update'],
        },
      },
    ]);
    expect(
      await ds.query(
        `SELECT id, events, enabled FROM outgoing_webhooks ORDER BY id`,
      ),
    ).toEqual([
      { id: 'wh_mixed', events: ['issue.created'], enabled: true },
      { id: 'wh_only', events: [], enabled: false },
    ]);
    expect(await ids(`SELECT id FROM outgoing_webhook_deliveries`)).toEqual([
      'wd_2',
    ]);

    // The orphan guard still protects task artifacts.
    await ds.query(`DELETE FROM issues WHERE id = 'in_2'`);
    expect(await ids(`SELECT id FROM artifacts ORDER BY id`)).toEqual([
      'ar_both',
      'ar_pr',
    ]);
  });
});
