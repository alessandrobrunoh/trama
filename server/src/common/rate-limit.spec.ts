import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { RateLimiter, parseTrustProxy, rateLimitEnabled, rateLimitMiddleware } from './rate-limit.js';

function appWith(env: NodeJS.ProcessEnv, trustProxy?: boolean | number) {
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(rateLimitMiddleware({ env, limiter: new RateLimiter() }));
  app.all(/.*/, (_req, res) => res.json({ ok: true }));
  return app;
}

describe('RateLimiter', () => {
  it('counts within a window and starts over after it', () => {
    const l = new RateLimiter();
    expect(l.hit('k', 2, 1000, 0).allowed).toBe(true);
    expect(l.hit('k', 2, 1000, 10).allowed).toBe(true);
    const third = l.hit('k', 2, 1000, 500);
    expect(third).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 1 });
    expect(l.hit('k', 2, 1000, 1000).allowed).toBe(true);
  });

  it('keeps keys apart and rounds Retry-After up', () => {
    const l = new RateLimiter();
    l.hit('a', 1, 60_000, 0);
    expect(l.hit('a', 1, 60_000, 1_500)).toMatchObject({ allowed: false, retryAfterSec: 59 });
    expect(l.hit('b', 1, 60_000, 1_500).allowed).toBe(true);
  });

  it('forgets expired buckets and caps memory', () => {
    const l = new RateLimiter(3);
    for (let i = 0; i < 10; i++) l.hit(`k${i}`, 1, 60_000, 0);
    expect(l.size).toBeLessThanOrEqual(3);
    l.hit('later', 1, 1000, 120_000);
    expect(l.size).toBe(1);
  });
});

describe('rateLimitEnabled', () => {
  it('is off in tests, on elsewhere, and the flag wins', () => {
    expect(rateLimitEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(rateLimitEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(rateLimitEnabled({})).toBe(true);
    expect(rateLimitEnabled({ NODE_ENV: 'test', TRAMA_RATE_LIMIT_ENABLED: 'true' })).toBe(true);
    expect(rateLimitEnabled({ NODE_ENV: 'production', TRAMA_RATE_LIMIT_ENABLED: 'false' })).toBe(false);
  });
});

describe('parseTrustProxy', () => {
  it('reads true, a hop count, or a subnet list', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy(' ')).toBeUndefined();
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});

describe('rateLimitMiddleware', () => {
  it('answers 429 with Retry-After on login after the limit', async () => {
    const app = appWith({ TRAMA_RATE_LIMIT_LOGIN_PER_15MIN: '3' });
    for (let i = 0; i < 3; i++) await request(app).post('/api/auth/login').expect(200);
    const res = await request(app).post('/api/auth/login').expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body).toMatchObject({ statusCode: 429 });
  });

  it('limits the public view endpoint but not other reads by the same rule', async () => {
    const app = appWith({ TRAMA_RATE_LIMIT_PUBLIC_VIEW_PER_MIN: '2' });
    await request(app).get('/api/public/views/abc').expect(200);
    await request(app).get('/api/public/views/def').expect(200);
    await request(app).get('/api/public/views/ghi').expect(429);
    await request(app).get('/api/w/acme/issues').expect(200);
  });

  it('limits signup, invites and token creation separately', async () => {
    const app = appWith({
      TRAMA_RATE_LIMIT_SIGNUP_PER_HOUR: '1',
      TRAMA_RATE_LIMIT_INVITE_PER_15MIN: '1',
      TRAMA_RATE_LIMIT_CREDENTIALS_PER_HOUR: '1',
    });
    await request(app).post('/api/auth/signup').expect(200);
    await request(app).post('/api/auth/signup').expect(429);
    await request(app).get('/api/invites/tok').expect(200);
    await request(app).post('/api/invites/tok/accept').expect(429);
    await request(app).post('/api/w/acme/tokens').expect(200);
    await request(app).post('/api/w/acme/tokens').expect(429);
    // listing tokens is not credential creation
    await request(app).get('/api/w/acme/tokens').expect(200);
    // login has its own bucket and was never used
    await request(app).post('/api/auth/login').expect(200);
  });

  it('applies the generous global limit to everything under /api', async () => {
    const app = appWith({ TRAMA_RATE_LIMIT_GLOBAL_PER_MIN: '3' });
    for (let i = 0; i < 3; i++) await request(app).get('/api/w/acme/issues').expect(200);
    const res = await request(app).get('/api/w/acme/issues').expect(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('defaults are generous globally and strict on login', async () => {
    const app = appWith({});
    for (let i = 0; i < 10; i++) await request(app).post('/api/auth/login').expect(200);
    await request(app).post('/api/auth/login').expect(429);
    for (let i = 0; i < 20; i++) await request(app).get('/api/w/acme/issues').expect(200);
  });

  it('counts clients separately through X-Forwarded-For when the proxy is trusted', async () => {
    const app = appWith({ TRAMA_RATE_LIMIT_LOGIN_PER_15MIN: '1' }, 1);
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.1.1.1').expect(200);
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.1.1.1').expect(429);
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '2.2.2.2').expect(200);
  });

  it('ignores X-Forwarded-For when the proxy is not trusted', async () => {
    const app = appWith({ TRAMA_RATE_LIMIT_LOGIN_PER_15MIN: '1' });
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '1.1.1.1').expect(200);
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '2.2.2.2').expect(429);
  });

  it('does nothing when disabled and never counts preflights', async () => {
    const off = appWith({ TRAMA_RATE_LIMIT_ENABLED: 'false', TRAMA_RATE_LIMIT_LOGIN_PER_15MIN: '1' });
    for (let i = 0; i < 5; i++) await request(off).post('/api/auth/login').expect(200);
    const on = appWith({ TRAMA_RATE_LIMIT_LOGIN_PER_15MIN: '1' });
    for (let i = 0; i < 5; i++) await request(on).options('/api/auth/login').expect(200);
    await request(on).post('/api/auth/login').expect(200);
  });
});
