import { ValidationPipe } from '@nestjs/common';
import { captureWebhookRawBody } from './webhooks/raw-body.js';
export const DEFAULT_CORS_ORIGINS = [
    'http://localhost:4300',
    'http://127.0.0.1:4300',
    'http://localhost:4301',
    'http://127.0.0.1:4301',
];
export const JSON_BODY_LIMIT = '2mb';
export function configureApp(app) {
    app.setGlobalPrefix('api');
    app.useBodyParser('json', {
        limit: JSON_BODY_LIMIT,
        verify: captureWebhookRawBody,
    });
    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidUnknownValues: false,
    }));
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
//# sourceMappingURL=configure-app.js.map