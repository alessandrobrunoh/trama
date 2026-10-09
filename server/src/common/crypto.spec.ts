import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, sha256 } from './crypto.js';

describe('crypto', () => {
  it('round-trips secrets and never produces the same ciphertext twice', () => {
    const a = encryptSecret('ghp_secret');
    const b = encryptSecret('ghp_secret');
    expect(a).not.toBe(b);
    expect(a).not.toContain('ghp_secret');
    expect(decryptSecret(a)).toBe('ghp_secret');
  });

  it('rejects tampered payloads', () => {
    const [v, iv, tag, data] = encryptSecret('x').split(':');
    expect(() => decryptSecret([v, iv, tag, `${data}A`].join(':'))).toThrow();
  });

  it('uses TRAMA_ENCRYPTION_KEY, but still reads rows written with the legacy key', () => {
    // written by the previous implementation: key = sha256(SECRETS_KEY ?? constant)
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('nabla-dev-only-secrets-key').digest(), iv);
    const enc = Buffer.concat([cipher.update('vt_old', 'utf8'), cipher.final()]);
    const legacy = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join(':');
    vi.stubEnv('TRAMA_ENCRYPTION_KEY', 'a-production-passphrase');
    try {
      const fresh = encryptSecret('vt_new');
      expect(decryptSecret(fresh)).toBe('vt_new');
      expect(decryptSecret(legacy)).toBe('vt_old');
      // the new ciphertext is not readable with the public dev key
      vi.unstubAllEnvs();
      expect(() => decryptSecret(fresh)).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sha256 is stable hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
