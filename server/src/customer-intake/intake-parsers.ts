import { createHash } from 'node:crypto';
import { CUSTOMER_REQUEST_BODY_MAX, normalizeHttpUrl, type IntakeProvider } from '../contracts/domain.js';

/** What every provider payload is reduced to. Nothing here is trusted: sizes are clamped, URLs are checked. */
export interface InboundRequest {
  /** Ticket / conversation / message id in the source system; the idempotency key. */
  externalId: string;
  externalUrl?: string;
  requesterEmail?: string;
  requesterName?: string;
  subject?: string;
  body: string;
  /** Only the generic webhook: key of an issue of the source's own workspace to attach the request to. */
  issueKey?: string;
}

export type ParsedIntake =
  | { kind: 'request'; request: InboundRequest }
  /** A valid delivery that carries nothing to record (another topic, a ping, an empty message). */
  | { kind: 'ignored'; reason: string }
  | { kind: 'ping'; response?: Record<string, unknown> };

export class IntakePayloadError extends Error {}

export interface ParseOptions {
  /** Zendesk account subdomain, to build ticket links when the payload has none. */
  subdomain?: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
};
const at = (v: unknown, ...path: string[]): unknown => {
  let cur = v;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
};

const EMAIL = /[^\s<>"',;()[\]]+@[^\s<>"',;()[\]]+\.[a-z]{2,}/i;

/** `Jane <jane@acme.com>` / `jane@acme.com` → the address, lower-cased. */
export function extractEmail(input: unknown): string | undefined {
  const raw = str(input);
  if (!raw) return undefined;
  const m = EMAIL.exec(raw);
  const email = m?.[0].toLowerCase();
  return email && email.length <= 254 ? email : undefined;
}

function displayName(input: unknown): string | undefined {
  const raw = str(input);
  if (!raw) return undefined;
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(raw);
  return m ? clamp(m[1]!, 200) : undefined;
}

const clamp = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** Plain text from the HTML a helpdesk sends: block tags become line breaks, the rest is dropped. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const text = (v: unknown): string => {
  const raw = str(v) ?? '';
  return clamp(/<\/?[a-z][^>]*>/i.test(raw) ? htmlToText(raw) : raw, CUSTOMER_REQUEST_BODY_MAX);
};

const url = (v: unknown): string | undefined => {
  const raw = str(v);
  return raw ? (normalizeHttpUrl(raw) ?? undefined) : undefined;
};

function build(partial: {
  externalId: string | undefined;
  externalUrl?: unknown;
  email?: unknown;
  name?: unknown;
  subject?: unknown;
  body?: unknown;
  issueKey?: unknown;
}): InboundRequest {
  const externalId = partial.externalId;
  if (!externalId) throw new IntakePayloadError('missing ticket / message id');
  const body = text(partial.body);
  const subject = str(partial.subject) ? clamp(text(partial.subject), 300) : undefined;
  if (!body && !subject) throw new IntakePayloadError('empty request');
  const requesterName = str(partial.name) ? clamp(str(partial.name)!, 200) : undefined;
  const issueKey = str(partial.issueKey);
  return {
    externalId: clamp(externalId, 200),
    ...(url(partial.externalUrl) ? { externalUrl: url(partial.externalUrl)! } : {}),
    ...(extractEmail(partial.email) ? { requesterEmail: extractEmail(partial.email)! } : {}),
    ...(requesterName ? { requesterName } : {}),
    ...(subject ? { subject } : {}),
    body: body || subject!,
    ...(issueKey ? { issueKey: clamp(issueKey, 40) } : {}),
  };
}

// ───────────────────────────── Intercom ─────────────────────────────

/**
 * Intercom webhook notification (`conversation.user.created`): the conversation is `data.item`, the first
 * message `data.item.source`. Other topics are acknowledged and ignored; `ping` answers pong.
 */
export function parseIntercom(payload: unknown): ParsedIntake {
  if (!isObj(payload)) throw new IntakePayloadError('body must be a JSON object');
  const topic = str(payload['topic']);
  if (topic === 'ping') return { kind: 'ping' };
  if (topic !== 'conversation.user.created' && topic !== 'conversation.contact.created')
    return { kind: 'ignored', reason: `topic ${topic ?? '(none)'} is not recorded` };
  const item = at(payload, 'data', 'item');
  if (!isObj(item)) throw new IntakePayloadError('missing data.item');
  const id = str(item['id']);
  const source = isObj(item['source']) ? item['source'] : {};
  const contact = at(item, 'contacts', 'contacts', '0');
  const appId = str(payload['app_id']);
  return {
    kind: 'request',
    request: build({
      externalId: id,
      externalUrl: str(source['url']) ?? (appId && id ? `https://app.intercom.com/a/inbox/${appId}/inbox/conversation/${id}` : undefined),
      email: at(source, 'author', 'email') ?? at(contact, 'email'),
      name: at(source, 'author', 'name') ?? at(contact, 'name'),
      subject: source['subject'],
      body: source['body'],
    }),
  };
}

// ───────────────────────────── Zendesk ─────────────────────────────

/**
 * Zendesk webhooks have no fixed payload: a trigger or automation sends the JSON body you write. The documented
 * template (shown in Settings) is
 * `{"ticket_id":"{{ticket.id}}","subject":"{{ticket.title}}","description":"{{ticket.description}}",
 *   "requester_email":"{{ticket.requester.email}}","requester_name":"{{ticket.requester.name}}"}`.
 * The event payload of an event-subscribed webhook (`zen:event-type:ticket.created`, `detail.id`) is understood
 * too, but it carries no requester email, so those requests wait in triage.
 */
export function parseZendesk(payload: unknown, opts: ParseOptions = {}): ParsedIntake {
  if (!isObj(payload)) throw new IntakePayloadError('body must be a JSON object');
  const type = str(payload['type']);
  const detail = isObj(payload['detail']) ? payload['detail'] : undefined;
  if (type && type.startsWith('zen:event-type:') && type !== 'zen:event-type:ticket.created')
    return { kind: 'ignored', reason: `event ${type} is not recorded` };
  const id = str(payload['ticket_id']) ?? str(payload['id']) ?? str(detail?.['id']);
  const sub = opts.subdomain?.trim();
  return {
    kind: 'request',
    request: build({
      externalId: id,
      externalUrl: str(payload['url']) && !/\/api\//.test(str(payload['url'])!) ? payload['url'] : sub && id ? `https://${sub}.zendesk.com/agent/tickets/${id}` : undefined,
      email: payload['requester_email'] ?? at(payload, 'requester', 'email'),
      name: payload['requester_name'] ?? at(payload, 'requester', 'name'),
      subject: payload['subject'] ?? detail?.['subject'],
      body: payload['description'] ?? payload['body'] ?? detail?.['description'],
    }),
  };
}

// ───────────────────────────── Front ─────────────────────────────

/**
 * Front application / rule webhook for an inbound message. The event may be wrapped
 * (`{type, payload: {conversation, target: {data}}}`) or sent flat by a rule action; both are read.
 * The idempotency key is the conversation, so later messages of one thread do not file the request again.
 */
export function parseFront(payload: unknown): ParsedIntake {
  if (!isObj(payload)) throw new IntakePayloadError('body must be a JSON object');
  const type = str(payload['type']);
  if (type === 'ping' || type === 'test') return { kind: 'ping' };
  if (type && type !== 'inbound_received' && type !== 'inbound') return { kind: 'ignored', reason: `event ${type} is not recorded` };
  const root = isObj(payload['payload']) ? payload['payload'] : payload;
  const conversation = isObj(root['conversation']) ? root['conversation'] : {};
  const message = isObj(at(root, 'target', 'data')) ? (at(root, 'target', 'data') as Obj) : isObj(root['message']) ? root['message'] : {};
  const conversationId = str(conversation['id']) ?? str(message['conversation_id']);
  const recipients = Array.isArray(message['recipients']) ? message['recipients'] : [];
  const from = recipients.find((r) => isObj(r) && r['role'] === 'from');
  const author = isObj(message['author']) ? message['author'] : undefined;
  return {
    kind: 'request',
    request: build({
      externalId: conversationId ?? str(message['id']),
      externalUrl: conversationId ? `https://app.frontapp.com/open/${conversationId}` : undefined,
      email: at(from, 'handle') ?? author?.['email'],
      name: at(from, 'name') ?? (author ? [author['first_name'], author['last_name']].filter(Boolean).join(' ') : undefined),
      subject: message['subject'] ?? conversation['subject'],
      body: message['text'] ?? message['body'] ?? message['blurb'],
    }),
  };
}

// ───────────────────────────── Slack ─────────────────────────────

/**
 * Slash command (`/customer-request jane@acme.com Needs SSO`): form fields `text`, `user_id`, `user_name`,
 * `channel_id`, `team_id`, `trigger_id`. The first email in the text is the requester; without one the request
 * waits in triage. Slack's reply is an ephemeral message.
 */
export function parseSlack(payload: unknown): ParsedIntake {
  if (!isObj(payload)) throw new IntakePayloadError('body must be form-encoded');
  const raw = str(payload['text']) ?? '';
  if (!raw || raw === 'help')
    return {
      kind: 'ping',
      response: { response_type: 'ephemeral', text: 'Usage: `/customer-request jane@acme.com what the customer asked for`. The email is optional; requests without one wait in the Trama inbox.' },
    };
  const email = extractEmail(raw);
  const body = (email ? raw.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '') : raw).replace(/\s+/g, ' ').trim();
  const team = str(payload['team_id']);
  const channel = str(payload['channel_id']);
  const user = str(payload['user_id']);
  const externalId =
    str(payload['trigger_id']) ?? `${team ?? ''}:${user ?? ''}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  return {
    kind: 'request',
    request: build({
      externalId,
      externalUrl: team && channel ? `https://app.slack.com/client/${team}/${channel}` : undefined,
      email,
      name: str(payload['user_name']) && !email ? `Slack: ${str(payload['user_name'])}` : undefined,
      body: body || raw,
    }),
  };
}

// ───────────────────────────── Email forward ─────────────────────────────

/**
 * A parsed inbound email as JSON. Postmark's inbound payload is read as-is (`From`, `FromName`, `FromFull`,
 * `Subject`, `TextBody`, `HtmlBody`, `MessageID`); the same fields in lower camel case (`from`, `fromName`,
 * `subject`, `text`, `html`, `messageId`) work for relays that reshape SendGrid / Mailgun / SES input.
 */
export function parseEmail(payload: unknown): ParsedIntake {
  if (!isObj(payload)) throw new IntakePayloadError('body must be a JSON object');
  const get = (...keys: string[]) => keys.map((k) => payload[k]).find((v) => str(v) !== undefined);
  const from = get('FromFull', 'From', 'from', 'sender');
  const fromEmail = isObj(from) ? from['Email'] : from;
  const fromName = (isObj(from) ? from['Name'] : undefined) ?? get('FromName', 'fromName', 'from_name') ?? displayName(fromEmail);
  const subject = get('Subject', 'subject');
  const body = get('StrippedTextReply', 'TextBody', 'text', 'body') ?? get('HtmlBody', 'html');
  const messageId =
    str(get('MessageID', 'messageId', 'message_id')) ??
    str(at(payload, 'headers', 'Message-ID')) ??
    createHash('sha256')
      .update(`${str(fromEmail) ?? ''}\n${str(subject) ?? ''}\n${str(body) ?? ''}`)
      .digest('hex')
      .slice(0, 32);
  return {
    kind: 'request',
    request: build({ externalId: messageId, email: fromEmail, name: fromName, subject, body }),
  };
}

// ───────────────────────────── Signed JSON webhook ─────────────────────────────

/** `{ externalId, body, subject?, externalUrl?, requesterEmail?, requesterName?, issueKey? }`. */
export function parseGeneric(payload: unknown): ParsedIntake {
  if (!isObj(payload)) throw new IntakePayloadError('body must be a JSON object');
  return {
    kind: 'request',
    request: build({
      externalId: str(payload['externalId']),
      externalUrl: payload['externalUrl'] ?? payload['url'],
      email: payload['requesterEmail'] ?? payload['email'],
      name: payload['requesterName'] ?? payload['name'],
      subject: payload['subject'],
      body: payload['body'],
      issueKey: payload['issueKey'],
    }),
  };
}

export function parseIntake(provider: IntakeProvider, payload: unknown, opts: ParseOptions = {}): ParsedIntake {
  switch (provider) {
    case 'intercom':
      return parseIntercom(payload);
    case 'zendesk':
      return parseZendesk(payload, opts);
    case 'front':
      return parseFront(payload);
    case 'slack':
      return parseSlack(payload);
    case 'email':
      return parseEmail(payload);
    case 'generic':
      return parseGeneric(payload);
  }
}

/** A representative delivery of each provider, used by the settings "test" button and by the specs. */
export function sampleDelivery(provider: IntakeProvider): { contentType: string; body: string } {
  const json = (v: unknown) => ({ contentType: 'application/json', body: JSON.stringify(v) });
  const stamp = Date.now();
  switch (provider) {
    case 'intercom':
      return json({
        type: 'notification_event',
        app_id: 'abc123',
        topic: 'conversation.user.created',
        data: { item: { type: 'conversation', id: `test-${stamp}`, source: { subject: 'Trama test', body: '<p>Can you add SSO?</p>', author: { type: 'user', name: 'Jane Test', email: 'jane@example.org' } } } },
      });
    case 'zendesk':
      return json({ ticket_id: `test-${stamp}`, subject: 'Trama test', description: 'Can you add SSO?', requester_email: 'jane@example.org', requester_name: 'Jane Test' });
    case 'front':
      return json({
        type: 'inbound_received',
        payload: { conversation: { id: `cnv_test${stamp}`, subject: 'Trama test' }, target: { data: { text: 'Can you add SSO?', recipients: [{ handle: 'jane@example.org', role: 'from', name: 'Jane Test' }] } } },
      });
    case 'slack':
      return { contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams({ text: 'jane@example.org Can you add SSO?', user_name: 'jane', team_id: 'T0TEST', channel_id: 'C0TEST', trigger_id: `test-${stamp}` }).toString() };
    case 'email':
      return json({ From: 'Jane Test <jane@example.org>', FromName: 'Jane Test', Subject: 'Trama test', TextBody: 'Can you add SSO?', MessageID: `test-${stamp}` });
    case 'generic':
      return json({ externalId: `test-${stamp}`, subject: 'Trama test', body: 'Can you add SSO?', requesterEmail: 'jane@example.org', requesterName: 'Jane Test' });
  }
}
