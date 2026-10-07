import type { IncomingMessage, ServerResponse } from 'node:http';

export type RawBodyRequest = IncomingMessage & { rawBody?: Buffer; originalUrl?: string };

/**
 * `verify` hook for the global JSON body parser: keeps the exact bytes of webhook
 * requests (needed for the HMAC) while every other route is parsed as before.
 */
export function captureWebhookRawBody(req: IncomingMessage, _res: ServerResponse, buf: Buffer): void {
  const r = req as RawBodyRequest;
  if ((r.originalUrl ?? r.url ?? '').startsWith('/api/webhooks/')) r.rawBody = Buffer.from(buf);
}
