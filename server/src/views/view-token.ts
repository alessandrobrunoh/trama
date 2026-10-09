import { createHash, randomBytes } from 'node:crypto';

/** `vt_` + 32 random bytes (256 bits) in base64url: unguessable, URL-safe. */
const TOKEN_RE = /^vt_[A-Za-z0-9_-]{43}$/;

export function generatePublicToken(): string {
  return `vt_${randomBytes(32).toString('base64url')}`;
}

/** Only this hash is looked up; a leaked database row cannot be turned into a working link without the encrypted copy and the secrets key. */
export function hashPublicToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap shape check before touching the database. */
export function isPublicToken(value: string): boolean {
  return TOKEN_RE.test(value);
}
