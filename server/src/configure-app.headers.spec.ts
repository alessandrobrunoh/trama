import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { securityHeaders } from './configure-app.js';

const BASE = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
] as const;

function appWith(routeSetsCsp = false) {
  const app = express();
  app.use(securityHeaders);
  app.get('/sample', (_req, res) => {
    if (routeSetsCsp) res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.json({ ok: true });
  });
  return app;
}

describe('securityHeaders', () => {
  const previous = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previous;
  });

  it('sets the baseline headers and leaves HSTS off outside production', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(appWith()).get('/sample');
    expect(res.status).toBe(200);
    for (const [name, value] of BASE) expect(res.headers[name]).toBe(value);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('adds HSTS only when NODE_ENV is production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(appWith()).get('/sample');
    expect(res.headers['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
  });

  it('does not replace a stricter Content-Security-Policy set by the route', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(appWith(true)).get('/sample');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
