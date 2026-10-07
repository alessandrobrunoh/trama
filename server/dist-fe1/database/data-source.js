import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source.options.js';
if (existsSync('.env'))
    process.loadEnvFile('.env');
export default new DataSource(dataSourceOptions());
//# sourceMappingURL=data-source.js.map