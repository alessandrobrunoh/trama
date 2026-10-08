import { DataSource } from 'typeorm';
import pg from 'pg';
import { MIGRATIONS } from '../src/database/migrations/index.js';
import { MilestonesToProjects1792500000000 } from '../src/database/migrations/1792500000000-MilestonesToProjects.js';
import { TEST_DATABASE_URL } from './global-setup.js';

/** The data migration: milestones follow their workstream's project; a workstream without one gets a project of its own. */
describe('MilestonesToProjects migration', () => {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = `${decodeURIComponent(url.pathname.slice(1))}_milestones_migration`;
  url.pathname = `/${dbName}`;
  let ds: DataSource;

  /** Inserts a row, filling every NOT NULL column without a default with a typed dummy value. */
  async function insert(table: string, values: Record<string, unknown>) {
    const cols = await ds.query<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
      [table],
    );
    const dummy = (type: string) => (type === 'jsonb' ? '[]' : type === 'boolean' ? false : /int|double|numeric/.test(type) ? 0 : /timestamp/.test(type) ? new Date() : 'x');
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c.column_name] = dummy(c.data_type);
    Object.assign(row, values);
    const keys = Object.keys(row);
    await ds.query(
      `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k])),
    );
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL.replace(/\/[^/]*$/, '/postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    ds = new DataSource({ type: 'postgres', url: url.toString(), migrations: MIGRATIONS.slice(0, -1), migrationsRun: false });
    await ds.initialize();
    await ds.runMigrations();
  });
  afterAll(async () => {
    await ds.destroy();
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL.replace(/\/[^/]*$/, '/postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  it('gives projectless workstreams with milestones a project, keeps existing projects, renumbers sortOrder', async () => {
    await insert('users', { id: 'u1', email: 'm@test.dev' });
    await insert('workspaces', { id: 'w1', slug: 'm' });
    await insert('teams', { id: 't1', workspaceId: 'w1', key: 'AUTH' });
    await insert('repositories', { id: 'r1', workspaceId: 'w1', fullName: 'a/b' });
    await insert('projects', { id: 'pj_existing', workspaceId: 'w1', name: 'Existing' });
    const ws = (id: string, key: string, extra: Record<string, unknown> = {}) =>
      insert('workstreams', { id, workspaceId: 'w1', key, title: `WS ${key}`, ownerTeamId: 't1', createdById: 'u1', accountableUserId: 'u1', repositoryIds: ['r1'], ...extra });
    await ws('wk_loose', 'AUTH-1', { status: 'shipped', derivedStatus: 'shipped', priority: 'high' });
    await ws('wk_proj1', 'AUTH-2', { projectId: 'pj_existing', createdAt: new Date('2026-01-01') });
    await ws('wk_proj2', 'AUTH-3', { projectId: 'pj_existing', createdAt: new Date('2026-02-01') });
    await ws('wk_none', 'AUTH-4');
    const ms = (id: string, workstreamId: string, sortOrder: number) => insert('milestones', { id, workspaceId: 'w1', workstreamId, name: id, sortOrder });
    await ms('ms_a', 'wk_loose', 0);
    await ms('ms_b', 'wk_loose', 1);
    await ms('ms_c', 'wk_proj1', 0);
    await ms('ms_d', 'wk_proj2', 0);
    await insert('issues', { id: 'is_1', workspaceId: 'w1', key: 'BUG-1', number: 1, kind: 'bug', title: 'i', milestoneIds: ['ms_a'], workstreamIds: ['wk_loose'] });

    const runner = ds.createQueryRunner();
    await new MilestonesToProjects1792500000000().up(runner);
    await runner.release();

    const projects = await ds.query<{ id: string; name: string; status: string; priority: string; leadId: string; teamIds: string[]; repositoryIds: string[] }[]>(`SELECT * FROM projects ORDER BY name`);
    // only the workstream that had milestones and no project got one
    expect(projects.map((p) => p.name)).toEqual(['Existing', 'WS AUTH-1']);
    const created = projects.find((p) => p.name === 'WS AUTH-1')!;
    expect(created).toMatchObject({ status: 'completed', priority: 'high', leadId: 'u1', teamIds: ['t1'], repositoryIds: ['r1'] });

    const streams = await ds.query<{ id: string; projectId: string | null }[]>(`SELECT id, "projectId" FROM workstreams`);
    const projectOf = Object.fromEntries(streams.map((w) => [w.id, w.projectId]));
    expect(projectOf).toMatchObject({ wk_loose: created.id, wk_proj1: 'pj_existing', wk_proj2: 'pj_existing', wk_none: null });

    const milestones = await ds.query<{ id: string; projectId: string; sortOrder: number }[]>(`SELECT id, "projectId", "sortOrder" FROM milestones ORDER BY "projectId", "sortOrder"`);
    const byProject = (p: string) => milestones.filter((m) => m.projectId === p).map((m) => `${m.id}:${m.sortOrder}`);
    expect(byProject(created.id)).toEqual(['ms_a:0', 'ms_b:1']);
    // two workstreams of one project: ordered by workstream age, then renumbered 0..n-1
    expect(byProject('pj_existing')).toEqual(['ms_c:0', 'ms_d:1']);

    // issues keep their milestones, which are still valid
    expect((await ds.query(`SELECT "milestoneIds" FROM issues WHERE id = 'is_1'`))[0].milestoneIds).toEqual(['ms_a']);
  });

  it('down() restores workstream milestones', async () => {
    const runner = ds.createQueryRunner();
    await new MilestonesToProjects1792500000000().down(runner);
    await runner.release();
    const rows = await ds.query<{ id: string; workstreamId: string }[]>(`SELECT id, "workstreamId" FROM milestones ORDER BY id`);
    expect(rows.map((r) => `${r.id}:${r.workstreamId}`)).toEqual(['ms_a:wk_loose', 'ms_b:wk_loose', 'ms_c:wk_proj1', 'ms_d:wk_proj1']);
  });
});
