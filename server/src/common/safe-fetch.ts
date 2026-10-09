import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/**
 * The one outbound HTTP path for requests to URLs that a user (not the operator) can choose:
 * outgoing webhooks, Web Push endpoints and integration base URLs (self-hosted GitHub / GitLab / Delta).
 *
 * Defence against SSRF, in every environment:
 *  - only http(s); https only in production; no credentials in the URL;
 *  - the host is resolved by the connection itself (`lookup`), ALL addresses are checked and the connection
 *    goes to the address that was checked, so DNS rebinding cannot swap it afterwards;
 *  - loopback, private, link-local, CGNAT, multicast, reserved, IPv4-mapped IPv6 and cloud metadata addresses are refused;
 *  - redirects are never followed, requests have a deadline and the response size is capped.
 *
 * Escape hatches (operator only, see server/.env.example): `TRAMA_OUTBOUND_ALLOW_PRIVATE=true` and
 * `TRAMA_OUTBOUND_ALLOWED_HOSTS`. Cloud metadata addresses stay blocked even then.
 */

export class OutboundBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundBlockedError';
  }
}

export interface OutboundPolicy {
  /** Allow loopback / private / link-local targets (local development, everything on a private network). */
  allowPrivate: boolean;
  /** Hostnames (or IP literals) exempt from the address check. `*.example.com` matches subdomains. */
  allowedHosts: string[];
  /** Require https for targets that are not explicitly allowed. */
  requireHttps: boolean;
}

export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  const flag = (v: string | undefined) => v?.trim().toLowerCase() === 'true';
  return {
    // NABLA_ALLOW_PRIVATE_WEBHOOKS is the old name of the flag, kept as an alias.
    allowPrivate: flag(env.TRAMA_OUTBOUND_ALLOW_PRIVATE) || flag(env.NABLA_ALLOW_PRIVATE_WEBHOOKS),
    allowedHosts: (env.TRAMA_OUTBOUND_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, ''))
      .filter(Boolean),
    requireHttps: env.NODE_ENV === 'production',
  };
}

// ---------------------------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------------------------

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function parseIPv6(raw: string): number[] | null {
  let ip = raw.replace(/%.*$/, '');
  const lastColon = ip.lastIndexOf(':');
  if (ip.includes('.')) {
    const v4 = parseIPv4(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((g) => !Number.isNaN(g)) ? out : null;
}

const V4_BLOCKS: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified address'],
  ['10.0.0.0', 8, 'private address'],
  ['100.64.0.0', 10, 'carrier-grade NAT address'],
  ['127.0.0.0', 8, 'loopback address'],
  ['169.254.0.0', 16, 'link-local address'],
  ['172.16.0.0', 12, 'private address'],
  ['192.0.0.0', 24, 'reserved address'],
  ['192.0.2.0', 24, 'documentation address'],
  ['192.88.99.0', 24, 'reserved address'],
  ['192.168.0.0', 16, 'private address'],
  ['198.18.0.0', 15, 'benchmarking address'],
  ['198.51.100.0', 24, 'documentation address'],
  ['203.0.113.0', 24, 'documentation address'],
  ['224.0.0.0', 4, 'multicast address'],
  ['240.0.0.0', 4, 'reserved address'],
];

const METADATA_V4 = new Set(['169.254.169.254', '169.254.170.2', '169.254.169.123', '100.100.100.200', '192.0.0.192']);

function v4Reason(n: number): string | null {
  const dotted = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  if (METADATA_V4.has(dotted)) return 'cloud metadata address';
  for (const [base, bits, label] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((parseIPv4(base)! & mask) >>> 0)) return label;
  }
  return null;
}

/** Why an IP literal must not be contacted, or null when it is a public unicast address. */
export function blockedAddressReason(ip: string): string | null {
  const text = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(text.replace(/%.*$/, ''));
  if (kind === 4) {
    const n = parseIPv4(text);
    return n === null ? 'invalid address' : v4Reason(n);
  }
  if (kind !== 6) return 'invalid address';
  const g = parseIPv6(text);
  if (!g) return 'invalid address';
  const embedded = (hi: number, lo: number) => v4Reason(((hi << 16) | lo) >>> 0);
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return 'cloud metadata address';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return 'IPv4-mapped IPv6 address';
  if (g.slice(0, 6).every((x) => x === 0)) return 'unspecified, loopback or IPv4-compatible address';
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return 'reserved address';
    if (g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]) ? 'NAT64 address of a blocked IPv4 host' : null;
  }
  if (g[0] === 0x2002) return embedded(g[1], g[2]) ? '6to4 address of a blocked IPv4 host' : null;
  if (g[0] === 0x2001 && g[1] === 0) return 'Teredo address';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation address';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast address';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local address';
  if ((g[0] & 0xfe00) === 0xfc00) return 'private address';
  if (g[0] >> 13 !== 1) return 'reserved address'; // everything outside 2000::/3 is not global unicast
  return null;
}

// ---------------------------------------------------------------------------------------------
// Policy checks
// ---------------------------------------------------------------------------------------------

function hostAllowed(host: string, policy: OutboundPolicy): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return policy.allowedHosts.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
}

/** Whether `ip` (reached through `host`) may be contacted under `policy`. Metadata addresses never may. */
function addressProblem(host: string, ip: string, policy: OutboundPolicy): string | null {
  const reason = blockedAddressReason(ip);
  if (!reason) return null;
  if (reason === 'cloud metadata address') return reason;
  return policy.allowPrivate || hostAllowed(host, policy) ? null : reason;
}

function parseOutboundUrl(raw: string, policy: OutboundPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundBlockedError('url must be a valid http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundBlockedError('url must start with https:// or http://');
  if (url.username || url.password) throw new OutboundBlockedError('url must not contain credentials');
  const trusted = policy.allowPrivate || hostAllowed(url.hostname, policy);
  if (policy.requireHttps && url.protocol !== 'https:' && !trusted) throw new OutboundBlockedError('url must use https://');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const problem = isIP(host) ? addressProblem(host, host, policy) : localName(host) && !trusted ? 'internal host name' : null;
  if (problem) throw new OutboundBlockedError(`url points to a ${problem}, which is not allowed (see TRAMA_OUTBOUND_ALLOW_PRIVATE)`);
  return url;
}

function localName(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

type LookupAll = (hostname: string, options: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addrs: dns.LookupAddress[]) => void) => void;

const defaultResolver: LookupAll = (hostname, options, cb) => dns.lookup(hostname, options, cb);

interface LookupCallback {
  (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number): void;
}

/**
 * A `lookup` for http(s).request / net.connect that refuses unsafe addresses. The addresses it returns are the
 * ones the socket connects to, which is what pins the connection to the vetted IP.
 */
export function createSafeLookup(policy: () => OutboundPolicy = outboundPolicyFromEnv, resolver: LookupAll = defaultResolver) {
  return (hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback): void => {
    const cb = (typeof options === 'function' ? options : callback)!;
    const opts = typeof options === 'function' ? {} : options;
    resolver(hostname, { all: true, family: opts.family, hints: opts.hints, verbatim: true }, (err, addrs) => {
      if (err) return cb(err, '');
      if (!addrs.length) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '');
      const p = policy();
      for (const a of addrs) {
        const problem = addressProblem(hostname, a.address, p);
        if (problem) return cb(new OutboundBlockedError(`Blocked: ${hostname} resolves to a ${problem}`), '');
      }
      if (opts.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

export const safeLookup = createSafeLookup();

/**
 * Checks a URL before it is stored: shape, literal host, and (best effort) what its name resolves to now.
 * A name that does not resolve yet is accepted; the request-time check is the one that counts.
 * Returns an error message, or null when acceptable.
 */
export async function outboundUrlProblem(
  raw: string,
  opts: { policy?: OutboundPolicy; resolver?: LookupAll; resolve?: boolean } = {},
): Promise<string | null> {
  const policy = opts.policy ?? outboundPolicyFromEnv();
  let url: URL;
  try {
    url = parseOutboundUrl(raw, policy);
  } catch (e) {
    return (e as Error).message;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (opts.resolve === false || isIP(host)) return null;
  const resolver = opts.resolver ?? defaultResolver;
  const addrs = await new Promise<dns.LookupAddress[]>((resolve) => {
    const timer = setTimeout(() => resolve([]), 3000);
    resolver(host, { all: true, verbatim: true }, (err, list) => {
      clearTimeout(timer);
      resolve(err ? [] : list);
    });
  });
  for (const a of addrs) {
    const problem = addressProblem(host, a.address, policy);
    if (problem) return `url resolves to a ${problem}, which is not allowed (see TRAMA_OUTBOUND_ALLOW_PRIVATE)`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export interface SafeRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Whole-request deadline. Default 15 s. */
  timeoutMs?: number;
  /** Response body cap in bytes. Default 10 MB. */
  maxBytes?: number;
  /** With a cap: cut the body at `maxBytes` instead of failing (when only the status matters). */
  truncate?: boolean;
  policy?: OutboundPolicy;
  /** Test seam: replaces DNS. */
  resolver?: LookupAll;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** http(s) request through the SSRF guard. Redirects are returned as they are (3xx), never followed. */
export async function safeRequest(opts: SafeRequestOptions): Promise<SafeResponse> {
  const policy = opts.policy ?? outboundPolicyFromEnv();
  const url = parseOutboundUrl(opts.url, policy);
  const lookup = createSafeLookup(() => policy, opts.resolver);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const lib = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { 'User-Agent': 'Trama', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = lib.request(
      url,
      { method: opts.method ?? 'GET', headers, lookup: lookup as net_lookup, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () =>
          done(() => {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
            resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks) });
          });
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            if (!opts.truncate) return done(() => (req.destroy(), reject(new Error(`Response larger than ${maxBytes} bytes`))));
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            return finish();
          }
          chunks.push(c);
        });
        res.on('end', finish);
        res.on('error', (e) => done(() => reject(e)));
      },
    );
    const timer = setTimeout(() => {
      const err = new Error(`Timed out after ${timeoutMs} ms`);
      err.name = 'TimeoutError';
      done(() => (req.destroy(), reject(err)));
    }, timeoutMs);
    req.on('error', (e) => done(() => reject(e)));
    req.end(opts.body);
  });
}

type net_lookup = NonNullable<http.RequestOptions['lookup']>;

/** Agent for libraries that take one (web-push): same guarded `lookup` as `safeRequest`. */
export function createSafeHttpsAgent(): https.Agent {
  return new https.Agent({ lookup: safeLookup as net_lookup });
}
