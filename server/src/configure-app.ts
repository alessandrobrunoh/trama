import { BadRequestException, ValidationPipe, type ArgumentMetadata, type INestApplication, type PipeTransform } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { captureWebhookRawBody } from './webhooks/raw-body.js';

/** Angular dev server (`ng serve`, port 4300; 4301 = a second QA instance). */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:4300',
  'http://127.0.0.1:4300',
  'http://localhost:4301',
  'http://127.0.0.1:4301',
];

export const JSON_BODY_LIMIT = '2mb';

/** True when a string anywhere in `value` holds a NUL character. */
export function hasNulChar(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (depth > 20 || value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => k.includes('\u0000') || hasNulChar(v, depth + 1));
}

/** Longest array accepted anywhere in a body: ids end up in SQL lookups, and past 65535 bind parameters Postgres answers 500. */
export const MAX_BODY_ARRAY = 1000;

export function hasOversizedArray(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) && value.length > MAX_BODY_ARRAY) return true;
  return Object.values(value).some((v) => hasOversizedArray(v, depth + 1));
}

/**
 * Input checks that apply to every route before DTO validation:
 *  - a JSON array is not a valid body where a DTO is expected: left alone it passes validation (no
 *    property is wrong) and its methods (`sort`, `filter`…) shadow missing fields;
 *  - lists longer than MAX_BODY_ARRAY are refused;
 *  - PostgreSQL cannot store NUL (`\u0000`) in text or jsonb, so it would surface as a 500 from the
 *    database: it is a 400 here.
 */
export class RejectUnsafeInputPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'body' && Array.isArray(value) && metadata.metatype !== Array)
      throw new BadRequestException('Request body must be a JSON object');
    if ((metadata.type === 'body' || metadata.type === 'query' || metadata.type === 'param') && hasNulChar(value))
      throw new BadRequestException('Text must not contain NUL characters');
    if (metadata.type === 'body' && hasOversizedArray(value))
      throw new BadRequestException(`Lists are limited to ${MAX_BODY_ARRAY} items`);
    return value;
  }
}

/** Shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  (app as NestExpressApplication).useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
    // keeps the raw bytes of /api/webhooks/* requests for HMAC verification
    // (`verify` is passed through to body-parser but missing from Nest's option typing)
    verify: captureWebhookRawBody,
  } as Parameters<NestExpressApplication['useBodyParser']>[1]);
  app.useGlobalPipes(
    new RejectUnsafeInputPipe(),
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );
  const origins = process.env.CORS_ORIGIN?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins?.length ? origins : DEFAULT_CORS_ORIGINS,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Client-Id',
      'X-Requested-With',
      'Accept',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.enableShutdownHooks();
}
