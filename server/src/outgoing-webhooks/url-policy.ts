import { isIP } from 'node:net';

/**
 * Rejects URLs that should not be webhook targets. Always: non-http(s), embedded credentials.
 * In production also hosts that are obviously internal (localhost, private / link-local IP ranges,
 * `.local` / `.internal`), unless NABLA_ALLOW_PRIVATE_WEBHOOKS=true. Hostnames are not resolved,
 * so this is a guard rail, not a complete SSRF defence: put the API behind an egress proxy if you need one.
 * Returns an error message, or null when the URL is acceptable.
 */
export function webhookUrlProblem(raw: string, opts: { allowPrivate?: boolean } = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url must be a valid http(s) URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url must start with https:// or http://';
  if (url.username || url.password) return 'url must not contain credentials';
  const allowPrivate = opts.allowPrivate ?? (process.env.NODE_ENV !== 'production' || process.env.NABLA_ALLOW_PRIVATE_WEBHOOKS === 'true');
  if (!allowPrivate && isInternalHost(url.hostname)) return 'url points to an internal address, which is not allowed in production';
  return null;
}

function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}
