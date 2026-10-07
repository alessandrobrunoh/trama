import { Logger } from '@nestjs/common';
import pg from 'pg';

/**
 * Creates the target database when it does not exist yet (connects to the
 * maintenance `postgres` database first) so `npm run start:dev` works on a
 * fresh container. Failures are logged, not thrown: the real connection error
 * will surface right after.
 */
export async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!name || name === 'postgres') return;
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const found = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (!found.rowCount) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      new Logger('Database').log(`Created database "${name}"`);
    }
  } catch (error) {
    new Logger('Database').warn(
      `Could not ensure database "${name}": ${(error as Error).message}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
