import { SecretsService } from './secrets.service.js';

describe('SecretsService', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const make = () => {
    process.env.TRAMA_ENCRYPTION_KEY = key;
    return new SecretsService();
  };

  it('round-trips and never stores plaintext', () => {
    const s = make();
    const enc = s.encrypt('ghp_supersecret', 'ic_1:secret');
    expect(enc.startsWith('v2:')).toBe(true);
    expect(enc).not.toContain('ghp_supersecret');
    expect(s.decrypt(enc, 'ic_1:secret')).toBe('ghp_supersecret');
  });
  it('uses a fresh IV per encryption', () => {
    const s = make();
    expect(s.encrypt('x', 'a')).not.toBe(s.encrypt('x', 'a'));
  });
  it('is bound to its context (AAD) and to the key', () => {
    const s = make();
    const enc = s.encrypt('x', 'ic_1:secret');
    expect(() => s.decrypt(enc, 'ic_2:secret')).toThrow();
    process.env.TRAMA_ENCRYPTION_KEY = 'a different passphrase';
    expect(() => new SecretsService().decrypt(enc, 'ic_1:secret')).toThrow();
  });
  it('accepts hex, base64 and passphrase keys; requires a key in production', () => {
    expect(SecretsService.resolveKey('ab'.repeat(32))).toHaveLength(32);
    expect(SecretsService.resolveKey(key)).toEqual(Buffer.alloc(32, 7));
    expect(SecretsService.resolveKey('hunter2')).toHaveLength(32);
    const warn = vi.fn();
    expect(SecretsService.resolveKey(undefined, warn)).toHaveLength(32);
    expect(warn).toHaveBeenCalledOnce();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    expect(() => SecretsService.resolveKey(undefined)).toThrow(/required in production/);
    process.env.NODE_ENV = prev;
  });
  it('still reads the legacy NABLA_ENCRYPTION_KEY, with TRAMA_ENCRYPTION_KEY taking precedence', () => {
    const enc = make().encrypt('x', 'a');
    delete process.env.TRAMA_ENCRYPTION_KEY;
    process.env.NABLA_ENCRYPTION_KEY = key;
    expect(new SecretsService().decrypt(enc, 'a')).toBe('x');
    process.env.TRAMA_ENCRYPTION_KEY = 'something else';
    expect(() => new SecretsService().decrypt(enc, 'a')).toThrow();
    delete process.env.NABLA_ENCRYPTION_KEY;
  });
  afterAll(() => {
    delete process.env.TRAMA_ENCRYPTION_KEY;
    delete process.env.NABLA_ENCRYPTION_KEY;
  });
});
