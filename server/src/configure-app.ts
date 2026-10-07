import { ValidationPipe, type INestApplication } from '@nestjs/common';
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
