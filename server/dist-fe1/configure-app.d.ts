import { type INestApplication } from '@nestjs/common';
export declare const DEFAULT_CORS_ORIGINS: string[];
export declare const JSON_BODY_LIMIT = "2mb";
export declare function configureApp(app: INestApplication): void;
