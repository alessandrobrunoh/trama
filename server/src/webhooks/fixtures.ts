/** Trimmed payloads in the shape GitHub / GitLab documents, shared by unit and e2e tests. */
export const ghRepo = { full_name: 'acme/auth-service', html_url: 'https://github.com/acme/auth-service', default_branch: 'main' };

export function ghPullRequest(over: Record<string, unknown> = {}, action = 'opened') {
  return {
    action,
    number: 182,
    repository: ghRepo,
    pull_request: {
      number: 182,
      title: 'AUTH-42: Implement refresh token rotation',
      body: 'Rotates refresh tokens.\n\nCloses AUTH-42',
      state: 'open',
      draft: false,
      merged: false,
      mergeable: null,
      mergeable_state: 'unknown',
      html_url: 'https://github.com/acme/auth-service/pull/182',
      head: { sha: 'a'.repeat(40), ref: 'auth-42/rotation' },
      requested_reviewers: [],
      requested_teams: [],
      ...over,
    },
  };
}

export const ghCheckSuite = (conclusion: string | null, status = 'completed', sha = 'a'.repeat(40)) => ({
  action: status === 'completed' ? 'completed' : 'requested',
  repository: ghRepo,
  check_suite: { status, conclusion, head_sha: sha, head_branch: 'auth-42/rotation', pull_requests: [{ number: 182 }] },
});

export const ghCheckRun = (conclusion: string | null, status = 'completed') => ({
  action: 'completed',
  repository: ghRepo,
  check_run: { status, conclusion, head_sha: 'a'.repeat(40), pull_requests: [] },
});

export const ghStatus = (state: string) => ({ state, sha: 'a'.repeat(40), repository: ghRepo });

export const glProject = { path_with_namespace: 'acme-internal/mobile-app', web_url: 'https://gitlab.com/acme-internal/mobile-app', default_branch: 'main' };

export function glMergeRequest(attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    object_kind: 'merge_request',
    project: glProject,
    reviewers: [],
    object_attributes: {
      iid: 12,
      title: 'WEB-7: Session TTL handling',
      description: 'Handles TTL',
      state: 'opened',
      action: 'open',
      source_branch: 'web-7/ttl',
      url: 'https://gitlab.com/acme-internal/mobile-app/-/merge_requests/12',
      last_commit: { id: 'b'.repeat(40) },
      merge_status: 'can_be_merged',
      ...attrs,
    },
    ...extra,
  };
}

export const glPipeline = (status: string, mrIid?: number) => ({
  object_kind: 'pipeline',
  project: glProject,
  object_attributes: { id: 99, status, sha: 'b'.repeat(40), ref: 'web-7/ttl' },
  ...(mrIid ? { merge_request: { iid: mrIid } } : {}),
});

export const bbRepo = {
  full_name: 'acme-bb/payments',
  links: { html: { href: 'https://bitbucket.org/acme-bb/payments' } },
  mainbranch: { name: 'main' },
  is_private: true,
};

export function bbPullRequest(attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    repository: bbRepo,
    pullrequest: {
      id: 21,
      title: 'PAY-3: Retry failed charges',
      description: 'Retries',
      state: 'OPEN',
      source: { branch: { name: 'pay-3/retry' }, commit: { hash: 'c'.repeat(40) } },
      links: { html: { href: 'https://bitbucket.org/acme-bb/payments/pull-requests/21' } },
      reviewers: [],
      ...attrs,
    },
    ...extra,
  };
}

export const bbCommitStatus = (state: string) => ({
  repository: bbRepo,
  commit_status: { state, commit: { hash: 'c'.repeat(40) }, refname: 'pay-3/retry' },
});
