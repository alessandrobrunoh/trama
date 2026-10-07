import { ENTITIES } from './entities/index.js';
import { INTEGRATION_ENTITIES } from '../integrations/entities.js';
import { MIGRATIONS } from './migrations/index.js';
export const DEFAULT_DATABASE_URL = 'postgres://delta:delta@localhost:5434/nabla';
export function databaseUrl(url = process.env.DATABASE_URL) {
    return url?.trim() || DEFAULT_DATABASE_URL;
}
export function dataSourceOptions(url) {
    return {
        type: 'postgres',
        url: databaseUrl(url),
        entities: [...ENTITIES, ...INTEGRATION_ENTITIES],
        migrations: MIGRATIONS,
        migrationsRun: true,
        synchronize: false,
        logging: false,
    };
}
//# sourceMappingURL=data-source.options.js.map