import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** One counting window: at most `limit` requests per `windowMs`, counted per client IP. */
export interface RateLimitRule {
  /** Bucket name: every rule counts separately, so a busy API does not lock a user out of logging in. */
  name: string;
  method: string | null;
  /** Matched against the full request path (`/api/...`). */
  path: RegExp;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Whole seconds until the window resets. */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window counter held in memory (one API process; a restart forgets the counts). */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly maxBuckets = 100_000) {}

  hit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
    this.sweep(now);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), retryAfterSec };
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Drops expired buckets at most once a second; when still over the cap, the oldest go first. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 1000 && this.buckets.size < this.maxBuckets) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    for (const k of this.buckets.keys()) {
      if (this.buckets.size < this.maxBuckets) break;
      this.buckets.delete(k);
    }
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Off in tests (the e2e suite signs up dozens of users from one address), on everywhere else. */
export function rateLimitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.TRAMA_RATE_LIMIT_ENABLED?.trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV !== 'test';
}

/**
 * A request is counted in the first strict rule it matches AND in the generous global one.
 */
export function rateLimitRules(env: NodeJS.ProcessEnv = process.env): { strict: RateLimitRule[]; global: RateLimitRule } {
  const strict: RateLimitRule[] = [
    { name: 'login', method: 'POST', path: /^\/api\/auth\/login\/?$/, limit: intEnv(env, 'TRAMA_RATE_LIMIT_LOGIN_PER_15MIN', 10), windowMs: 15 * MINUTE },
    { name: 'signup', method: 'POST', path: /^\/api\/auth\/signup\/?$/, limit: intEnv(env, 'TRAMA_RATE_LIMIT_SIGNUP_PER_HOUR', 10), windowMs: HOUR },
    { name: 'invite', method: null, path: /^\/api\/invites\/[^/]+(\/accept)?\/?$/, limit: intEnv(env, 'TRAMA_RATE_LIMIT_INVITE_PER_15MIN', 30), windowMs: 15 * MINUTE },
    { name: 'public-view', method: 'GET', path: /^\/api\/public\/views\/[^/]+\/?$/, limit: intEnv(env, 'TRAMA_RATE_LIMIT_PUBLIC_VIEW_PER_MIN', 30), windowMs: MINUTE },
    // token and agent creation mint credentials
    { name: 'credentials', method: 'POST', path: /^\/api\/w\/[^/]+\/(tokens|agents)\/?$/, limit: intEnv(env, 'TRAMA_RATE_LIMIT_CREDENTIALS_PER_HOUR', 30), windowMs: HOUR },
  ];
  return {
    strict,
    global: { name: 'global', method: null, path: /^\/api(\/|$)/, limit: intEnv(env, 'TRAMA_RATE_LIMIT_GLOBAL_PER_MIN', 1200), windowMs: MINUTE },
  };
}

export interface RateLimitOptions {
  limiter?: RateLimiter;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Express middleware: 429 with `Retry-After` once a client IP (`req.ip`, which honours
 * TRAMA_TRUST_PROXY) goes over a rule. Mounted before routing so refused requests never reach
 * the database or argon2.
 */
export function rateLimitMiddleware(opts: RateLimitOptions = {}): RequestHandler {
  const env = opts.env ?? process.env;
  const limiter = opts.limiter ?? new RateLimiter();
  const now = opts.now ?? Date.now;
  const { strict, global } = rateLimitRules(env);
  const enabled = rateLimitEnabled(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || req.method === 'OPTIONS') return next();
    const path = req.path;
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const rules = [
      strict.find((r) => (r.method === null || r.method === req.method) && r.path.test(path)),
      global.path.test(path) ? global : undefined,
    ];
    for (const rule of rules) {
      if (!rule) continue;
      const r = limiter.hit(`${rule.name}:${ip}`, rule.limit, rule.windowMs, now());
      if (r.allowed) continue;
      res.setHeader('Retry-After', String(r.retryAfterSec));
      res.status(429).json({ statusCode: 429, error: 'Too Many Requests', message: 'Too many requests, retry later' });
      return;
    }
    next();
  };
}

/** `TRAMA_TRUST_PROXY`: `true`, a hop count (`1`), or an Express subnet list (`loopback, 10.0.0.0/8`). Unset = trust nothing. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
