import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  // Hash first so both buffers have equal length (timingSafeEqual requires it).
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex hmac of the raw body>`. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(expected, header);
}

export function signGithub(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** GitLab: `X-Gitlab-Token` carries the secret verbatim. */
export function verifyGitlabToken(secret: string, header: string | undefined): boolean {
  return !!header && safeEqual(secret, header);
}

/** Bitbucket Cloud: `X-Hub-Signature: sha256=<hex hmac of the raw body>`, the same scheme as GitHub's, in another header. */
export function verifyBitbucketSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  return verifyGithubSignature(secret, rawBody, header);
}
