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

  it('sha256 is stable hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
