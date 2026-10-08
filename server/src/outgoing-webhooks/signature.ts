import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the signature of an outgoing webhook delivery. */
export const SIGNATURE_HEADER = 'X-Nabla-Signature';

/** `sha256=<hex hmac-sha256 of the raw request body>` — verify it on the receiving side with the webhook secret. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time check, for receivers written in TypeScript (and for our own tests). */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
