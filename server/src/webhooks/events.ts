import type { ArtifactState, CiState } from '../contracts/domain.js';
import type { ArtifactCandidate, CiPatch, RepoMeta } from '../integrations/candidates.js';

/** The payload is not the shape the provider documents (→ HTTP 400). */
export class PayloadError extends Error {}

export type ParsedEvent =
  | { kind: 'ignored'; reason: string }
  | { kind: 'ping' }
  | { kind: 'pr'; repo: RepoMeta; candidate: ArtifactCandidate }
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
      return { kind: 'pr', repo: githubRepo(repoObj), candidate };
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

function githubRepo(r: Obj): RepoMeta {
  return { fullName: str(r.full_name, 'repository.full_name'), url: optStr(r.html_url), defaultBranch: optStr(r.default_branch) };
}

// ───────────────────────────── GitLab ─────────────────────────────

export function gitlabCi(status: unknown): CiState {
  if (status === 'success' || status === 'skipped') return 'passing';
  if (status === 'failed') return 'failing';
  return 'pending'; // created, pending, running, canceled, manual, ...
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
      return { kind: 'pr', repo: project(), candidate };
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
