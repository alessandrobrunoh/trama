import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities/index.js';
import { INTAKE_ENTITIES } from '../customer-intake/entities.js';
import { IMPORT_ENTITIES } from '../importers/entities.js';
import { INTEGRATION_ENTITIES } from '../integrations/entities.js';
import { LUNAGEST_ENTITIES } from '../lunagest/entities.js';
import { TIME_ENTRY_ENTITIES } from '../time-entries/time-entry.entity.js';
import { MIGRATIONS } from './migrations/index.js';

export const DEFAULT_DATABASE_URL =
  'postgres://delta:delta@localhost:5435/trama';

export function databaseUrl(url = process.env.DATABASE_URL): string {
  return url?.trim() || DEFAULT_DATABASE_URL;
}

/** Shared by the Nest app and the TypeORM CLI. Schema is managed by migrations (no synchronize). */
export function dataSourceOptions(url?: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl(url),
    entities: [
      ...ENTITIES,
      ...INTEGRATION_ENTITIES,
      ...INTAKE_ENTITIES,
      ...IMPORT_ENTITIES,
      ...LUNAGEST_ENTITIES,
      ...TIME_ENTRY_ENTITIES,
    ],
    migrations: MIGRATIONS,
    migrationsRun: true,
    synchronize: false,
    logging: false,
  };
}
