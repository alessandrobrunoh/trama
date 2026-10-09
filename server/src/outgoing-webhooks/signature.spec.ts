import { signBody, verifySignature } from './signature.js';
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

