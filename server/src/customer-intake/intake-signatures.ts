import { createHmac } from 'node:crypto';
import type { IntakeProvider } from '../contracts/domain.js';
import { safeEqual } from '../webhooks/signatures.js';

/** Lower-cased request headers. */
export type IntakeHeaders = Record<string, string | string[] | undefined>;

export interface IntakeDelivery {
  rawBody: Buffer;
  headers: IntakeHeaders;
  /** Epoch ms; injectable for tests. */
  now?: number;
}

/** Zendesk and Front stamp every delivery; a signature older than this is a replay. Slack documents 5 minutes. */
const REPLAY_WINDOW_MS = 5 * 60_000;
const LOOSE_REPLAY_WINDOW_MS = 10 * 60_000;

const header = (h: IntakeHeaders, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

const hmac = (algorithm: 'sha1' | 'sha256', secret: string, data: string | Buffer) =>
  createHmac(algorithm, secret).update(data);

const within = (stampMs: number, now: number, window: number) => Number.isFinite(stampMs) && Math.abs(now - stampMs) <= window;

/** Intercom: `X-Hub-Signature: sha1=<hex HMAC-SHA1 of the raw body>`, keyed with the app's client secret. */
export function verifyIntercom(secret: string, d: IntakeDelivery): boolean {
  const sig = header(d.headers, 'x-hub-signature');
  if (!sig?.startsWith('sha1=')) return false;
  return safeEqual(`sha1=${hmac('sha1', secret, d.rawBody).digest('hex')}`, sig);
}

/**
 * Zendesk: `X-Zendesk-Webhook-Signature` = base64(HMAC-SHA256(secret, timestamp + body)), timestamp in
 * `X-Zendesk-Webhook-Signature-Timestamp` (ISO 8601).
 */
export function verifyZendesk(secret: string, d: IntakeDelivery): boolean {
  const sig = header(d.headers, 'x-zendesk-webhook-signature');
  const ts = header(d.headers, 'x-zendesk-webhook-signature-timestamp');
  if (!sig || !ts) return false;
  if (!within(Date.parse(ts), d.now ?? Date.now(), LOOSE_REPLAY_WINDOW_MS)) return false;
  return safeEqual(hmac('sha256', secret, ts + d.rawBody.toString('utf8')).digest('base64'), sig);
}

/**
 * Front: `X-Front-Signature` = base64(HMAC-SHA256(applicationSecret, "<timestamp>:<body>")), with the
 * millisecond timestamp in `X-Front-Request-Timestamp`.
 */
export function verifyFront(secret: string, d: IntakeDelivery): boolean {
  const sig = header(d.headers, 'x-front-signature');
  const ts = header(d.headers, 'x-front-request-timestamp');
  if (!sig || !ts || !/^\d+$/.test(ts)) return false;
  if (!within(Number(ts), d.now ?? Date.now(), LOOSE_REPLAY_WINDOW_MS)) return false;
  return safeEqual(hmac('sha256', secret, `${ts}:${d.rawBody.toString('utf8')}`).digest('base64'), sig);
}

/** Slack: `X-Slack-Signature: v0=<hex HMAC-SHA256 of "v0:<timestamp>:<raw body>">`, timestamp in seconds. */
export function verifySlack(secret: string, d: IntakeDelivery): boolean {
  const sig = header(d.headers, 'x-slack-signature');
  const ts = header(d.headers, 'x-slack-request-timestamp');
  if (!sig?.startsWith('v0=') || !ts || !/^\d+$/.test(ts)) return false;
  if (!within(Number(ts) * 1000, d.now ?? Date.now(), REPLAY_WINDOW_MS)) return false;
  return safeEqual(`v0=${hmac('sha256', secret, `v0:${ts}:${d.rawBody.toString('utf8')}`).digest('hex')}`, sig);
}

/**
 * Signed JSON webhook and email forward. Three ways in, because the senders differ:
 *  - `X-Trama-Signature: sha256=<hex HMAC-SHA256 of the raw body>` (scripts, backends);
 *  - `Authorization: Bearer <secret>` (Zapier, Make, n8n, which cannot compute an HMAC);
 *  - HTTP Basic with the secret as the password (Postmark inbound webhooks take credentials in the URL).
 */
export function verifyGeneric(secret: string, d: IntakeDelivery): boolean {
  const sig = header(d.headers, 'x-trama-signature');
  if (sig?.startsWith('sha256=')) return safeEqual(`sha256=${hmac('sha256', secret, d.rawBody).digest('hex')}`, sig);
  const auth = header(d.headers, 'authorization');
  if (!auth) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return safeEqual(secret, bearer[1]!.trim());
  const basic = /^Basic\s+(.+)$/i.exec(auth);
  if (basic) {
    const decoded = Buffer.from(basic[1]!.trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon >= 0 && safeEqual(secret, decoded.slice(colon + 1));
  }
  return false;
}

export function verifyIntakeSignature(provider: IntakeProvider, secret: string, d: IntakeDelivery): boolean {
  switch (provider) {
    case 'intercom':
      return verifyIntercom(secret, d);
    case 'zendesk':
      return verifyZendesk(secret, d);
    case 'front':
      return verifyFront(secret, d);
    case 'slack':
      return verifySlack(secret, d);
    case 'email':
    case 'generic':
      return verifyGeneric(secret, d);
  }
}

/** The headers a provider would send for `rawBody`: used by tests and by the settings "test" button. */
export function signIntakeDelivery(provider: IntakeProvider, secret: string, rawBody: Buffer, now = Date.now()): IntakeHeaders {
  switch (provider) {
    case 'intercom':
      return { 'x-hub-signature': `sha1=${hmac('sha1', secret, rawBody).digest('hex')}` };
    case 'zendesk': {
      const ts = new Date(now).toISOString();
      return {
        'x-zendesk-webhook-signature-timestamp': ts,
        'x-zendesk-webhook-signature': hmac('sha256', secret, ts + rawBody.toString('utf8')).digest('base64'),
      };
    }
    case 'front': {
      const ts = String(now);
      return {
        'x-front-request-timestamp': ts,
        'x-front-signature': hmac('sha256', secret, `${ts}:${rawBody.toString('utf8')}`).digest('base64'),
      };
    }
    case 'slack': {
      const ts = String(Math.floor(now / 1000));
      return {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': `v0=${hmac('sha256', secret, `v0:${ts}:${rawBody.toString('utf8')}`).digest('hex')}`,
      };
    }
    case 'email':
    case 'generic':
      return { 'x-trama-signature': `sha256=${hmac('sha256', secret, rawBody).digest('hex')}` };
  }
}
