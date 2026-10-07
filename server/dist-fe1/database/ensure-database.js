import { Logger } from '@nestjs/common';
import pg from 'pg';
export async function ensureDatabase(url) {
    const target = new URL(url);
    const name = decodeURIComponent(target.pathname.slice(1));
    if (!name || name === 'postgres')
        return;
    const admin = new URL(url);
    admin.pathname = '/postgres';
    const client = new pg.Client({ connectionString: admin.toString() });
    try {
        await client.connect();
        const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (!found.rowCount) {
            await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
            new Logger('Database').log(`Created database "${name}"`);
        }
    }
    catch (error) {
        new Logger('Database').warn(`Could not ensure database "${name}": ${error.message}`);
    }
    finally {
        await client.end().catch(() => undefined);
    }
}
//# sourceMappingURL=ensure-database.js.map