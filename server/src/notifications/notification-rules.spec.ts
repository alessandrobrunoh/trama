import { planNotifications, type RuleContext } from './notification-rules.js';

const issue = {
  id: 'iss_1',
  key: 'BUG-142',
  title: 'Session expires',
  assigneeId: 'usr_dev',
  reporterId: 'usr_rep',
};

function ctx(
  over: Partial<RuleContext> & {
    type: string;
    data?: Record<string, unknown>;
    actor?: RuleContext['event']['actor'];
  },
): RuleContext {
  const { type, data, actor, ...rest } = over;
  return {
    event: {
      type,
      actor: actor ?? { type: 'user', id: 'usr_actor' },
      subject: { type: 'issue', id: 'iss_1' },
      data: data ?? {},
    },
    actorName: 'Maya',
    ...rest,
  };
}

describe('planNotifications', () => {
  it('tells a new assignee, unless they assigned it to themselves', () => {
    const drafts = planNotifications(
      ctx({
        type: 'issue.updated',
        issue,
        data: { assignee: { from: null, to: 'usr_dev' } },
      }),
    );
    expect(drafts).toEqual([
      expect.objectContaining({
        userId: 'usr_dev',
        kind: 'assigned',
        link: 'issues/BUG-142',
        title: 'Maya assigned you BUG-142: Session expires',
      }),
    ]);
    expect(
      planNotifications(
        ctx({
          type: 'issue.updated',
          issue,
          actor: { type: 'user', id: 'usr_dev' },
          data: { assignee: { to: 'usr_dev' } },
        }),
      ),
    ).toEqual([]);
    expect(
      planNotifications(
        ctx({ type: 'issue.updated', issue, data: { fields: ['title'] } }),
      ),
    ).toEqual([]);
  });

  it('assigns on creation too', () => {
    const drafts = planNotifications(
      ctx({ type: 'issue.created', issue, data: { assigneeId: 'usr_dev' } }),
    );
    expect(drafts.map((d) => [d.userId, d.kind])).toEqual([
      ['usr_dev', 'assigned'],
    ]);
  });

  it('sends an Issue input request to its assignee', () => {
    const drafts = planNotifications(
      ctx({
        type: 'input.requested',
        issue,
        data: { question: 'Drop Safari 16?', assigneeUserId: 'usr_ask' },
      }),
    );
    expect(drafts).toEqual([
      expect.objectContaining({
        userId: 'usr_ask',
        kind: 'input_requested',
        body: 'Drop Safari 16?',
        link: 'issues/BUG-142',
      }),
    ]);
  });

  it('comments notify the assignee and the reporter once each, never the author', () => {
    const base = {
      type: 'comment.created',
      issue,
      data: { excerpt: 'Looks like a race' },
    };
    expect(
      planNotifications(ctx(base))
        .map((d) => d.userId)
        .sort(),
    ).toEqual(['usr_dev', 'usr_rep']);
    const byAssignee = planNotifications(
      ctx({ ...base, actor: { type: 'user', id: 'usr_dev' } }),
    );
    expect(byAssignee.map((d) => d.userId)).toEqual(['usr_rep']);
    const same = planNotifications(
      ctx({ ...base, issue: { ...issue, reporterId: 'usr_dev' } }),
    );
    expect(same.map((d) => d.userId)).toEqual(['usr_dev']); // one message even if assignee and reporter coincide
  });

  it('flags review requests and failing CI for the Issue assignee', () => {
    const artifact = { type: 'artifact', id: 'ar_1' } as const;
    const review = planNotifications({
      event: {
        type: 'review.requested',
        actor: { type: 'agent', id: 'ag_1' },
        subject: artifact,
        data: { title: 'PR #318' },
      },
      actorName: 'x',
      issue,
    });
    expect(review).toEqual([
      expect.objectContaining({
        userId: 'usr_dev',
        kind: 'review_requested',
        title: 'Review requested: PR #318',
        link: 'issues/BUG-142',
      }),
    ]);
    const failing = planNotifications({
      event: {
        type: 'artifact.updated',
        actor: { type: 'system' },
        subject: artifact,
        data: { title: 'PR #318', changes: { ci: ['pending', 'failing'] } },
      },
      actorName: 'Trama',
      issue,
    });
    expect(failing.map((d) => d.kind)).toEqual(['ci_failed']);
    const passing = planNotifications({
      event: {
        type: 'artifact.updated',
        actor: { type: 'system' },
        subject: artifact,
        data: { title: 'PR #318', changes: { ci: ['failing', 'passing'] } },
      },
      actorName: 'Trama',
      issue,
    });
    expect(passing).toEqual([]);
  });

  it('tells the Issue assignee about a proposed decision', () => {
    const drafts = planNotifications({
      event: {
        type: 'decision.proposed',
        actor: { type: 'agent', id: 'ag_1' },
        subject: { type: 'decision', id: 'dc_1' },
        data: {},
      },
      actorName: 'claude-code',
      decision: { id: 'dc_1', key: 'ADR-23', title: 'Hash refresh tokens' },
      issue,
    });
    expect(drafts).toEqual([
      expect.objectContaining({
        userId: 'usr_dev',
        kind: 'decision_proposed',
        link: 'decisions/ADR-23',
      }),
    ]);
  });

  it('says nothing when an Issue has no assignee', () => {
    const none = planNotifications(
      ctx({
        type: 'input.requested',
        issue: { ...issue, assigneeId: null },
        data: { question: 'Who?' },
      }),
    );
    expect(none).toEqual([]);
  });
  describe('customers', () => {
    const acme = {
      id: 'cus_1',
      name: 'Acme',
      subscriberIds: ['usr_a', 'usr_b', 'usr_actor'],
    };
    const event = (
      type: string,
      data: Record<string, unknown>,
    ): RuleContext['event'] => ({
      type,
      actor: { type: 'user', id: 'usr_actor' },
      subject: { type: 'customer_request', id: 'crq_1' },
      data: { customerId: 'cus_1', issueKey: 'BUG-142', ...data },
    });
    const request = (
      type: string,
      data: Record<string, unknown>,
    ): RuleContext => ({
      event: event(type, data),
      actorName: 'Maya',
      customer: acme,
    });

    it('tells followers about a new request, never the author', () => {
      const drafts = planNotifications(
        request('customer_request.linked', {
          important: false,
          excerpt: 'We need SSO',
        }),
      );
      expect(drafts.map((d) => [d.userId, d.kind])).toEqual([
        ['usr_a', 'customer_request'],
        ['usr_b', 'customer_request'],
      ]);
      expect(drafts[0]).toMatchObject({
        link: 'customers/cus_1',
        body: 'We need SSO',
        subject: { type: 'customer', id: 'cus_1' },
      });
      expect(drafts[0].title).toBe('Maya added a request from Acme: BUG-142');
    });

    it('uses the stronger kind when a request is added already important', () => {
      const drafts = planNotifications(
        request('customer_request.linked', { important: true }),
      );
      expect(drafts.map((d) => d.kind)).toEqual([
        'customer_important',
        'customer_important',
      ]);
    });

    it('notifies when a request is flagged important, and only then', () => {
      const flagged = planNotifications(
        request('customer_request.updated', {
          fields: ['important'],
          important: true,
        }),
      );
      expect(flagged.map((d) => d.kind)).toEqual([
        'customer_important',
        'customer_important',
      ]);
      expect(
        planNotifications(
          request('customer_request.updated', {
            fields: ['important'],
            important: false,
          }),
        ),
      ).toEqual([]);
      expect(
        planNotifications(
          request('customer_request.updated', {
            fields: ['body'],
            important: true,
          }),
        ),
      ).toEqual([]);
    });

    it('closes the loop: followers and whoever recorded the requests hear about the delivery once', () => {
      const drafts = planNotifications({
        event: {
          type: 'issue.status_changed',
          actor: { type: 'user', id: 'usr_actor' },
          subject: { type: 'issue', id: 'iss_1' },
          data: { to: 'done' },
        },
        actorName: 'Maya',
        delivery: {
          target: {
            type: 'issue',
            id: 'iss_1',
            label: 'BUG-142: Session expires',
            link: 'issues/BUG-142',
          },
          customers: [
            { id: 'cus_1', name: 'Acme', subscriberIds: ['usr_a'] },
            { id: 'cus_2', name: 'Beta', subscriberIds: ['usr_a', 'usr_c'] },
            { id: 'cus_3', name: 'Gamma', subscriberIds: [] },
          ],
          requesterIds: ['usr_c', 'usr_d', 'usr_actor'],
        },
      });
      expect(drafts.map((d) => d.userId).sort()).toEqual([
        'usr_a',
        'usr_c',
        'usr_d',
      ]);
      expect(
        drafts.every(
          (d) => d.kind === 'customer_delivered' && d.link === 'issues/BUG-142',
        ),
      ).toBe(true);
      expect(drafts[0].title).toBe(
        'BUG-142: Session expires was delivered: Acme, Beta and 1 more asked for it',
      );
      expect(drafts[0].subject).toEqual({ type: 'issue', id: 'iss_1' });
    });

    it('says nothing without a customer behind the work', () => {
      const none = planNotifications({
        event: {
          type: 'project.status_changed',
          actor: { type: 'user', id: 'usr_actor' },
          subject: { type: 'project', id: 'pj_1' },
          data: { to: 'completed' },
        },
        actorName: 'Maya',
      });
      expect(none).toEqual([]);
    });
  });
});
