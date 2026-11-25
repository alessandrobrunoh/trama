import { DataSource } from 'typeorm';
import pg from 'pg';
import { MIGRATIONS } from '../src/database/migrations/index.js';
import { RoutingRules1794300000000 } from '../src/database/migrations/1794300000000-RoutingRules.js';
import { TEST_DATABASE_URL } from './global-setup.js';

describe('RoutingRules migration', () => {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = `${decodeURIComponent(url.pathname.slice(1))}_routing_rules`;
  url.pathname = `/${dbName}`;
  let ds: DataSource;

  /** Inserts a row, filling every other NOT NULL column that has no default with a dummy value. */
  async function insert(table: string, values: Record<string, unknown>) {
    const cols = await ds.query<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
      [table],
    );
    const dummy = (type: string) =>
      type === 'jsonb' ? '[]' : type === 'boolean' ? false : /int|double|numeric/.test(type) ? 0 : /timestamp/.test(type) ? new Date() : 'x';
    const row: Record<string, unknown> = {};
    for (const column of cols) row[column.column_name] = dummy(column.data_type);
    Object.assign(row, values);
    const keys = Object.keys(row);
    await ds.query(
      `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k])),
    );
  }

  const admin = async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL.replace(/\/[^/]*$/, '/postgres') });
    await client.connect();
    return client;
  };

  let day = 0;
  const project = (id: string, workspaceId: string, repository: string | null) =>
    insert('projects', { id, workspaceId, name: id, key: `P${String(day).padStart(3, '0')}`, repository, createdAt: new Date(Date.UTC(2026, 0, 1 + day++)) });

  beforeAll(async () => {
    const client = await admin();
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
    await client.end();

    // The schema as it was before this migration, with projects that name a repository in every way people did.
    const before = new DataSource({
      type: 'postgres',
      url: url.toString(),
      migrations: MIGRATIONS.slice(0, MIGRATIONS.indexOf(RoutingRules1794300000000)),
      migrationsRun: false,
    });
    await before.initialize();
    await before.runMigrations();
    ds = before;
    await insert('workspaces', { id: 'w1', slug: 'routing-one' });
    await insert('workspaces', { id: 'w2', slug: 'routing-two' });
    await insert('workspaces', { id: 'w3', slug: 'routing-three' });
    const connection = (id: string, workspaceId: string, provider: string, status: string, host: string) =>
      insert('integration_connections', { id, workspaceId, ownerType: 'workspace', provider, account: id, host, label: id, status });
    await connection('ic_gh', 'w1', 'github', 'connected', 'github.com');
    await connection('ic_gh_err', 'w2', 'github', 'error', 'github.com'); // the only way to reach GitHub from w2, even if failing
    // w3 only has GitLab; its GitHub project cannot be routed

    await project('p_plain', 'w1', 'acme/web');
    await project('p_url', 'w1', 'https://github.com/acme/api.git');
    await project('p_ssh', 'w1', 'git@github.com:acme/shop.git');
    await project('p_dup', 'w1', 'ACME/Web'); // same source as p_plain: only the first project keeps it
    await project('p_gitlab', 'w1', 'https://gitlab.com/acme/web'); // no GitLab connection in w1
    await project('p_empty', 'w1', '');
    await project('p_null', 'w1', null);
    await project('p_blank', 'w1', '   ');
    await project('p_junk', 'w1', 'not a repository at all');
    await project('p_error', 'w2', 'acme/web'); // same source as in w1: sources are per workspace
    await connection('ic_gl', 'w3', 'gitlab', 'connected', 'gitlab.com');
    await project('p_other', 'w3', 'acme/web');
    await before.destroy();

    ds = new DataSource({ type: 'postgres', url: url.toString(), migrations: MIGRATIONS, migrationsRun: false });
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.destroy();
    const client = await admin();
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.end();
  });

  const ruleOf = async (projectId: string) =>
    (await ds.query(`SELECT * FROM routing_rules WHERE "projectId" = $1`, [projectId])) as Record<string, unknown>[];

  it('turns the repository of a project into an inbound rule through the workspace connection', async () => {
    const rules = await ruleOf('p_plain');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      workspaceId: 'w1',
      connectionId: 'ic_gh',
      provider: 'github',
      host: 'github.com',
      sourcePath: 'acme/web',
      direction: 'inbound',
      filters: {},
      migratedFrom: 'acme/web',
      lastSyncAt: null,
      lastError: null,
      createdBy: { type: 'system' },
    });
  });

  it('understands a clone URL and an ssh remote', async () => {
    expect((await ruleOf('p_url'))[0]).toMatchObject({ sourcePath: 'acme/api', host: 'github.com', migratedFrom: 'https://github.com/acme/api.git' });
    expect((await ruleOf('p_ssh'))[0]).toMatchObject({ sourcePath: 'acme/shop', connectionId: 'ic_gh', migratedFrom: 'git@github.com:acme/shop.git' });
  });

  it('keeps one rule for a source named by two projects: the older project keeps it', async () => {
    expect(await ruleOf('p_dup')).toEqual([]);
    expect(await ruleOf('p_plain')).toHaveLength(1);
  });

  it('adds no rule without a connection that reaches the source, or without anything to parse', async () => {
    for (const id of ['p_gitlab', 'p_empty', 'p_null', 'p_blank', 'p_junk']) expect(await ruleOf(id)).toEqual([]);
  });

  it('goes through a connection that is failing when it is the only one, so the rule shows its health', async () => {
    expect((await ruleOf('p_error'))[0]).toMatchObject({ workspaceId: 'w2', connectionId: 'ic_gh_err', sourcePath: 'acme/web' });
  });

  it('never uses a connection of another provider or another workspace', async () => {
    expect(await ruleOf('p_other')).toEqual([]);
  });

  it('leaves projects.repository as it was', async () => {
    const rows = (await ds.query(`SELECT id, repository FROM projects ORDER BY id`)) as { id: string; repository: string | null }[];
    const by = Object.fromEntries(rows.map((r) => [r.id, r.repository]));
    expect(by).toMatchObject({
      p_plain: 'acme/web',
      p_dup: 'ACME/Web',
      p_ssh: 'git@github.com:acme/shop.git',
      p_gitlab: 'https://gitlab.com/acme/web',
      p_empty: '',
      p_null: null,
    });
  });

  it('refuses the same source twice in one workspace, in any letter case, and lets two workspaces share it', async () => {
    await expect(
      insert('routing_rules', { id: 'rr_dup', workspaceId: 'w1', projectId: 'p_dup', connectionId: 'ic_gh', provider: 'github', host: 'GitHub.com', sourcePath: 'Acme/WEB', filterKey: '' }),
    ).rejects.toThrow(/UQ_routing_rules_source/);
    // a different filter set is a different row at this level (the service refuses overlaps)
    await insert('routing_rules', { id: 'rr_split', workspaceId: 'w1', projectId: 'p_dup', connectionId: 'ic_gh', provider: 'github', host: 'github.com', sourcePath: 'acme/web', filterKey: 'm:v1', direction: 'two_way' });
    await expect(
      insert('routing_rules', { id: 'rr_bad', workspaceId: 'w1', projectId: 'p_dup', connectionId: 'ic_gh', provider: 'github', host: 'github.com', sourcePath: 'acme/other', direction: 'sideways' }),
    ).rejects.toThrow(/CHK_routing_rules_direction/);
  });

  it('keeps a rule, in error, when its connection goes away, and drops rules with their project', async () => {
    await ds.query(`DELETE FROM integration_connections WHERE id = 'ic_gh_err'`);
    expect((await ruleOf('p_error'))[0]).toMatchObject({ connectionId: null });
    await ds.query(`DELETE FROM projects WHERE id = 'p_error'`);
    expect(await ruleOf('p_error')).toEqual([]);
  });
});
