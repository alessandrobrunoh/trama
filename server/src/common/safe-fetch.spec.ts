import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  blockedAddressReason,
  createSafeLookup,
  outboundPolicyFromEnv,
  outboundUrlProblem,
  safeRequest,
  type OutboundPolicy,
} from './safe-fetch.js';

const STRICT: OutboundPolicy = { allowPrivate: false, allowedHosts: [], requireHttps: false };
const PRIVATE_OK: OutboundPolicy = { allowPrivate: true, allowedHosts: [], requireHttps: false };

type Addr = { address: string; family: number };
const resolverTo = (...addrs: string[]) =>
  ((_host: string, _opts: unknown, cb: (e: null, a: Addr[]) => void) =>
    cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))) as never;

describe('blockedAddressReason', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.8.8.8',
    '169.254.169.254',
    '169.254.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254',
    'ff02::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::1',
    '[::1]',
  ])('blocks %s', (ip) => {
    expect(blockedAddressReason(ip), ip).not.toBeNull();
  });

  it('labels cloud metadata addresses', () => {
    expect(blockedAddressReason('169.254.169.254')).toBe('cloud metadata address');
    expect(blockedAddressReason('fd00:ec2::254')).toBe('cloud metadata address');
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '193.0.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '64:ff9b::808:808'])(
    'allows %s',
    (ip) => {
      expect(blockedAddressReason(ip), ip).toBeNull();
    },
  );
});

describe('outboundUrlProblem', () => {
  it('accepts public http(s) URLs', async () => {
    expect(await outboundUrlProblem('https://example.com/hook', { policy: STRICT, resolver: resolverTo('93.184.216.34') })).toBeNull();
    expect(await outboundUrlProblem('http://example.com/hook', { policy: STRICT, resolver: resolverTo('93.184.216.34') })).toBeNull();
  });

  it('rejects other schemes, bad URLs and credentials', async () => {
    expect(await outboundUrlProblem('ftp://example.com', { policy: STRICT, resolve: false })).toMatch(/https/);
    expect(await outboundUrlProblem('file:///etc/passwd', { policy: STRICT, resolve: false })).toMatch(/https/);
    expect(await outboundUrlProblem('not a url', { policy: STRICT, resolve: false })).toMatch(/valid/);
    expect(await outboundUrlProblem('https://user:pw@example.com/', { policy: STRICT, resolve: false })).toMatch(/credentials/);
  });

  it('requires https in production unless the target is explicitly allowed', async () => {
    const prod = { ...STRICT, requireHttps: true };
    expect(await outboundUrlProblem('http://example.com', { policy: prod, resolve: false })).toMatch(/https/);
    expect(await outboundUrlProblem('https://example.com', { policy: prod, resolve: false })).toBeNull();
    expect(await outboundUrlProblem('http://git.corp', { policy: { ...prod, allowedHosts: ['git.corp'] }, resolve: false })).toBeNull();
  });

  it.each([
    'http://localhost:3000/x',
    'http://api.localhost/x',
    'http://127.0.0.1/x',
    'http://127.1/x',
    'http://2130706433/x',
    'http://0x7f.0.0.1/x',
    'http://10.1.2.3/x',
    'http://192.168.0.5/x',
    'http://172.20.0.1/x',
    'http://100.64.0.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[fd00:ec2::254]/x',
    'http://db.internal/x',
  ])('blocks the literal host in %s', async (url) => {
    expect(await outboundUrlProblem(url, { policy: STRICT, resolve: false }), url).toMatch(/not allowed/);
  });

  it('blocks a public-looking name that resolves to a private address (nip.io style)', async () => {
    const p = await outboundUrlProblem('http://169.254.169.254.nip.io/', { policy: STRICT, resolver: resolverTo('169.254.169.254') });
    expect(p).toMatch(/metadata/);
    expect(await outboundUrlProblem('https://internal.example.com/', { policy: STRICT, resolver: resolverTo('10.0.0.5') })).toMatch(/private/);
  });

  it('checks every resolved address, not just the first', async () => {
    const p = await outboundUrlProblem('https://mixed.example.com/', { policy: STRICT, resolver: resolverTo('93.184.216.34', '127.0.0.1') });
    expect(p).toMatch(/loopback/);
  });

  it('accepts a name that does not resolve yet (request time is what counts)', async () => {
    const failing = ((_h: string, _o: unknown, cb: (e: Error) => void) => cb(new Error('ENOTFOUND'))) as never;
    expect(await outboundUrlProblem('https://later.example.com/', { policy: STRICT, resolver: failing })).toBeNull();
  });

  it('allowlist and allowPrivate open private targets, but never metadata', async () => {
    expect(await outboundUrlProblem('http://10.0.0.5:8080/x', { policy: PRIVATE_OK })).toBeNull();
    expect(await outboundUrlProblem('http://localhost:3000/x', { policy: PRIVATE_OK })).toBeNull();
    expect(await outboundUrlProblem('http://git.corp/x', { policy: { ...STRICT, allowedHosts: ['git.corp'] }, resolver: resolverTo('10.0.0.5') })).toBeNull();
    expect(await outboundUrlProblem('http://other.corp/x', { policy: { ...STRICT, allowedHosts: ['git.corp'] }, resolver: resolverTo('10.0.0.5') })).toMatch(/private/);
    expect(await outboundUrlProblem('http://a.corp/x', { policy: { ...STRICT, allowedHosts: ['*.corp'] }, resolver: resolverTo('10.0.0.5') })).toBeNull();
    expect(await outboundUrlProblem('http://169.254.169.254/', { policy: PRIVATE_OK })).toMatch(/metadata/);
    expect(await outboundUrlProblem('http://meta.corp/', { policy: { ...PRIVATE_OK, allowedHosts: ['meta.corp'] }, resolver: resolverTo('169.254.169.254') })).toMatch(/metadata/);
  });
});

describe('outboundPolicyFromEnv', () => {
  it('is strict by default, in every environment', () => {
    for (const NODE_ENV of ['development', 'test', 'production', undefined]) {
      const p = outboundPolicyFromEnv({ NODE_ENV } as NodeJS.ProcessEnv);
      expect(p.allowPrivate).toBe(false);
      expect(p.allowedHosts).toEqual([]);
    }
    expect(outboundPolicyFromEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).requireHttps).toBe(true);
  });

  it('reads the opt-ins', () => {
    expect(outboundPolicyFromEnv({ TRAMA_OUTBOUND_ALLOW_PRIVATE: 'true' } as NodeJS.ProcessEnv).allowPrivate).toBe(true);
    expect(outboundPolicyFromEnv({ TRAMA_OUTBOUND_ALLOW_PRIVATE: 'yes' } as NodeJS.ProcessEnv).allowPrivate).toBe(false);
    expect(outboundPolicyFromEnv({ NABLA_ALLOW_PRIVATE_WEBHOOKS: 'true' } as NodeJS.ProcessEnv).allowPrivate).toBe(true);
    expect(outboundPolicyFromEnv({ TRAMA_OUTBOUND_ALLOWED_HOSTS: ' Git.Corp, *.Ci.Corp ,[::1]' } as NodeJS.ProcessEnv).allowedHosts).toEqual(['git.corp', '*.ci.corp', '::1']);
  });
});

describe('createSafeLookup', () => {
  const run = (lookup: ReturnType<typeof createSafeLookup>, host: string, all = false) =>
    new Promise<{ err: Error | null; res: unknown }>((resolve) =>
      lookup(host, { all } as never, ((err: Error | null, res: unknown) => resolve({ err, res })) as never),
    );

  it('hands out the vetted address (single and all forms)', async () => {
    const lookup = createSafeLookup(() => STRICT, resolverTo('93.184.216.34'));
    expect((await run(lookup, 'a.example.com')).res).toBe('93.184.216.34');
    expect((await run(lookup, 'a.example.com', true)).res).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses a private answer', async () => {
    const { err } = await run(createSafeLookup(() => STRICT, resolverTo('192.168.1.10')), 'a.example.com');
    expect(err?.name).toBe('OutboundBlockedError');
    expect(err?.message).toMatch(/private address/);
  });

  it('refuses when any of several answers is private', async () => {
    const lookup = createSafeLookup(() => STRICT, resolverTo('93.184.216.34', '::ffff:10.0.0.1'));
    expect((await run(lookup, 'a.example.com', true)).err?.message).toMatch(/IPv4-mapped/);
  });

  it('re-validates on every connection, so a rebinding answer is caught', async () => {
    let calls = 0;
    const flipping = ((_h: string, _o: unknown, cb: (e: null, a: Addr[]) => void) =>
      cb(null, [{ address: ++calls === 1 ? '93.184.216.34' : '169.254.169.254', family: 4 }])) as never;
    const lookup = createSafeLookup(() => STRICT, flipping);
    expect((await run(lookup, 'rebind.example.com')).err).toBeNull();
    expect((await run(lookup, 'rebind.example.com')).err?.message).toMatch(/metadata/);
  });

  it('reads the policy at lookup time', async () => {
    let policy = STRICT;
    const lookup = createSafeLookup(() => policy, resolverTo('10.0.0.5'));
    expect((await run(lookup, 'x.corp')).err).not.toBeNull();
    policy = { ...STRICT, allowedHosts: ['x.corp'] };
    expect((await run(lookup, 'x.corp')).err).toBeNull();
  });
});

describe('safeRequest', () => {
  let server: http.Server;
  let base: string;
  const seen: { host?: string; method?: string; body: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ host: req.headers.host, method: req.method, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
          return res.end();
        }
        if (req.url === '/big') return res.end('x'.repeat(5000));
        if (req.url === '/slow') return; // never answers
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Echo': 'yes' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));

  it('refuses loopback by default and never connects', async () => {
    seen.length = 0;
    await expect(safeRequest({ url: `${base}/ok`, policy: STRICT })).rejects.toThrow(/loopback/);
    expect(seen).toHaveLength(0);
  });

  it('refuses a name that resolves to loopback', async () => {
    seen.length = 0;
    await expect(safeRequest({ url: `http://sneaky.example.com:${new URL(base).port}/ok`, policy: STRICT, resolver: resolverTo('127.0.0.1') })).rejects.toThrow(
      /resolves to a loopback/,
    );
    expect(seen).toHaveLength(0);
  });

  it('sends the request when private targets are allowed', async () => {
    seen.length = 0;
    const res = await safeRequest({ url: `${base}/ok`, method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' }, policy: PRIVATE_OK });
    expect(res.status).toBe(200);
    expect(res.headers['x-echo']).toBe('yes');
    expect(JSON.parse(res.body.toString())).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"a":1}' });
  });

  it('connects to the address it vetted: one resolution, original Host header', async () => {
    seen.length = 0;
    let lookups = 0;
    const resolver = ((_h: string, _o: unknown, cb: (e: null, a: Addr[]) => void) => (lookups++, cb(null, [{ address: '127.0.0.1', family: 4 }]))) as never;
    const port = new URL(base).port;
    const res = await safeRequest({
      url: `http://pinned.corp:${port}/ok`,
      policy: { ...STRICT, allowedHosts: ['pinned.corp'] },
      resolver,
    });
    expect(res.status).toBe(200);
    expect(lookups).toBe(1);
    expect(seen[0].host).toBe(`pinned.corp:${port}`);
  });

  it('does not follow redirects (the metadata target is never contacted)', async () => {
    seen.length = 0;
    const res = await safeRequest({ url: `${base}/redirect`, policy: PRIVATE_OK });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('169.254.169.254');
    expect(seen).toHaveLength(1);
  });

  it('caps the response size, failing or truncating', async () => {
    await expect(safeRequest({ url: `${base}/big`, policy: PRIVATE_OK, maxBytes: 1000 })).rejects.toThrow(/larger than 1000/);
    const cut = await safeRequest({ url: `${base}/big`, policy: PRIVATE_OK, maxBytes: 1000, truncate: true });
    expect(cut.status).toBe(200);
    expect(cut.body.length).toBe(1000);
  });

  it('times out', async () => {
    await expect(safeRequest({ url: `${base}/slow`, policy: PRIVATE_OK, timeoutMs: 150 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('refuses the metadata address even with allowPrivate', async () => {
    await expect(safeRequest({ url: 'http://169.254.169.254/latest/meta-data', policy: PRIVATE_OK })).rejects.toThrow(/metadata/);
  });
});
