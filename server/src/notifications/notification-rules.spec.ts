import { planNotifications, type RuleContext } from './notification-rules.js';

const ws = { id: 'wk_1', key: 'AUTH-12', title: 'Stabilize authentication', accountableUserId: 'usr_acc' };
const issue = { id: 'iss_1', key: 'BUG-142', title: 'Session expires', assigneeId: 'usr_dev', reporterId: 'usr_rep' };

function ctx(over: Partial<RuleContext> & { type: string; data?: Record<string, unknown>; actor?: RuleContext['event']['actor'] }): RuleContext {
  const { type, data, actor, ...rest } = over;
  return {
    event: { type, actor: actor ?? { type: 'user', id: 'usr_actor' }, subject: { type: 'issue', id: 'iss_1' }, data: data ?? {} },
    actorName: 'Maya',
    ...rest,
  };
}

describe('planNotifications', () => {
  it('tells a new assignee, unless they assigned it to themselves', () => {
    const drafts = planNotifications(ctx({ type: 'issue.updated', issue, data: { assignee: { from: null, to: 'usr_dev' } } }));
    expect(drafts).toEqual([
      expect.objectContaining({ userId: 'usr_dev', kind: 'assigned', link: 'issues/BUG-142', title: 'Maya assigned you BUG-142: Session expires' }),
    ]);
    expect(planNotifications(ctx({ type: 'issue.updated', issue, actor: { type: 'user', id: 'usr_dev' }, data: { assignee: { to: 'usr_dev' } } }))).toEqual([]);
    expect(planNotifications(ctx({ type: 'issue.updated', issue, data: { fields: ['title'] } }))).toEqual([]);
  });

  it('assigns on creation too', () => {
    const drafts = planNotifications(ctx({ type: 'issue.created', issue, data: { assigneeId: 'usr_dev' } }));
    expect(drafts.map((d) => [d.userId, d.kind])).toEqual([['usr_dev', 'assigned']]);
  });

  it('sends a question to its assignee, else to whoever is accountable', () => {
    const base = { type: 'input.requested', workstream: ws };
    const toAssignee = planNotifications(ctx({ ...base, data: { question: 'Drop Safari 16?', assigneeUserId: 'usr_ask' } }));
    expect(toAssignee).toEqual([expect.objectContaining({ userId: 'usr_ask', kind: 'input_requested', body: 'Drop Safari 16?', link: 'workstreams/AUTH-12' })]);
    const toAccountable = planNotifications(ctx({ ...base, data: { question: 'Ship it?' } }));
    expect(toAccountable[0].userId).toBe('usr_acc');
  });

  it('comments notify the assignee and the reporter once each, never the author', () => {
    const base = { type: 'comment.created', issue, data: { excerpt: 'Looks like a race' } };
    expect(planNotifications(ctx(base)).map((d) => d.userId).sort()).toEqual(['usr_dev', 'usr_rep']);
    const byAssignee = planNotifications(ctx({ ...base, actor: { type: 'user', id: 'usr_dev' } }));
    expect(byAssignee.map((d) => d.userId)).toEqual(['usr_rep']);
    const same = planNotifications(ctx({ ...base, issue: { ...issue, reporterId: 'usr_dev' } }));
    expect(same.map((d) => d.userId)).toEqual(['usr_dev']); // one message even if assignee and reporter coincide
  });

  it('comments on a workstream go to the accountable person', () => {
    const drafts = planNotifications({
      event: { type: 'comment.created', actor: { type: 'agent', id: 'ag_1' }, subject: { type: 'workstream', id: 'wk_1' }, data: { excerpt: 'Done' } },
      actorName: 'claude-code',
      workstream: ws,
    });
    expect(drafts).toEqual([expect.objectContaining({ userId: 'usr_acc', kind: 'comment', link: 'workstreams/AUTH-12' })]);
  });

  it('flags review requests and failing CI for the accountable person', () => {
    const artifact = { type: 'artifact', id: 'ar_1' } as const;
    const review = planNotifications({ event: { type: 'review.requested', actor: { type: 'agent', id: 'ag_1' }, subject: artifact, data: { title: 'PR #318' } }, actorName: 'x', workstream: ws });
    expect(review).toEqual([expect.objectContaining({ userId: 'usr_acc', kind: 'review_requested', title: 'Review requested: PR #318' })]);
    const failing = planNotifications({ event: { type: 'artifact.updated', actor: { type: 'system' }, subject: artifact, data: { title: 'PR #318', changes: { ci: ['pending', 'failing'] } } }, actorName: 'Trama', workstream: ws });
    expect(failing.map((d) => d.kind)).toEqual(['ci_failed']);
    const passing = planNotifications({ event: { type: 'artifact.updated', actor: { type: 'system' }, subject: artifact, data: { title: 'PR #318', changes: { ci: ['failing', 'passing'] } } }, actorName: 'Trama', workstream: ws });
    expect(passing).toEqual([]);
  });

  it('announces only the status changes that matter', () => {
    const at = (to: string) => planNotifications({ event: { type: 'workstream.status_changed', actor: { type: 'system' }, subject: { type: 'workstream', id: 'wk_1' }, data: { to } }, actorName: 'Trama', workstream: ws });
    expect(at('shipped')[0]).toMatchObject({ kind: 'workstream_update', title: 'AUTH-12 shipped' });
    expect(at('blocked')[0].title).toBe('AUTH-12 is blocked');
    expect(at('ready_to_land')[0].title).toBe('AUTH-12 is ready to land');
    expect(at('working')).toEqual([]);
  });

  it('tells the accountable person about a proposed decision', () => {
    const drafts = planNotifications({
      event: { type: 'decision.proposed', actor: { type: 'agent', id: 'ag_1' }, subject: { type: 'decision', id: 'dc_1' }, data: {} },
      actorName: 'claude-code',
      decision: { id: 'dc_1', key: 'ADR-23', title: 'Hash refresh tokens' },
      workstream: ws,
    });
    expect(drafts).toEqual([expect.objectContaining({ userId: 'usr_acc', kind: 'decision_proposed', link: 'decisions/ADR-23' })]);
  });

  it('says nothing when nobody is responsible', () => {
    const none = planNotifications(ctx({ type: 'input.requested', workstream: { ...ws, accountableUserId: null }, data: { question: 'Who?' } }));
    expect(none).toEqual([]);
  });
});
