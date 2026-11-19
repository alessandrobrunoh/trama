// The status wizard's rules, as a pure function. It reads the evidence the app already has about a task
// (subtasks, linked PRs and CI, the timer, the last activity, recent comments, the tracker the task is linked
// to) and proposes which status the work is really in, with one to three plain reasons and a confidence.
// No AI and no I/O: the same evidence always gives the same answer, so it is easy to test and to explain.
import type { ArtifactKind, ArtifactState, CiState, ExternalStateType, ReviewState } from '../../core';
import { formatSpan } from '../../core/format';

/** The semantic status types. A workspace maps its own statuses onto these. */
export type StatusType = 'draft' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';

export const DAY_MS = 86_400_000;

export interface ArtifactEvidence {
  kind: ArtifactKind;
  state: ArtifactState;
  ci?: CiState;
  review?: ReviewState;
  hasConflicts?: boolean;
  /** Short name: `#182`, a build number. */
  ref?: string;
}

export interface StatusEvidence {
  now: number;
  /** Semantic type of the task's current status. */
  current: StatusType;
  /** Key of the task this one duplicates, when marked. */
  duplicateOf?: string;
  /** Direct subtasks, counted by the type of their status. */
  subtasks: { total: number; done: number; canceled: number; inProgress: number; inReview: number };
  artifacts: readonly ArtifactEvidence[];
  /** The tracker the task is linked to (GitHub, Linear). */
  external?: { stateType: ExternalStateType; label: string };
  timer: {
    runningHere: boolean;
    /** Finished tracked time on this task in the last 3 days. */
    recentMs: number;
  };
  /** Last change, comment or event on the task (ISO). */
  lastActivityAt?: string;
  /** The newest comments, newest first. */
  comments: readonly { body: string; at: string }[];
}

export type Confidence = 'high' | 'medium' | 'low';

export interface StatusProposal {
  /** The type the evidence points to. Equal to the current one when the status looks right. */
  status: StatusType;
  /** The proposal differs from the current status. */
  changes: boolean;
  confidence: Confidence;
  /** One to three plain sentences, the strongest first. */
  reasons: string[];
  /** Things worth knowing that do not change the proposal (failing CI, a blocker mentioned). */
  warnings: string[];
}

interface Vote {
  weight: number;
  reason: string;
}

const INERTIA = 1.5;
const RECENT_COMMENT_MS = 14 * DAY_MS;
const DONE_WORDS = /\b(done|fixed|shipped|merged|deployed|released|resolved|completed|finished)\b/i;
const NEGATION = /\b(not|isn'?t|aren'?t|wasn'?t|never|nothing|nobody|almost|nearly|until|once|when|if|to be)\b[^.!?\n]{0,24}$/i;
const BLOCKED_WORDS = /\b(blocked|blocker|blocking|waiting (on|for)|stuck|on hold|can'?t (proceed|continue|move))\b/i;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** True when `pattern` matches in `text` and is not negated just before ("not done", "once it is merged"). */
function says(text: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!NEGATION.test(text.slice(Math.max(0, m.index - 28), m.index))) return true;
  }
  return false;
}

function label(a: ArtifactEvidence): string {
  const base = a.kind === 'pull_request' ? 'PR' : a.kind === 'merge_request' ? 'MR' : a.kind === 'build' ? 'Build' : 'Release';
  return a.ref ? `${base} ${a.ref}` : base;
}

const isChange = (a: ArtifactEvidence): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';

/** Days since an ISO instant (whole days, never negative). */
export function daysSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : undefined;
}

export function proposeStatus(e: StatusEvidence): StatusProposal {
  const votes = new Map<StatusType, Vote[]>();
  const warnings: string[] = [];
  const vote = (status: StatusType, weight: number, reason: string): void => {
    const list = votes.get(status) ?? [];
    list.push({ weight, reason });
    votes.set(status, list);
  };

  const closedNow = e.current === 'done' || e.current === 'canceled';

  // A duplicate is closed, whatever else is going on.
  if (e.duplicateOf) vote('canceled', 100, `Marked as a duplicate of ${e.duplicateOf}`);

  // Subtasks.
  const s = e.subtasks;
  if (s.total > 0) {
    const open = s.total - s.done - s.canceled;
    if (open === 0 && s.done > 0) {
      vote('done', 7, s.total === 1 ? 'Its only subtask is done' : `All ${s.total} subtasks are done`);
    } else if (open === 0) {
      warnings.push(`All ${s.total} subtasks were canceled`);
    } else if (closedNow) {
      warnings.push(`${plural(open, 'subtask')} still open`);
    } else if (s.done > 0 || s.inProgress > 0 || s.inReview > 0) {
      const text =
        s.done > 0
          ? `${s.done} of ${s.total} subtasks are done`
          : s.inProgress > 0
            ? `${plural(s.inProgress, 'subtask')} in progress`
            : `${plural(s.inReview, 'subtask')} in review`;
      vote('in_progress', 3.5, text.charAt(0).toUpperCase() + text.slice(1));
    }
  }

  // Linked pull requests, builds and releases.
  const changes = e.artifacts.filter(isChange);
  const merged = changes.find((a) => a.state === 'merged');
  const open = changes.filter((a) => a.state === 'open');
  const drafts = changes.filter((a) => a.state === 'draft');
  if (merged && open.length === 0 && drafts.length === 0) {
    vote('done', 8, `${label(merged)} is merged`);
  }
  for (const a of open) {
    if (a.ci === 'failing' || a.hasConflicts) {
      vote('in_progress', 4, a.ci === 'failing' ? `CI is failing on ${label(a)}` : `${label(a)} has merge conflicts`);
    } else if (a.review === 'approved') {
      vote('in_review', 7, `${label(a)} is approved${a.ci === 'passing' ? ' and CI is passing' : ''}`);
    } else if (a.review === 'changes_requested') {
      vote('in_progress', 5, `Changes were requested on ${label(a)}`);
    } else {
      vote('in_review', 5, `${label(a)} is open and waiting for review`);
    }
    if (a.ci === 'failing') warnings.push(`CI is failing on ${label(a)}`);
    if (a.hasConflicts) warnings.push(`${label(a)} has merge conflicts`);
  }
  for (const a of drafts) vote('in_progress', 5, `${label(a)} is still a draft`);
  for (const a of changes) {
    if (a.state === 'closed') warnings.push(`${label(a)} was closed without merging`);
  }
  const shipped = e.artifacts.find(
    (a) => (a.kind === 'deployment' || a.kind === 'release') && (a.state === 'published' || a.state === 'healthy'),
  );
  if (shipped) vote('done', 4, `${label(shipped)} is live`);
  const failedBuild = e.artifacts.find((a) => a.kind === 'build' && (a.state === 'failed' || a.ci === 'failing'));
  if (failedBuild) warnings.push(`${label(failedBuild)} failed`);

  // The tracker this task is linked to.
  if (e.external) {
    const t = e.external.stateType;
    if (t === 'done') vote('done', 5, `${e.external.label} is closed`);
    else if (t === 'canceled') vote('canceled', 4, `${e.external.label} was canceled`);
    else if (t === 'in_progress') vote('in_progress', 3, `${e.external.label} is in progress`);
    else if (e.current === 'done') warnings.push(`${e.external.label} is still open`);
  }

  // The timer.
  if (e.timer.runningHere) vote('in_progress', 6, 'The timer is running on this task');
  else if (e.timer.recentMs >= 60_000 && !closedNow) vote('in_progress', 4, `${formatSpan(e.timer.recentMs)} tracked in the last 3 days`);

  // Last activity.
  const idle = daysSince(e.lastActivityAt, e.now);
  const working = e.timer.runningHere || e.timer.recentMs > 0 || open.length > 0 || drafts.length > 0;
  if (idle !== undefined && !working) {
    if (e.current === 'in_progress' && idle >= 7) {
      vote('todo', idle >= 14 ? 4 : 3, `No activity for ${idle} days`);
    } else if (e.current === 'in_review' && idle >= 7) {
      warnings.push(`No activity for ${idle} days`);
    } else if ((e.current === 'todo' || e.current === 'backlog') && idle >= 30) {
      warnings.push(`Untouched for ${idle} days`);
    }
  }

  // The newest comment that says something decisive.
  for (const c of e.comments.slice(0, 3)) {
    if (e.now - Date.parse(c.at) > RECENT_COMMENT_MS) break;
    const blocked = says(c.body, BLOCKED_WORDS);
    const done = !blocked && says(c.body, DONE_WORDS);
    if (blocked) {
      warnings.push('A recent comment mentions it is blocked');
      break;
    }
    if (done) {
      vote('done', 3, 'A recent comment says it is done');
      break;
    }
  }

  // Keep what is there unless something outweighs it.
  vote(e.current, INERTIA, '');

  const ranked = [...votes.entries()]
    .map(([status, list]) => ({ status, total: list.reduce((n, v) => n + v.weight, 0), list }))
    .sort((a, b) => b.total - a.total || (a.status === e.current ? -1 : b.status === e.current ? 1 : 0));
  const winner = ranked[0];
  const second = ranked[1]?.total ?? 0;
  const evidence = winner.list.filter((v) => v.reason);

  let reasons = evidence
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((v) => v.reason);
  if (reasons.length === 0) reasons = ['Nothing in the evidence points to a different status'];

  const margin = winner.total - second;
  const strength = evidence.reduce((n, v) => Math.max(n, v.weight), 0);
  let confidence: Confidence = 'low';
  if (strength >= 7 && margin >= 3.5) confidence = 'high';
  else if (strength >= 3.5 && margin >= 1.5) confidence = 'medium';

  return {
    status: winner.status,
    changes: winner.status !== e.current,
    confidence,
    reasons,
    warnings: [...new Set(warnings)].slice(0, 3),
  };
}
