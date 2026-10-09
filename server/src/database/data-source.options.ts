import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities/index.js';
import { INTAKE_ENTITIES } from '../customer-intake/entities.js';
import { IMPORT_ENTITIES } from '../importers/entities.js';
import { INTEGRATION_ENTITIES } from '../integrations/entities.js';
import { MIGRATIONS } from './migrations/index.js';

export const DEFAULT_DATABASE_URL =
  'postgres://delta:delta@localhost:5434/nabla';

export function databaseUrl(url = process.env.DATABASE_URL): string {
  return url?.trim() || DEFAULT_DATABASE_URL;
}

/** Shared by the Nest app and the TypeORM CLI. Schema is managed by migrations (no synchronize). */
export function dataSourceOptions(url?: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl(url),
    entities: [...ENTITIES, ...INTEGRATION_ENTITIES, ...INTAKE_ENTITIES, ...IMPORT_ENTITIES],
    migrations: MIGRATIONS,
    migrationsRun: true,
    synchronize: false,
    logging: false,
  };
}
