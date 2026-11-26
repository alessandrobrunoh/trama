import { CHOICES, accountLine, needsAttention, statusDot, statusLabel } from './connection-kit';

describe('connection kit', () => {
  it('words and colours each status', () => {
    expect(statusLabel('connected')).toBe('Connected');
    expect(statusLabel('error')).toBe('Error');
    expect(statusLabel('revoked')).toBe('Revoked');
    expect(statusDot('connected')).toBe('bg-green');
    expect(statusDot('revoked')).toBe('bg-red');
    expect(statusDot('error')).toBe('bg-red');
  });

  it('flags failing and revoked connections, not healthy ones', () => {
    expect(needsAttention({ status: 'connected' })).toBe(false);
    expect(needsAttention({ status: 'error' })).toBe(true);
    expect(needsAttention({ status: 'revoked' })).toBe(true);
  });

  it('describes the account line with the host and the login', () => {
    expect(accountLine({ provider: 'github', host: 'github.com', account: 'alebruno' })).toBe('github.com · @alebruno');
    expect(accountLine({ provider: 'delta', host: 'acme.delta.dev', account: 'acme.delta.dev' })).toBe('acme.delta.dev');
  });

  it('offers every provider, with self-hosted variants that need a base URL', () => {
    expect(new Set(CHOICES.map((c) => c.provider))).toEqual(new Set(['github', 'gitlab', 'bitbucket', 'delta']));
    expect(CHOICES.filter((c) => c.selfHosted).map((c) => c.id)).toEqual(['github-enterprise', 'gitlab-self-hosted']);
    expect(new Set(CHOICES.map((c) => c.id)).size).toBe(CHOICES.length);
  });
});
