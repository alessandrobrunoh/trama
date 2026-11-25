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
        link: 'tasks/BUG-142',
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
        link: 'tasks/BUG-142',
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

  it('says nothing when an Issue has no assignee', () => {
    const none = planNotifications(
      ctx({
        type: 'review.requested',
        issue: { ...issue, assigneeId: null },
        data: { title: 'PR #318' },
      }),
    );
    expect(none).toEqual([]);
  });

  it('sends a review request to the people it was asked from, not the assignee', () => {
    const drafts = planNotifications(
      ctx({
        type: 'review.requested',
        actor: { type: 'system' },
        issue,
        data: { title: 'PR #318', reviewerUserIds: ['usr_a', 'usr_b', 'usr_a', 7, ''] },
      }),
    );
    expect(drafts.map((d) => [d.userId, d.kind])).toEqual([
      ['usr_a', 'review_requested'],
      ['usr_b', 'review_requested'],
    ]);
  });

  it('keeps the actor out of their own review request and falls back to the assignee when none is known', () => {
    const own = planNotifications(
      ctx({
        type: 'review.requested',
        actor: { type: 'user', id: 'usr_a' },
        issue,
        data: { reviewerUserIds: ['usr_a'] },
      }),
    );
    expect(own).toEqual([]);
    const unknown = planNotifications(
      ctx({ type: 'review.requested', issue, data: { reviewerUserIds: [] } }),
    );
    expect(unknown.map((d) => d.userId)).toEqual(['usr_dev']);
  });

  it('ignores retired customer, decision, and input events', () => {
    for (const type of [
      'input.requested',
      'decision.proposed',
      'customer_request.linked',
      'customer_request.updated',
      'issue.status_changed',
      'project.status_changed',
    ]) {
      expect(
        planNotifications(
          ctx({
            type,
            issue,
            data: { to: 'done', important: true, assigneeUserId: 'usr_ask' },
          }),
        ),
      ).toEqual([]);
    }
  });
});
