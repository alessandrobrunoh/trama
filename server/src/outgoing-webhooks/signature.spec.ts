import { signBody, verifySignature } from './signature.js';
import { webhookUrlProblem } from './url-policy.js';
import { webhookEventMatches } from '../contracts/domain.js';

describe('outgoing webhook signature', () => {
  it('is sha256=<hex hmac> of the raw body and verifies in constant time', () => {
    const body = '{"event":"issue.created"}';
    const sig = signBody('whsec_secret', body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // known HMAC-SHA256 vector computed independently: key "key", message "The quick brown fox jumps over the lazy dog"
    expect(signBody('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
    expect(verifySignature('whsec_secret', body, sig)).toBe(true);
    expect(verifySignature('whsec_secret', body + ' ', sig)).toBe(false);
    expect(verifySignature('other', body, sig)).toBe(false);
    expect(verifySignature('whsec_secret', body, undefined)).toBe(false);
    expect(verifySignature('whsec_secret', body, 'sha256=short')).toBe(false);
  });
});

describe('webhookEventMatches', () => {
  it('supports exact types, entity wildcards and *', () => {
    expect(webhookEventMatches(['*'], 'anything.here')).toBe(true);
    expect(webhookEventMatches(['issue.*'], 'issue.created')).toBe(true);
    expect(webhookEventMatches(['issue.*'], 'issues.created')).toBe(false);
    expect(webhookEventMatches(['issue.*'], 'workstream.created')).toBe(false);
    expect(webhookEventMatches(['issue.created', 'team.*'], 'issue.deleted')).toBe(false);
    expect(webhookEventMatches(['issue.created', 'team.*'], 'team.updated')).toBe(true);
    expect(webhookEventMatches([], 'issue.created')).toBe(false);
  });
});

describe('webhookUrlProblem', () => {
  it('accepts http(s), rejects other schemes and credentials', () => {
    expect(webhookUrlProblem('https://example.com/hook', { allowPrivate: false })).toBeNull();
    expect(webhookUrlProblem('ftp://example.com', { allowPrivate: false })).toMatch(/https/);
    expect(webhookUrlProblem('not a url')).toMatch(/valid/);
    expect(webhookUrlProblem('https://user:pw@example.com/')).toMatch(/credentials/);
  });
  it('blocks internal hosts unless private targets are allowed', () => {
    for (const host of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'http://10.1.2.3/x', 'http://192.168.0.5/x', 'http://172.20.0.1/x', 'http://169.254.169.254/x', 'http://[::1]/x', 'http://db.internal/x'])
      expect(webhookUrlProblem(host, { allowPrivate: false }), host).toMatch(/internal/);
    expect(webhookUrlProblem('http://172.32.0.1/x', { allowPrivate: false })).toBeNull();
    expect(webhookUrlProblem('http://localhost:3000/x', { allowPrivate: true })).toBeNull();
  });
});
