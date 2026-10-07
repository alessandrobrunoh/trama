import type { IncomingMessage, ServerResponse } from 'node:http';
export type RawBodyRequest = IncomingMessage & {
    rawBody?: Buffer;
    originalUrl?: string;
};
export declare function captureWebhookRawBody(req: IncomingMessage, _res: ServerResponse, buf: Buffer): void;
