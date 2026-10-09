import { createHmac } from 'node:crypto';
import { INTAKE_PROVIDERS } from '../contracts/domain.js';
import {
  signIntakeDelivery,
  verifyFront,
  verifyGeneric,
  verifyIntakeSignature,
  verifyIntercom,
  verifySlack,
  verifyZendesk,
} from './intake-signatures.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const body = Buffer.from('{"hello":"world"}');
const tampered = Buffer.from('{"hello":"w0rld"}');

describe('intake signatures', () => {
  it('Intercom: sha1 HMAC of the body in X-Hub-Signature', () => {
    const expected = `sha1=${createHmac('sha1', 'client-secret').update(body).digest('hex')}`;
    const headers = { 'x-hub-signature': expected };
    expect(verifyIntercom('client-secret', { rawBody: body, headers })).toBe(true);
    expect(verifyIntercom('other', { rawBody: body, headers })).toBe(false);
    expect(verifyIntercom('client-secret', { rawBody: tampered, headers })).toBe(false);
    expect(verifyIntercom('client-secret', { rawBody: body, headers: {} })).toBe(false);
    expect(verifyIntercom('client-secret', { rawBody: body, headers: { 'x-hub-signature': 'sha256=abc' } })).toBe(false);
  });

  it('Zendesk: base64 HMAC-SHA256 of timestamp + body', () => {
    const ts = new Date(NOW).toISOString();
    const sig = createHmac('sha256', 'zd-secret').update(ts + body.toString()).digest('base64');
    const headers = { 'x-zendesk-webhook-signature': sig, 'x-zendesk-webhook-signature-timestamp': ts };
    expect(verifyZendesk('zd-secret', { rawBody: body, headers, now: NOW })).toBe(true);
    expect(verifyZendesk('other', { rawBody: body, headers, now: NOW })).toBe(false);
    expect(verifyZendesk('zd-secret', { rawBody: tampered, headers, now: NOW })).toBe(false);
    expect(verifyZendesk('zd-secret', { rawBody: body, headers: { 'x-zendesk-webhook-signature': sig }, now: NOW })).toBe(false);
  });

  it('Zendesk and Front refuse a replayed (stale) delivery', () => {
    const stale = NOW - 11 * 60_000;
    const zd = signIntakeDelivery('zendesk', 's', body, stale);
    expect(verifyZendesk('s', { rawBody: body, headers: zd, now: NOW })).toBe(false);
    const fr = signIntakeDelivery('front', 's', body, stale);
    expect(verifyFront('s', { rawBody: body, headers: fr, now: NOW })).toBe(false);
  });

  it('Front: base64 HMAC-SHA256 of "<timestamp>:<body>"', () => {
    const ts = String(NOW);
    const sig = createHmac('sha256', 'front-secret').update(`${ts}:${body.toString()}`).digest('base64');
    const headers = { 'x-front-signature': sig, 'x-front-request-timestamp': ts };
    expect(verifyFront('front-secret', { rawBody: body, headers, now: NOW })).toBe(true);
    expect(verifyFront('other', { rawBody: body, headers, now: NOW })).toBe(false);
    expect(verifyFront('front-secret', { rawBody: tampered, headers, now: NOW })).toBe(false);
    expect(verifyFront('front-secret', { rawBody: body, headers: { ...headers, 'x-front-request-timestamp': 'abc' }, now: NOW })).toBe(false);
  });

  it('Slack: v0 HMAC-SHA256 of "v0:<timestamp>:<body>" within five minutes', () => {
    const ts = String(Math.floor(NOW / 1000));
    const sig = `v0=${createHmac('sha256', 'slack-secret').update(`v0:${ts}:${body.toString()}`).digest('hex')}`;
    const headers = { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts };
    expect(verifySlack('slack-secret', { rawBody: body, headers, now: NOW })).toBe(true);
    expect(verifySlack('other', { rawBody: body, headers, now: NOW })).toBe(false);
    expect(verifySlack('slack-secret', { rawBody: tampered, headers, now: NOW })).toBe(false);
    expect(verifySlack('slack-secret', { rawBody: body, headers, now: NOW + 6 * 60_000 })).toBe(false);
  });

  it('generic / email: X-Trama-Signature, Bearer token or Basic password', () => {
    const sig = `sha256=${createHmac('sha256', 'whsec_x').update(body).digest('hex')}`;
    expect(verifyGeneric('whsec_x', { rawBody: body, headers: { 'x-trama-signature': sig } })).toBe(true);
    expect(verifyGeneric('whsec_x', { rawBody: tampered, headers: { 'x-trama-signature': sig } })).toBe(false);
    expect(verifyGeneric('other', { rawBody: body, headers: { 'x-trama-signature': sig } })).toBe(false);
    expect(verifyGeneric('whsec_x', { rawBody: body, headers: { authorization: 'Bearer whsec_x' } })).toBe(true);
    expect(verifyGeneric('whsec_x', { rawBody: body, headers: { authorization: 'Bearer nope' } })).toBe(false);
    const basic = `Basic ${Buffer.from('postmark:whsec_x').toString('base64')}`;
    expect(verifyGeneric('whsec_x', { rawBody: body, headers: { authorization: basic } })).toBe(true);
    expect(verifyGeneric('whsec_x', { rawBody: body, headers: { authorization: `Basic ${Buffer.from('postmark:bad').toString('base64')}` } })).toBe(false);
    expect(verifyGeneric('whsec_x', { rawBody: body, headers: {} })).toBe(false);
  });

  it('every provider verifies what signIntakeDelivery produces, and nothing signed with another secret', () => {
    for (const provider of INTAKE_PROVIDERS) {
      const headers = signIntakeDelivery(provider, 'right', body, NOW);
      expect(verifyIntakeSignature(provider, 'right', { rawBody: body, headers, now: NOW }), provider).toBe(true);
      expect(verifyIntakeSignature(provider, 'wrong', { rawBody: body, headers, now: NOW }), provider).toBe(false);
      expect(verifyIntakeSignature(provider, 'right', { rawBody: tampered, headers, now: NOW }), provider).toBe(false);
    }
  });

  it('a signature for one provider does not pass as another', () => {
    const intercom = signIntakeDelivery('intercom', 's', body, NOW);
    expect(verifyIntakeSignature('generic', 's', { rawBody: body, headers: intercom, now: NOW })).toBe(false);
    expect(verifyIntakeSignature('zendesk', 's', { rawBody: body, headers: intercom, now: NOW })).toBe(false);
  });
});
