import type { ArtifactState, CiState } from '../contracts/domain.js';
import type { ArtifactCandidate, CiPatch, IssueCandidate, ItemMeta, RepoMeta } from '../integrations/candidates.js';

/** The payload is not the shape the provider documents (→ HTTP 400). */
export class PayloadError extends Error {}

export type ParsedEvent =
  | { kind: 'ignored'; reason: string }
  | { kind: 'ping' }
  | { kind: 'pr'; repo: RepoMeta; candidate: ArtifactCandidate; meta?: ItemMeta }
  | { kind: 'issue'; repo: RepoMeta; issue: IssueCandidate }
  | { kind: 'ci'; repo: RepoMeta; patch: CiPatch };

type Obj = Record<string, unknown>;

function obj(v: unknown, name: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new PayloadError(`"${name}" must be an object`);
  return v as Obj;
}
function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new PayloadError(`"${name}" must be a non-empty string`);
  return v;
}
function num(v: unknown, name: string): number {
  if (typeof v !== 'number') throw new PayloadError(`"${name}" must be a number`);
  return v;
}
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** `x[key]` of an object-ish value when it is a non-empty string. */
const field = (v: unknown, key: string): string | undefined =>
  typeof v === 'object' && v !== null ? optStr((v as Obj)[key]) : undefined;
/** The non-empty string `key` of every object in a list, without duplicates. */
const fieldsOf = (list: unknown, ...keys: string[]): string[] => [
  ...new Set(
    arr(list).flatMap((x) => {
      const found = keys.map((k) => field(x, k)).find((s) => s !== undefined);
      return found ? [found] : [];
    }),
  ),
];
/** `{ reviewerLogins }` only when there is something to say, so candidates stay as small as before. */
const withLogins = (c: ArtifactCandidate, reviewers: string[], actor: string | undefined): void => {
  if (reviewers.length) c.reviewerLogins = reviewers;
  if (actor) c.actorLogin = actor;
};

// ───────────────────────────── GitHub ─────────────────────────────

const GH_CI_FAILING = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const GH_CI_PASSING = new Set(['success', 'neutral', 'skipped']);

export function githubCi(status: unknown, conclusion: unknown): CiState {
  if (status !== undefined && status !== 'completed') return 'pending';
  if (typeof conclusion === 'string') {
    if (GH_CI_FAILING.has(conclusion)) return 'failing';
    if (GH_CI_PASSING.has(conclusion)) return 'passing';
  }
  return 'pending'; // cancelled / stale / unknown: no signal
}

const GH_PR_ACTIONS = new Set([
  'opened', 'reopened', 'edited', 'synchronize', 'closed', 'ready_for_review', 'converted_to_draft', 'review_requested', 'review_request_removed',
]);

export function parseGithubEvent(event: string, payload: unknown): ParsedEvent {
  if (event === 'ping') return { kind: 'ping' };
  const p = obj(payload, 'payload');
  switch (event) {
    case 'pull_request': {
      const action = str(p.action, 'action');
      if (!GH_PR_ACTIONS.has(action)) return { kind: 'ignored', reason: `pull_request action "${action}" is not handled` };
      const pr = obj(p.pull_request, 'pull_request');
      const repoObj = obj(p.repository, 'repository');
      const head = obj(pr.head, 'pull_request.head');
      const reviewers = arr(pr.requested_reviewers).length + arr(pr.requested_teams).length;
      const state: ArtifactState = pr.merged === true ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft === true ? 'draft' : 'open';
      const candidate: ArtifactCandidate = {
        kind: 'pull_request',
        provider: 'github',
        externalId: `#${num(pr.number, 'pull_request.number')}`,
        title: str(pr.title, 'pull_request.title'),
        url: optStr(pr.html_url),
        state,
        headSha: optStr(head.sha),
        headBranch: optStr(head.ref),
        texts: [str(pr.title, 'title'), optStr(pr.body) ?? ''],
        branchTexts: [optStr(head.ref) ?? ''],
        hasConflicts: pr.mergeable_state === 'dirty' || pr.mergeable === false ? true : pr.mergeable === true ? false : undefined,
        ci: action === 'synchronize' ? 'pending' : undefined,
      };
      if (action === 'review_requested') candidate.review = 'requested';
      else if (action === 'review_request_removed' && reviewers === 0) {
        candidate.review = 'none';
        candidate.reviewOnlyFrom = ['requested'];
      } else if (action === 'opened' && reviewers > 0) {
        candidate.review = 'requested';
        candidate.reviewOnlyFrom = ['none'];
      }
      withLogins(
        candidate,
        action === 'review_requested' ? fieldsOf([p.requested_reviewer], 'login') : fieldsOf(pr.requested_reviewers, 'login'),
        field(p.sender, 'login'),
      );
      return { kind: 'pr', repo: githubRepo(repoObj), candidate, meta: githubMeta(pr) };
    }
    case 'issues': {
      const action = str(p.action, 'action');
      if (!GH_ISSUE_ACTIONS.has(action)) return { kind: 'ignored', reason: `issues action "${action}" is not handled` };
      const issue = obj(p.issue, 'issue');
      if (issue.pull_request) return { kind: 'ignored', reason: 'a pull request is not an issue' };
      const number = num(issue.number, 'issue.number');
      const closed = issue.state === 'closed';
      const reason = optStr(issue.state_reason);
      return {
        kind: 'issue',
        repo: githubRepo(obj(p.repository, 'repository')),
        issue: {
          provider: 'github',
          externalId: `#${number}`,
          number,
          title: str(issue.title, 'issue.title'),
          body: optStr(issue.body),
          url: optStr(issue.html_url),
          state: closed ? 'closed' : 'open',
          ...(closed ? { stateReason: reason === 'not_planned' ? ('not_planned' as const) : ('completed' as const) } : {}),
          ...githubMeta(issue),
          author: issue.user && typeof issue.user === 'object' ? optStr((issue.user as Obj).login) : undefined,
        },
      };
    }
    case 'check_suite':
    case 'check_run': {
      const run = obj(p[event], event);
      const prs = arr(run.pull_requests)
        .map((x) => (typeof x === 'object' && x ? (x as Obj).number : undefined))
        .filter((n): n is number => typeof n === 'number')
        .map((n) => `#${n}`);
      return {
        kind: 'ci',
        repo: githubRepo(obj(p.repository, 'repository')),
        patch: { sha: str(run.head_sha, `${event}.head_sha`), prExternalIds: prs, ci: githubCi(run.status, run.conclusion) },
      };
    }
    case 'status': {
      const state = str(p.state, 'state');
      const ci: CiState = state === 'success' ? 'passing' : state === 'failure' || state === 'error' ? 'failing' : 'pending';
      return { kind: 'ci', repo: githubRepo(obj(p.repository, 'repository')), patch: { sha: str(p.sha, 'sha'), ci } };
    }
    default:
      return { kind: 'ignored', reason: `event "${event}" is not handled` };
  }
}

const GH_ISSUE_ACTIONS = new Set(['opened', 'reopened', 'closed', 'edited', 'labeled', 'unlabeled', 'milestoned', 'demilestoned']);

/** Label names and milestone title of an issue or pull request object. */
function githubMeta(o: Obj): ItemMeta {
  const labels = arr(o.labels).flatMap((l) => (l && typeof l === 'object' && optStr((l as Obj).name) ? [optStr((l as Obj).name)!] : []));
  const milestone = o.milestone && typeof o.milestone === 'object' ? optStr((o.milestone as Obj).title) : undefined;
  return { labels, ...(milestone ? { milestone } : {}) };
}

function githubRepo(r: Obj): RepoMeta {
  return { fullName: str(r.full_name, 'repository.full_name'), url: optStr(r.html_url), defaultBranch: optStr(r.default_branch) };
}

// ───────────────────────────── GitLab ─────────────────────────────

export function gitlabCi(status: unknown): CiState {
  if (status === 'success' || status === 'skipped') return 'passing';
  if (status === 'failed') return 'failing';
  return 'pending'; // created, pending, running, canceled, manual, ...
}

const GL_ISSUE_ACTIONS = new Set(['open', 'close', 'reopen', 'update']);

/** GitLab lists labels as `[{ title }]` at the top of the payload. */
function gitlabLabels(raw: unknown): string[] {
  return arr(raw).flatMap((l) => (l && typeof l === 'object' && optStr((l as Obj).title) ? [optStr((l as Obj).title)!] : []));
}

export function parseGitlabEvent(payload: unknown): ParsedEvent {
  const p = obj(payload, 'payload');
  const kind = str(p.object_kind ?? p.event_type, 'object_kind');
  const project = () => {
    const pr = obj(p.project, 'project');
    return { fullName: str(pr.path_with_namespace, 'project.path_with_namespace'), url: optStr(pr.web_url), defaultBranch: optStr(pr.default_branch) } satisfies RepoMeta;
  };
  switch (kind) {
    case 'merge_request': {
      const a = obj(p.object_attributes, 'object_attributes');
      const iid = a.iid;
      if (typeof iid !== 'number') throw new PayloadError('"object_attributes.iid" must be a number');
      const action = optStr(a.action);
      const reviewers = arr(p.reviewers).length;
      const state: ArtifactState =
        a.state === 'merged' ? 'merged' : a.state === 'closed' ? 'closed' : a.draft === true || a.work_in_progress === true ? 'draft' : 'open';
      const lastCommit = a.last_commit && typeof a.last_commit === 'object' ? optStr((a.last_commit as Obj).id) : undefined;
      const candidate: ArtifactCandidate = {
        kind: 'merge_request',
        provider: 'gitlab',
        externalId: `!${iid}`,
        title: str(a.title, 'object_attributes.title'),
        url: optStr(a.url),
        state,
        headSha: lastCommit,
        headBranch: optStr(a.source_branch),
        texts: [str(a.title, 'title'), optStr(a.description) ?? ''],
        branchTexts: [optStr(a.source_branch) ?? ''],
        hasConflicts:
          a.detailed_merge_status === 'conflict' || a.merge_status === 'cannot_be_merged' ? true : a.merge_status === 'can_be_merged' ? false : undefined,
        ci: action === 'update' && a.oldrev ? 'pending' : undefined,
      };
      if (action === 'approved' || action === 'approval') candidate.review = 'approved';
      else if (action === 'unapproved' || action === 'unapproval') {
        candidate.review = reviewers > 0 ? 'requested' : 'none';
        candidate.reviewOnlyFrom = ['approved'];
      } else if (action === 'open' && reviewers > 0) {
        candidate.review = 'requested';
        candidate.reviewOnlyFrom = ['none'];
      }
      withLogins(candidate, fieldsOf(p.reviewers, 'username'), field(p.user, 'username'));
      return { kind: 'pr', repo: project(), candidate, meta: { labels: gitlabLabels(p.labels) } };
    }
    case 'issue': {
      const a = obj(p.object_attributes, 'object_attributes');
      const iid = a.iid;
      if (typeof iid !== 'number') throw new PayloadError('"object_attributes.iid" must be a number');
      const action = optStr(a.action);
      if (action && !GL_ISSUE_ACTIONS.has(action)) return { kind: 'ignored', reason: `issue action "${action}" is not handled` };
      const user = p.user && typeof p.user === 'object' ? (p.user as Obj) : undefined;
      return {
        kind: 'issue',
        repo: project(),
        issue: {
          provider: 'gitlab',
          externalId: `#${iid}`,
          number: iid,
          title: str(a.title, 'object_attributes.title'),
          body: optStr(a.description),
          url: optStr(a.url),
          state: a.state === 'closed' ? 'closed' : 'open',
          ...(a.state === 'closed' ? { stateReason: 'completed' as const } : {}),
          labels: gitlabLabels(p.labels),
          author: optStr(user?.username),
        },
      };
    }
    case 'pipeline': {
      const a = obj(p.object_attributes, 'object_attributes');
      const mr = p.merge_request && typeof p.merge_request === 'object' ? (p.merge_request as Obj) : undefined;
      return {
        kind: 'ci',
        repo: project(),
        patch: {
          sha: str(a.sha, 'object_attributes.sha'),
          prExternalIds: typeof mr?.iid === 'number' ? [`!${mr.iid}`] : [],
          ci: gitlabCi(a.status),
        },
      };
    }
    default:
      return { kind: 'ignored', reason: `event "${kind}" is not handled` };
  }
}

// ───────────────────────────── Bitbucket Cloud ─────────────────────────────

export function bitbucketCi(state: unknown): CiState {
  if (state === 'SUCCESSFUL') return 'passing';
  if (state === 'FAILED') return 'failing';
  return 'pending'; // INPROGRESS, STOPPED
}

const BB_PR_EVENTS = new Set([
  'created', 'updated', 'approved', 'unapproved', 'fulfilled', 'rejected', 'changes_request_created', 'changes_request_removed',
]);

function bitbucketRepo(r: Obj): RepoMeta {
  const links = r.links && typeof r.links === 'object' ? ((r.links as Obj).html as Obj | undefined) : undefined;
  const main = r.mainbranch && typeof r.mainbranch === 'object' ? (r.mainbranch as Obj) : undefined;
  return { fullName: str(r.full_name, 'repository.full_name'), url: optStr(links?.href), defaultBranch: optStr(main?.name) };
}

/** `eventKey` is the `X-Event-Key` header (`pullrequest:created`, `repo:commit_status_updated`, …). */
export function parseBitbucketEvent(eventKey: string, payload: unknown): ParsedEvent {
  if (eventKey === 'diagnostics:ping') return { kind: 'ping' };
  const p = obj(payload, 'payload');
  if (eventKey.startsWith('pullrequest:')) {
    const action = eventKey.slice('pullrequest:'.length);
    if (!BB_PR_EVENTS.has(action)) return { kind: 'ignored', reason: `event "${eventKey}" is not handled` };
    const pr = obj(p.pullrequest, 'pullrequest');
    const source = obj(pr.source, 'pullrequest.source');
    const branch = source.branch && typeof source.branch === 'object' ? optStr((source.branch as Obj).name) : undefined;
    const commit = source.commit && typeof source.commit === 'object' ? optStr((source.commit as Obj).hash) : undefined;
    const html = pr.links && typeof pr.links === 'object' ? ((pr.links as Obj).html as Obj | undefined) : undefined;
    const reviewers = arr(pr.reviewers).length;
    const state: ArtifactState =
      pr.state === 'MERGED' ? 'merged' : pr.state === 'DECLINED' || pr.state === 'SUPERSEDED' ? 'closed' : pr.draft === true ? 'draft' : 'open';
    const title = str(pr.title, 'pullrequest.title');
    const candidate: ArtifactCandidate = {
      kind: 'pull_request',
      provider: 'bitbucket',
      externalId: `#${num(pr.id, 'pullrequest.id')}`,
      title,
      url: optStr(html?.href),
      state,
      headSha: commit,
      headBranch: branch,
      texts: [title, optStr(pr.description) ?? ''],
      branchTexts: [branch ?? ''],
    };
    if (action === 'approved') candidate.review = 'approved';
    else if (action === 'unapproved') {
      candidate.review = reviewers > 0 ? 'requested' : 'none';
      candidate.reviewOnlyFrom = ['approved'];
    } else if (action === 'changes_request_created') candidate.review = 'changes_requested';
    else if (action === 'changes_request_removed') {
      candidate.review = reviewers > 0 ? 'requested' : 'none';
      candidate.reviewOnlyFrom = ['changes_requested'];
    } else if (action === 'created' && reviewers > 0) {
      candidate.review = 'requested';
      candidate.reviewOnlyFrom = ['none'];
    }
    withLogins(candidate, fieldsOf(pr.reviewers, 'nickname', 'username'), field(p.actor, 'nickname') ?? field(p.actor, 'username'));
    return { kind: 'pr', repo: bitbucketRepo(obj(p.repository, 'repository')), candidate };
  }
  if (eventKey === 'repo:commit_status_created' || eventKey === 'repo:commit_status_updated') {
    const status = obj(p.commit_status, 'commit_status');
    const commit = obj(status.commit, 'commit_status.commit');
    return {
      kind: 'ci',
      repo: bitbucketRepo(obj(p.repository, 'repository')),
      patch: { sha: str(commit.hash, 'commit_status.commit.hash'), ci: bitbucketCi(status.state) },
    };
  }
  return { kind: 'ignored', reason: `event "${eventKey}" is not handled` };
}
