import { INTAKE_PROVIDERS } from '../contracts/domain.js';
import {
  IntakePayloadError,
  extractEmail,
  htmlToText,
  parseEmail,
  parseFront,
  parseGeneric,
  parseIntake,
  parseIntercom,
  parseSlack,
  parseZendesk,
  sampleDelivery,
} from './intake-parsers.js';

const request = (r: ReturnType<typeof parseIntercom>) => {
  if (r.kind !== 'request') throw new Error(`expected a request, got ${r.kind}`);
  return r.request;
};

describe('intake parsers', () => {
  it('Intercom: conversation.user.created becomes a request with a deep link', () => {
    const r = request(
      parseIntercom({
        topic: 'conversation.user.created',
        app_id: 'app1',
        data: { item: { id: '77', source: { subject: 'SSO', body: '<p>Need <b>SAML</b> &amp; SCIM</p>', author: { name: 'Jane', email: 'Jane@Acme.com' } } } },
      }),
    );
    expect(r).toEqual({
      externalId: '77',
      externalUrl: 'https://app.intercom.com/a/inbox/app1/inbox/conversation/77',
      requesterEmail: 'jane@acme.com',
      requesterName: 'Jane',
      subject: 'SSO',
      body: 'Need SAML & SCIM',
    });
  });

  it('Intercom: pings answer pong, other topics are ignored, a malformed one is an error', () => {
    expect(parseIntercom({ topic: 'ping' }).kind).toBe('ping');
    expect(parseIntercom({ topic: 'conversation.admin.replied' }).kind).toBe('ignored');
    expect(() => parseIntercom({ topic: 'conversation.user.created', data: {} })).toThrow(IntakePayloadError);
    expect(() => parseIntercom('nope')).toThrow(IntakePayloadError);
  });

  it('Zendesk: the documented trigger template', () => {
    const r = request(
      parseZendesk(
        { ticket_id: '1042', subject: 'Export is slow', description: 'CSV export times out', requester_email: 'ops@acme.com', requester_name: 'Ops' },
        { subdomain: 'acme' },
      ),
    );
    expect(r).toMatchObject({
      externalId: '1042',
      externalUrl: 'https://acme.zendesk.com/agent/tickets/1042',
      requesterEmail: 'ops@acme.com',
      subject: 'Export is slow',
      body: 'CSV export times out',
    });
  });

  it('Zendesk: an event payload has no email (it waits in triage); other events are ignored', () => {
    const r = request(parseZendesk({ type: 'zen:event-type:ticket.created', detail: { id: '9', subject: 'Hi', description: 'Help' } }));
    expect(r.externalId).toBe('9');
    expect(r.requesterEmail).toBeUndefined();
    expect(parseZendesk({ type: 'zen:event-type:ticket.status_changed', detail: { id: '9' } }).kind).toBe('ignored');
  });

  it('Zendesk: does not trust an API url from the payload as a link', () => {
    const r = request(parseZendesk({ ticket_id: '5', description: 'x', url: 'https://acme.zendesk.com/api/v2/tickets/5.json' }, { subdomain: 'acme' }));
    expect(r.externalUrl).toBe('https://acme.zendesk.com/agent/tickets/5');
  });

  it('Front: wrapped inbound_received keyed by the conversation', () => {
    const r = request(
      parseFront({
        type: 'inbound_received',
        payload: { conversation: { id: 'cnv_1', subject: 'Invoice' }, target: { data: { text: 'Where is it?', recipients: [{ role: 'to', handle: 'help@us.com' }, { role: 'from', handle: 'Pat@Acme.com', name: 'Pat' }] } } },
      }),
    );
    expect(r).toMatchObject({ externalId: 'cnv_1', externalUrl: 'https://app.frontapp.com/open/cnv_1', requesterEmail: 'pat@acme.com', requesterName: 'Pat', subject: 'Invoice', body: 'Where is it?' });
    expect(parseFront({ type: 'outbound_sent' }).kind).toBe('ignored');
  });

  it('Slack: slash command text with an email', () => {
    const r = request(parseSlack({ text: 'jane@acme.com needs SSO, asap', user_name: 'sam', team_id: 'T1', channel_id: 'C1', trigger_id: 'trg1' }));
    expect(r).toMatchObject({ externalId: 'trg1', requesterEmail: 'jane@acme.com', body: 'needs SSO, asap', externalUrl: 'https://app.slack.com/client/T1/C1' });
    const noEmail = request(parseSlack({ text: 'Dark mode please', user_name: 'sam', trigger_id: 't2' }));
    expect(noEmail.requesterEmail).toBeUndefined();
    expect(noEmail.requesterName).toBe('Slack: sam');
  });

  it('Slack: an empty command answers with usage instead of recording', () => {
    const r = parseSlack({ text: '' });
    expect(r.kind).toBe('ping');
    expect(r.kind === 'ping' && r.response?.['response_type']).toBe('ephemeral');
  });

  it('Email: Postmark inbound JSON', () => {
    const r = request(
      parseEmail({ From: 'jane@acme.com', FromName: 'Jane A', FromFull: { Email: 'Jane@Acme.com', Name: 'Jane A' }, Subject: 'Re: SSO', TextBody: 'Please add it', MessageID: 'abc-123' }),
    );
    expect(r).toMatchObject({ externalId: 'abc-123', requesterEmail: 'jane@acme.com', requesterName: 'Jane A', subject: 'Re: SSO', body: 'Please add it' });
  });

  it('Email: lower camel relay format, display-name sender and a stable id without a message id', () => {
    const payload = { from: 'Jane A <jane@acme.com>', subject: 'SSO', html: '<p>Hello</p>' };
    const a = request(parseEmail(payload));
    expect(a).toMatchObject({ requesterEmail: 'jane@acme.com', requesterName: 'Jane A', body: 'Hello' });
    expect(request(parseEmail(payload)).externalId).toBe(a.externalId);
    expect(request(parseEmail({ ...payload, subject: 'Other' })).externalId).not.toBe(a.externalId);
  });

  it('generic: needs an external id and some text; accepts an issue key', () => {
    const r = request(parseGeneric({ externalId: 'x-1', body: 'hi', requesterEmail: 'a@b.com', externalUrl: 'https://crm.example/1', issueKey: 'bug-7' }));
    expect(r).toMatchObject({ externalId: 'x-1', externalUrl: 'https://crm.example/1', issueKey: 'bug-7' });
    expect(() => parseGeneric({ body: 'hi' })).toThrow(IntakePayloadError);
    expect(() => parseGeneric({ externalId: 'x' })).toThrow(IntakePayloadError);
  });

  it('never keeps a non-http(s) link', () => {
    const r = request(parseGeneric({ externalId: 'x', body: 'hi', externalUrl: 'javascript:alert(1)' }));
    expect(r.externalUrl).toBeUndefined();
  });

  it('clamps oversized text', () => {
    const r = request(parseGeneric({ externalId: 'x'.repeat(500), body: 'y'.repeat(50_000), subject: 's'.repeat(1000) }));
    expect(r.externalId).toHaveLength(200);
    expect(r.body).toHaveLength(20_000);
    expect(r.subject).toHaveLength(300);
  });

  it('helpers', () => {
    expect(extractEmail('Jane <Jane@Acme.com>')).toBe('jane@acme.com');
    expect(extractEmail('no address')).toBeUndefined();
    expect(htmlToText('<style>p{}</style><p>a</p><p>b<br>c</p>')).toBe('a\nb\nc');
  });

  it('every provider parses its own sample delivery', () => {
    for (const provider of INTAKE_PROVIDERS) {
      const sample = sampleDelivery(provider);
      const payload = sample.contentType === 'application/json' ? (JSON.parse(sample.body) as unknown) : Object.fromEntries(new URLSearchParams(sample.body));
      const parsed = parseIntake(provider, payload);
      expect(parsed.kind, provider).toBe('request');
      expect(request(parsed).requesterEmail, provider).toBe('jane@example.org');
    }
  });
});
