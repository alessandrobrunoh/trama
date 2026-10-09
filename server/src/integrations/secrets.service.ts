import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { envWithLegacy } from '../common/env.js';

const DEV_KEY_MATERIAL = 'nabla-dev-only-integration-key';

/**
 * AES-256-GCM encryption of integration credentials at rest.
 *
 * Key: `TRAMA_ENCRYPTION_KEY` — 32 bytes as 64 hex chars or base64, otherwise any
 * passphrase (hashed with sha256). The older names `NABLA_ENCRYPTION_KEY` and `SECRETS_KEY` are still
 * accepted (in that order) so existing deployments keep decrypting their data.
 * Without a key a fixed DEV key is used (loud warning); in production boot fails.
 * Format: `v2:<iv>:<tag>:<ciphertext>` (base64url), bound to `aad` (connection id + field).
 */
@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);
  private readonly key: Buffer;

  constructor() {
    this.key = SecretsService.resolveKey(envWithLegacy('TRAMA_ENCRYPTION_KEY', 'NABLA_ENCRYPTION_KEY') ?? process.env.SECRETS_KEY, (m) =>
      this.logger.warn(m),
    );
  }

  static resolveKey(raw: string | undefined, warn: (m: string) => void = () => undefined): Buffer {
    const value = raw?.trim();
    if (!value) {
      if (process.env.NODE_ENV === 'production')
        throw new Error('TRAMA_ENCRYPTION_KEY is required in production (integration secrets are encrypted at rest)');
      warn(
        '!!! TRAMA_ENCRYPTION_KEY is not set: using a FIXED, PUBLIC development key. Integration tokens are NOT safely encrypted. Set TRAMA_ENCRYPTION_KEY (e.g. `openssl rand -base64 32`) before storing real credentials.',
      );
      return createHash('sha256').update(DEV_KEY_MATERIAL).digest();
    }
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
    if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
      const b = Buffer.from(value, 'base64');
      if (b.length === 32) return b;
    }
    return createHash('sha256').update(value).digest();
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join(':');
  }

  decrypt(payload: string, aad: string): string {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== 'v2' || !iv || !tag || !data) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** A fresh random webhook secret (shown to the admin once). */
  static generateWebhookSecret(): string {
    return `whsec_${randomBytes(24).toString('base64url')}`;
  }
}
