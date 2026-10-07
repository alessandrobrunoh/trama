import type { DataSourceOptions } from 'typeorm';
export declare const DEFAULT_DATABASE_URL = "postgres://delta:delta@localhost:5434/nabla";
export declare function databaseUrl(url?: string | undefined): string;
export declare function dataSourceOptions(url?: string): DataSourceOptions;
