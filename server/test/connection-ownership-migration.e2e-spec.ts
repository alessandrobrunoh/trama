import { DataSource } from 'typeorm';
import pg from 'pg';
import { MIGRATIONS } from '../src/database/migrations/index.js';
import { ConnectionOwnership1794200000000 } from '../src/database/migrations/1794200000000-ConnectionOwnership.js';
import { TEST_DATABASE_URL } from './global-setup.js';

describe('ConnectionOwnership migration', () => {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = `${decodeURIComponent(url.pathname.slice(1))}_connection_ownership`;
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

  beforeAll(async () => {
    const client = await admin();
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
    await client.end();

    // The schema as it was before this migration, with connections of every shape the old code could write.
    const before = new DataSource({
      type: 'postgres',
      url: url.toString(),
      migrations: MIGRATIONS.slice(0, MIGRATIONS.indexOf(ConnectionOwnership1794200000000)),
      migrationsRun: false,
    });
    await before.initialize();
    await before.runMigrations();
    ds = before;
    await insert('users', { id: 'u1', email: 'owner@test.dev' });
    await insert('users', { id: 'u2', email: 'other@test.dev' });
    await insert('workspaces', { id: 'w1', slug: 'ownership-one' });
    await insert('workspaces', { id: 'w2', slug: 'ownership-two' });
    await insert('integration_connections', { id: 'ic_gh', workspaceId: 'w1', provider: 'github', account: 'acme', baseUrl: null, secret: 'enc-gh', status: 'connected' });
    await insert('integration_connections', { id: 'ic_ghe', workspaceId: 'w1', provider: 'github', account: 'octo', baseUrl: 'https://GHE.example.com:8443/sub', secret: 'enc-ghe', status: 'error', lastError: 'boom' });
    await insert('integration_connections', { id: 'ic_gl', workspaceId: 'w2', provider: 'gitlab', account: 'acme-internal', baseUrl: 'https://gitlab.com', status: 'disconnected' });
    await insert('integration_connections', { id: 'ic_delta', workspaceId: 'w2', provider: 'delta', account: 'delta.dev', baseUrl: 'https://delta.dev', status: 'connected' });
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

  const row = async (id: string) => (await ds.query(`SELECT * FROM integration_connections WHERE id = $1`, [id]))[0] as Record<string, unknown>;

  it('turns existing connections into workspace connections with a label and a host, and keeps their credentials', async () => {
    expect(await row('ic_gh')).toMatchObject({ ownerType: 'workspace', workspaceId: 'w1', ownerUserId: null, label: 'GitHub · acme', host: 'github.com', status: 'connected', secret: 'enc-gh' });
    expect(await row('ic_ghe')).toMatchObject({ ownerType: 'workspace', label: 'GitHub · octo', host: 'ghe.example.com:8443', status: 'error', lastError: 'boom', secret: 'enc-ghe' });
    expect(await row('ic_gl')).toMatchObject({ ownerType: 'workspace', label: 'GitLab · acme-internal', host: 'gitlab.com' });
    expect(await row('ic_delta')).toMatchObject({ ownerType: 'workspace', label: 'Delta · delta.dev', host: 'delta.dev' });
  });

  it('renames the never-used disconnected status to revoked', async () => {
    expect((await row('ic_gl')).status).toBe('revoked');
  });

  it('accepts personal connections with no workspace, and several accounts per provider', async () => {
    await insert('integration_connections', { id: 'ic_p1', ownerType: 'user', workspaceId: null, ownerUserId: 'u1', provider: 'github', account: 'ale', host: 'github.com', label: 'GitHub · personal' });
    await insert('integration_connections', { id: 'ic_p2', ownerType: 'user', workspaceId: null, ownerUserId: 'u1', provider: 'github', account: 'ale-work', host: 'github.com', label: 'GitHub · work' });
    // another person, same GitHub account name: not the same connection
    await insert('integration_connections', { id: 'ic_p3', ownerType: 'user', workspaceId: null, ownerUserId: 'u2', provider: 'github', account: 'ale', host: 'github.com', label: 'GitHub · u2' });
    // and a second workspace connection for the same provider in w1
    await insert('integration_connections', { id: 'ic_gh2', ownerType: 'workspace', workspaceId: 'w1', provider: 'github', account: 'acme-labs', host: 'github.com', label: 'GitHub · labs' });
    expect((await ds.query(`SELECT count(*)::int AS n FROM integration_connections WHERE provider = 'github' AND "workspaceId" = 'w1'`))[0].n).toBe(3);
  });

  it('rejects a connection without an owner, and the same account twice for one owner', async () => {
    await expect(
      insert('integration_connections', { id: 'ic_bad1', ownerType: 'workspace', workspaceId: null, provider: 'github', account: 'x', host: 'github.com', label: 'x' }),
    ).rejects.toThrow(/CHK_integration_connections_owner/);
    await expect(
      insert('integration_connections', { id: 'ic_bad2', ownerType: 'user', workspaceId: null, ownerUserId: null, provider: 'github', account: 'x', host: 'github.com', label: 'x' }),
    ).rejects.toThrow(/CHK_integration_connections_owner/);
    await expect(
      insert('integration_connections', { id: 'ic_dup1', ownerType: 'user', workspaceId: null, ownerUserId: 'u1', provider: 'github', account: 'ale', host: 'github.com', label: 'dup' }),
    ).rejects.toThrow(/UQ_integrations_user_account/);
    await expect(
      insert('integration_connections', { id: 'ic_dup2', ownerType: 'workspace', workspaceId: 'w1', provider: 'github', account: 'acme', host: 'github.com', label: 'dup' }),
    ).rejects.toThrow(/UQ_integrations_workspace_account/);
  });

  it('removes a person\'s connections with the person', async () => {
    await insert('users', { id: 'u3', email: 'gone@test.dev' });
    await insert('integration_connections', { id: 'ic_gone', ownerType: 'user', workspaceId: null, ownerUserId: 'u3', provider: 'gitlab', account: 'gone', host: 'gitlab.com', label: 'GitLab · gone' });
    await ds.query(`DELETE FROM users WHERE id = 'u3'`);
    expect(await row('ic_gone')).toBeUndefined();
  });
});
