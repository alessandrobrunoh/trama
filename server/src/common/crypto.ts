import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import { SecretsService } from '../integrations/secrets.service.js';

/**
 * AES-256-GCM helpers for secrets at rest (public view links). The key is the same one the
 * integrations use: `TRAMA_ENCRYPTION_KEY` (then `NABLA_ENCRYPTION_KEY`, `SECRETS_KEY`); a fixed
 * dev key without one, and boot fails in production (see `SecretsService`).
 * Format: `v1:<iv>:<tag>:<ciphertext>` (base64url).
 */
function key(): Buffer {
  return SecretsService.resolveKey(
    process.env.TRAMA_ENCRYPTION_KEY ?? process.env.NABLA_ENCRYPTION_KEY ?? process.env.SECRETS_KEY,
  );
}

/** Key this module used before it shared the integrations key: still tried when decrypting old rows. */
function legacyKey(): Buffer {
  return createHash('sha256')
    .update(process.env.SECRETS_KEY ?? 'nabla-dev-only-secrets-key')
    .digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join(':');
}

function decryptWith(k: Buffer, iv: string, tag: string, data: string): string {
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data)
    throw new Error('Unsupported secret format');
  try {
    return decryptWith(key(), iv, tag, data);
  } catch (error) {
    // Rows written before the key was shared with the integrations.
    try {
      return decryptWith(legacyKey(), iv, tag, data);
    } catch {
      throw error;
    }
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
