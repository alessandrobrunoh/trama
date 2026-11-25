import { PayloadError, bitbucketCi, githubCi, gitlabCi, parseBitbucketEvent, parseGithubEvent, parseGitlabEvent } from './events.js';
import { bbCommitStatus, bbPullRequest, ghCheckRun, ghCheckSuite, ghIssue, ghPullRequest, ghStatus, glIssue, glMergeRequest, glPipeline } from './fixtures.js';

describe('GitHub payload mapping', () => {
  it('maps an opened PR', () => {
    const r = parseGithubEvent('pull_request', ghPullRequest());
    if (r.kind !== 'pr') throw new Error('expected pr');
    expect(r.repo.fullName).toBe('acme/auth-service');
    expect(r.candidate).toMatchObject({
      kind: 'pull_request', provider: 'github', externalId: '#182', state: 'open', headBranch: 'auth-42/rotation', hasConflicts: undefined,
    });
    expect(r.candidate.texts.join(' ')).toContain('AUTH-42');
    expect(r.candidate.branchTexts).toEqual(['auth-42/rotation']);
  });
  it('maps draft, closed and merged states', () => {
    const state = (over: Record<string, unknown>, action = 'edited') => {
      const r = parseGithubEvent('pull_request', ghPullRequest(over, action));
      return r.kind === 'pr' ? r.candidate.state : undefined;
    };
    expect(state({ draft: true })).toBe('draft');
    expect(state({ state: 'closed' }, 'closed')).toBe('closed');
    expect(state({ state: 'closed', merged: true }, 'closed')).toBe('merged');
  });
  it('maps conflicts, new commits and review requests', () => {
    const get = (over: Record<string, unknown>, action: string) => {
      const r = parseGithubEvent('pull_request', ghPullRequest(over, action));
      if (r.kind !== 'pr') throw new Error('expected pr');
      return r.candidate;
    };
    expect(get({ mergeable_state: 'dirty', mergeable: false }, 'edited').hasConflicts).toBe(true);
    expect(get({ mergeable: true }, 'edited').hasConflicts).toBe(false);
    expect(get({}, 'synchronize').ci).toBe('pending');
    expect(get({ requested_reviewers: [{ login: 'x' }] }, 'review_requested').review).toBe('requested');
    expect(get({ requested_reviewers: [{ login: 'x' }] }, 'opened')).toMatchObject({ review: 'requested', reviewOnlyFrom: ['none'] });
    expect(get({}, 'review_request_removed')).toMatchObject({ review: 'none', reviewOnlyFrom: ['requested'] });
  });
  it('reports who was asked to review and who sent the event', () => {
    const get = (payload: unknown) => {
      const r = parseGithubEvent('pull_request', payload);
      if (r.kind !== 'pr') throw new Error('expected pr');
      return r.candidate;
    };
    const asked = get({
      ...ghPullRequest({ requested_reviewers: [{ login: 'Bob-GH' }, { login: 'Eve' }] }, 'review_requested'),
      requested_reviewer: { login: 'Bob-GH' },
      sender: { login: 'Ada-GH' },
    });
    expect(asked.reviewerLogins).toEqual(['Bob-GH']); // only the one this event asked
    expect(asked.actorLogin).toBe('Ada-GH');
    const opened = get(ghPullRequest({ requested_reviewers: [{ login: 'Bob-GH' }, { login: 'Eve' }, { login: 'Bob-GH' }] }));
    expect(opened.reviewerLogins).toEqual(['Bob-GH', 'Eve']);
    const none = get(ghPullRequest());
    expect(none.reviewerLogins).toBeUndefined();
    expect(none.actorLogin).toBeUndefined();
  });
  it('maps CI from check_suite, check_run and status', () => {
    const ci = (e: string, p: unknown) => {
      const r = parseGithubEvent(e, p);
      return r.kind === 'ci' ? r.patch.ci : r.kind;
    };
    expect(ci('check_suite', ghCheckSuite('success'))).toBe('passing');
    expect(ci('check_suite', ghCheckSuite('failure'))).toBe('failing');
    expect(ci('check_suite', ghCheckSuite(null, 'in_progress'))).toBe('pending');
    expect(ci('check_run', ghCheckRun('timed_out'))).toBe('failing');
    expect(ci('check_run', ghCheckRun('skipped'))).toBe('passing');
    expect(ci('status', ghStatus('error'))).toBe('failing');
    expect(ci('status', ghStatus('success'))).toBe('passing');
    expect(ci('status', ghStatus('pending'))).toBe('pending');
    const suite = parseGithubEvent('check_suite', ghCheckSuite('success'));
    expect(suite.kind === 'ci' && suite.patch).toMatchObject({ sha: 'a'.repeat(40), prExternalIds: ['#182'] });
    expect(githubCi('completed', 'cancelled')).toBe('pending');
  });
  it('maps issues with their labels, milestone, author and close reason', () => {
    const open = parseGithubEvent('issues', ghIssue({ milestone: { title: 'v1.2' } }));
    if (open.kind !== 'issue') throw new Error('expected issue');
    expect(open.repo.fullName).toBe('acme/auth-service');
    expect(open.issue).toMatchObject({
      provider: 'github', externalId: '#31', number: 31, state: 'open', labels: ['bug'], milestone: 'v1.2', author: 'octo',
    });
    const closed = parseGithubEvent('issues', ghIssue({ state: 'closed', state_reason: 'not_planned' }, 'closed'));
    expect(closed.kind === 'issue' && closed.issue).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    const done = parseGithubEvent('issues', ghIssue({ state: 'closed' }, 'closed'));
    expect(done.kind === 'issue' && done.issue.stateReason).toBe('completed');
    expect(parseGithubEvent('issues', ghIssue({ pull_request: {} })).kind).toBe('ignored');
    expect(parseGithubEvent('issues', ghIssue({}, 'assigned')).kind).toBe('ignored');
    expect(() => parseGithubEvent('issues', { action: 'opened' })).toThrow(PayloadError);
  });
  it('carries labels and milestone of a pull request for routing', () => {
    const r = parseGithubEvent('pull_request', ghPullRequest({ labels: [{ name: 'frontend' }], milestone: { title: 'v2' } }));
    expect(r.kind === 'pr' && r.meta).toEqual({ labels: ['frontend'], milestone: 'v2' });
  });
  it('ignores unhandled events/actions, answers ping, rejects malformed payloads', () => {
    expect(parseGithubEvent('ping', {}).kind).toBe('ping');
    expect(parseGithubEvent('push', {}).kind).toBe('ignored');
    expect(parseGithubEvent('pull_request', ghPullRequest({}, 'labeled')).kind).toBe('ignored');
    expect(() => parseGithubEvent('pull_request', { action: 'opened' })).toThrow(PayloadError);
    expect(() => parseGithubEvent('check_suite', { check_suite: { head_sha: 1 }, repository: {} })).toThrow(PayloadError);
    expect(() => parseGithubEvent('status', null)).toThrow(PayloadError);
  });
});

describe('GitLab payload mapping', () => {
  const mr = (attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const r = parseGitlabEvent(glMergeRequest(attrs, extra));
    if (r.kind !== 'pr') throw new Error('expected pr');
    return r.candidate;
  };
  it('maps an opened MR', () => {
    expect(mr()).toMatchObject({
      kind: 'merge_request', provider: 'gitlab', externalId: '!12', state: 'open', headSha: 'b'.repeat(40), headBranch: 'web-7/ttl', hasConflicts: false,
    });
  });
  it('maps states, drafts, conflicts, approvals and new commits', () => {
    expect(mr({ state: 'merged', action: 'merge' }).state).toBe('merged');
    expect(mr({ state: 'closed', action: 'close' }).state).toBe('closed');
    expect(mr({ draft: true }).state).toBe('draft');
    expect(mr({ detailed_merge_status: 'conflict', merge_status: 'cannot_be_merged' }).hasConflicts).toBe(true);
    expect(mr({ action: 'approved' }).review).toBe('approved');
    expect(mr({ action: 'unapproved' })).toMatchObject({ review: 'none', reviewOnlyFrom: ['approved'] });
    expect(mr({ action: 'open' }, { reviewers: [{ id: 1 }] })).toMatchObject({ review: 'requested', reviewOnlyFrom: ['none'] });
    expect(mr({ action: 'update', oldrev: 'abc' }).ci).toBe('pending');
  });
  it('reports reviewers and the user behind the event', () => {
    const c = mr({ action: 'open' }, { reviewers: [{ username: 'bob' }, { id: 3 }], user: { username: 'ada' } });
    expect(c.reviewerLogins).toEqual(['bob']);
    expect(c.actorLogin).toBe('ada');
  });
  it('maps pipelines', () => {
    const ci = (status: string, iid?: number) => {
      const r = parseGitlabEvent(glPipeline(status, iid));
      return r.kind === 'ci' ? r.patch : r.kind;
    };
    expect(ci('success', 12)).toMatchObject({ ci: 'passing', prExternalIds: ['!12'], sha: 'b'.repeat(40) });
    expect(ci('failed')).toMatchObject({ ci: 'failing', prExternalIds: [] });
    expect(ci('running')).toMatchObject({ ci: 'pending' });
    expect(gitlabCi('canceled')).toBe('pending');
  });
  it('maps issues', () => {
    const open = parseGitlabEvent(glIssue());
    expect(open.kind === 'issue' && open.issue).toMatchObject({
      provider: 'gitlab', externalId: '#5', state: 'open', labels: ['bug'], author: 'tanuki',
    });
    expect(open.kind === 'issue' && open.repo.fullName).toBe('acme-internal/mobile-app');
    const closed = parseGitlabEvent(glIssue({ state: 'closed', action: 'close' }));
    expect(closed.kind === 'issue' && closed.issue.state).toBe('closed');
    expect(parseGitlabEvent(glIssue({ action: 'move' })).kind).toBe('ignored');
    expect(() => parseGitlabEvent(glIssue({ iid: 'x' }))).toThrow(PayloadError);
  });
  it('ignores unhandled kinds and rejects malformed payloads', () => {
    expect(parseGitlabEvent({ object_kind: 'push', project: {} }).kind).toBe('ignored');
    expect(() => parseGitlabEvent({})).toThrow(PayloadError);
    expect(() => parseGitlabEvent({ object_kind: 'merge_request', project: {}, object_attributes: {} })).toThrow(PayloadError);
  });
});

describe('Bitbucket payload mapping', () => {
  const pr = (event: string, attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const r = parseBitbucketEvent(event, bbPullRequest(attrs, extra));
    if (r.kind !== 'pr') throw new Error('expected pr');
    return r;
  };
  it('maps a created PR with its repository', () => {
    const r = pr('pullrequest:created');
    expect(r.repo).toEqual({ fullName: 'acme-bb/payments', url: 'https://bitbucket.org/acme-bb/payments', defaultBranch: 'main' });
    expect(r.candidate).toMatchObject({
      kind: 'pull_request', provider: 'bitbucket', externalId: '#21', state: 'open', headSha: 'c'.repeat(40), headBranch: 'pay-3/retry',
      url: 'https://bitbucket.org/acme-bb/payments/pull-requests/21',
    });
  });
  it('maps states, drafts and reviews', () => {
    expect(pr('pullrequest:fulfilled', { state: 'MERGED' }).candidate.state).toBe('merged');
    expect(pr('pullrequest:rejected', { state: 'DECLINED' }).candidate.state).toBe('closed');
    expect(pr('pullrequest:updated', { draft: true }).candidate.state).toBe('draft');
    expect(pr('pullrequest:approved').candidate.review).toBe('approved');
    expect(pr('pullrequest:unapproved').candidate).toMatchObject({ review: 'none', reviewOnlyFrom: ['approved'] });
    expect(pr('pullrequest:unapproved', { reviewers: [{ uuid: 'x' }] }).candidate.review).toBe('requested');
    expect(pr('pullrequest:changes_request_created').candidate.review).toBe('changes_requested');
    expect(pr('pullrequest:created', { reviewers: [{ uuid: 'x' }] }).candidate).toMatchObject({ review: 'requested', reviewOnlyFrom: ['none'] });
  });
  it('reports reviewers and the actor by nickname', () => {
    const c = pr('pullrequest:created', { reviewers: [{ nickname: 'bob' }, { uuid: 'x' }] }, { actor: { nickname: 'ada' } }).candidate;
    expect(c.reviewerLogins).toEqual(['bob']);
    expect(c.actorLogin).toBe('ada');
  });
  it('maps build statuses', () => {
    const ci = (state: string) => {
      const r = parseBitbucketEvent('repo:commit_status_updated', bbCommitStatus(state));
      return r.kind === 'ci' ? r.patch : r.kind;
    };
    expect(ci('SUCCESSFUL')).toMatchObject({ ci: 'passing', sha: 'c'.repeat(40) });
    expect(ci('FAILED')).toMatchObject({ ci: 'failing' });
    expect(ci('INPROGRESS')).toMatchObject({ ci: 'pending' });
    expect(bitbucketCi('STOPPED')).toBe('pending');
  });
  it('answers pings, ignores unhandled events and rejects malformed payloads', () => {
    expect(parseBitbucketEvent('diagnostics:ping', {}).kind).toBe('ping');
    expect(parseBitbucketEvent('pullrequest:comment_created', bbPullRequest()).kind).toBe('ignored');
    expect(parseBitbucketEvent('repo:push', {}).kind).toBe('ignored');
    expect(() => parseBitbucketEvent('pullrequest:created', {})).toThrow(PayloadError);
    expect(() => parseBitbucketEvent('pullrequest:created', { repository: {}, pullrequest: {} })).toThrow(PayloadError);
  });
});
