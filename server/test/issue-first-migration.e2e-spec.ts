import { DataSource } from 'typeorm';
import pg from 'pg';
import { MIGRATIONS } from '../src/database/migrations/index.js';
import { IssueFirst1793740000000 } from '../src/database/migrations/1793740000000-IssueFirst.js';
import { RemoveWorkstreams1793750000000 } from '../src/database/migrations/1793750000000-RemoveWorkstreams.js';
import { TEST_DATABASE_URL } from './global-setup.js';

describe('IssueFirst migration', () => {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = `${decodeURIComponent(url.pathname.slice(1))}_issue_first`;
  url.pathname = `/${dbName}`;
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
        MIGRATIONS.indexOf(IssueFirst1793740000000),
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

  it('keeps legacy human input, decisions, artifacts, comments and events unlinked with provenance', async () => {
    await insert('users', { id: 'u1', email: 'issue-first@test.dev' });
    await insert('workspaces', { id: 'w1', slug: 'issue-first' });
    await insert('teams', { id: 't1', workspaceId: 'w1', key: 'AUTH' });
    await insert('workstreams', {
      id: 'wk_1',
      workspaceId: 'w1',
      key: 'AUTH-1',
      title: 'Legacy stream',
      objective: 'One issue objective',
      ownerTeamId: 't1',
      createdById: 'u1',
      acceptanceCriteria: [{ id: 'cr_1', text: 'Keep the proof', state: 'pending' }],
    });
    await insert('workstreams', {
      id: 'wk_2',
      workspaceId: 'w1',
      key: 'AUTH-2',
      title: 'Another legacy stream',
      objective: 'Preserve multi-linked objective',
      ownerTeamId: 't1',
      createdById: 'u1',
    });
    await insert('workstreams', {
      id: 'wk_3',
      workspaceId: 'w1',
      key: 'AUTH-3',
      title: 'Unlinked legacy stream',
      objective: 'Preserve unlinked objective',
      ownerTeamId: 't1',
      createdById: 'u1',
    });
    await insert('workstreams', {
      id: 'wk_4',
      workspaceId: 'w1',
      key: 'AUTH-4',
      title: 'Uniquely linked legacy stream',
      objective: 'One unambiguous issue objective',
      ownerTeamId: 't1',
      createdById: 'u1',
    });
    await insert('dependencies', {
      id: 'dep_1',
      workspaceId: 'w1',
      fromType: 'workstream',
      fromId: 'wk_1',
      toType: 'workstream',
      toId: 'wk_2',
    });
    await insert('issues', {
      id: 'in_one',
      workspaceId: 'w1',
      key: 'BUG-1',
      number: 1,
      kind: 'bug',
      title: 'One issue',
      workstreamIds: ['wk_1'],
    });
    await insert('issues', {
      id: 'in_many',
      workspaceId: 'w1',
      key: 'BUG-2',
      number: 2,
      kind: 'bug',
      title: 'Several links',
      workstreamIds: ['wk_1', 'wk_2'],
    });
    await insert('issues', {
      id: 'in_unique',
      workspaceId: 'w1',
      key: 'BUG-3',
      number: 3,
      kind: 'bug',
      title: 'Unique link',
      workstreamIds: ['wk_4'],
    });
    await insert('input_requests', {
      id: 'ir_1',
      workspaceId: 'w1',
      workstreamId: 'wk_1',
      question: 'Legacy question',
      requestedBy: { type: 'agent', id: 'a1', name: 'Agent' },
    });
    await insert('decisions', {
      id: 'dc_1',
      workspaceId: 'w1',
      key: 'ADR-1',
      number: 1,
      title: 'Legacy decision',
      statement: 'Preserve me',
      originWorkstreamId: 'wk_1',
      relatedWorkstreamIds: ['wk_2'],
      proposedBy: { type: 'agent', id: 'a1', name: 'Agent' },
    });
    await insert('artifacts', {
      id: 'ar_1',
      workspaceId: 'w1',
      workstreamId: 'wk_1',
      kind: 'link',
      title: 'Legacy artifact',
    });
    await insert('comments', {
      id: 'cm_1',
      workspaceId: 'w1',
      subject: { type: 'artifact', id: 'ar_1' },
      author: { type: 'user', id: 'u1', name: 'User' },
      body: 'Keep this comment',
    });
    await insert('domain_events', {
      id: 'ev_1',
      workspaceId: 'w1',
      actor: { type: 'user', id: 'u1', name: 'User' },
      type: 'legacy.event',
      subject: { type: 'artifact', id: 'ar_1' },
      workstreamId: 'wk_1',
    });
    await insert('saved_views', {
      id: 'vw_1',
      workspaceId: 'w1',
      ownerId: 'u1',
      name: 'Legacy graph view',
      entity: 'workstream',
      layout: 'graph',
    });

    const runner = ds.createQueryRunner();
    await new IssueFirst1793740000000().up(runner);
    await runner.release();

    expect(
      await ds.query(
        `SELECT "issueId", "legacyWorkstreamKey" FROM input_requests WHERE id = 'ir_1'`,
      ),
    ).toEqual([{ issueId: null, legacyWorkstreamKey: 'AUTH-1' }]);
    expect(
      await ds.query(
        `SELECT "originIssueId", "legacyWorkstreamKey", "legacyWorkstreamKeys" FROM decisions WHERE id = 'dc_1'`,
      ),
    ).toEqual([
      {
        originIssueId: null,
        legacyWorkstreamKey: 'AUTH-1',
        legacyWorkstreamKeys: ['AUTH-1', 'AUTH-2'],
      },
    ]);
    expect(
      await ds.query(
        `SELECT "issueId", "workstreamId", "legacyWorkstreamKey" FROM artifacts WHERE id = 'ar_1'`,
      ),
    ).toEqual([
      { issueId: null, workstreamId: null, legacyWorkstreamKey: 'AUTH-1' },
    ]);
    expect(
      await ds.query(
        `SELECT count(*)::int AS count FROM comments WHERE id = 'cm_1'`,
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await ds.query(
        `SELECT "legacyWorkstreamKey" FROM domain_events WHERE id = 'ev_1'`,
      ),
    ).toEqual([{ legacyWorkstreamKey: 'AUTH-1' }]);
    expect(await ds.query(`SELECT id, goal FROM issues ORDER BY id`)).toEqual([
      { id: 'in_many', goal: null },
      { id: 'in_one', goal: null },
      { id: 'in_unique', goal: 'One unambiguous issue objective' },
    ]);
    expect(
      await ds.query(
        `SELECT id, key, title, objective FROM legacy_workstream_history ORDER BY id`,
      ),
    ).toEqual([
      {
        id: 'wk_1',
        key: 'AUTH-1',
        title: 'Legacy stream',
        objective: 'One issue objective',
      },
      {
        id: 'wk_2',
        key: 'AUTH-2',
        title: 'Another legacy stream',
        objective: 'Preserve multi-linked objective',
      },
      {
        id: 'wk_3',
        key: 'AUTH-3',
        title: 'Unlinked legacy stream',
        objective: 'Preserve unlinked objective',
      },
      {
        id: 'wk_4',
        key: 'AUTH-4',
        title: 'Uniquely linked legacy stream',
        objective: 'One unambiguous issue objective',
      },
    ]);
    expect(
      await ds.query(
        `SELECT payload->'acceptanceCriteria' AS criteria
         FROM legacy_workstream_history WHERE id = 'wk_1'`,
      ),
    ).toEqual([{ criteria: [{ id: 'cr_1', text: 'Keep the proof', state: 'pending' }] }]);
    expect(
      await ds.query(`SELECT count(*)::int AS count FROM issues`),
    ).toEqual([{ count: 3 }]);

    const finalRunner = ds.createQueryRunner();
    await new RemoveWorkstreams1793750000000().up(finalRunner);
    await finalRunner.release();
    expect(
      await ds.query(`SELECT to_regclass('public.workstreams') AS table`),
    ).toEqual([{ table: null }]);
    expect(
      await ds.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'issues' AND column_name = 'workstreamIds'`,
      ),
    ).toEqual([]);
    expect(
      await ds.query(`SELECT id FROM issues ORDER BY id`),
    ).toEqual([{ id: 'in_many' }, { id: 'in_one' }, { id: 'in_unique' }]);
    expect(
      await ds.query(
        `SELECT count(*)::int AS count FROM input_requests WHERE id = 'ir_1'`,
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await ds.query(`SELECT count(*)::int AS count FROM decisions WHERE id = 'dc_1'`),
    ).toEqual([{ count: 1 }]);
    expect(
      await ds.query(`SELECT count(*)::int AS count FROM artifacts WHERE id = 'ar_1'`),
    ).toEqual([{ count: 1 }]);
    expect(
      await ds.query(`SELECT count(*)::int AS count FROM comments WHERE id = 'cm_1'`),
    ).toEqual([{ count: 1 }]);
    expect(
      await ds.query(`SELECT count(*)::int AS count FROM domain_events WHERE id = 'ev_1'`),
    ).toEqual([{ count: 1 }]);
    expect(
      await ds.query(`SELECT entity, layout FROM saved_views WHERE id = 'vw_1'`),
    ).toEqual([{ entity: 'workstream', layout: 'list' }]);
    expect(
      await ds.query(
        `SELECT id, "fromType", "fromId", "toType", "toId" FROM dependencies WHERE id = 'dep_1'`,
      ),
    ).toEqual([
      {
        id: 'dep_1',
        fromType: 'workstream',
        fromId: 'wk_1',
        toType: 'workstream',
        toId: 'wk_2',
      },
    ]);
  });
});
