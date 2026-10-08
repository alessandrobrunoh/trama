import { signGithub, verifyBitbucketSignature, verifyGithubSignature, verifyGitlabToken } from './signatures.js';

describe('webhook signatures', () => {
  const body = Buffer.from('{"action":"opened"}');
  it('accepts a correct GitHub HMAC', () => {
    expect(verifyGithubSignature('s3cret', body, signGithub('s3cret', body))).toBe(true);
  });
  it('rejects wrong secret, tampered body, missing or malformed header', () => {
    const sig = signGithub('s3cret', body);
    expect(verifyGithubSignature('other', body, sig)).toBe(false);
    expect(verifyGithubSignature('s3cret', Buffer.from('{"action":"closed"}'), sig)).toBe(false);
    expect(verifyGithubSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyGithubSignature('s3cret', body, 'sha1=abc')).toBe(false);
    expect(verifyGithubSignature('s3cret', body, 'sha256=zz')).toBe(false);
  });
  it('compares GitLab tokens', () => {
    expect(verifyGitlabToken('tok', 'tok')).toBe(true);
    expect(verifyGitlabToken('tok', 'tok2')).toBe(false);
    expect(verifyGitlabToken('tok', undefined)).toBe(false);
    expect(verifyGitlabToken('tok', '')).toBe(false);
  });
  it('verifies Bitbucket HMACs (sha256=<hex>)', () => {
    expect(verifyBitbucketSignature('s3cret', body, signGithub('s3cret', body))).toBe(true);
    expect(verifyBitbucketSignature('other', body, signGithub('s3cret', body))).toBe(false);
    expect(verifyBitbucketSignature('s3cret', body, undefined)).toBe(false);
  });
});
