import { PayloadError, bitbucketCi, githubCi, gitlabCi, parseBitbucketEvent, parseGithubEvent, parseGitlabEvent } from './events.js';
import { bbCommitStatus, bbPullRequest, ghCheckRun, ghCheckSuite, ghPullRequest, ghStatus, glMergeRequest, glPipeline } from './fixtures.js';

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
  it('ignores unhandled events/actions, answers ping, rejects malformed payloads', () => {
    expect(parseGithubEvent('ping', {}).kind).toBe('ping');
    expect(parseGithubEvent('issues', {}).kind).toBe('ignored');
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
