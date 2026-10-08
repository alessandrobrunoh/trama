// Turns store records into the bounded, plain-data inputs the prompt builders accept.
// Read-only: nothing here writes to the store or talks to the server. Names appear (people use
// them in comments), emails never do (`clip` scrubs them), and every list is capped.
import {
  ISSUE_KINDS,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  NablaStore,
  PRIORITIES,
  PRIORITY_META,
  WORKSTREAM_STATUS_META,
  estimateOptions,
  type DomainEvent,
  type Issue,
  type Workstream,
} from '../../core';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { dayOf, todayDay } from '../milestones/milestone-model';
import { describeEvent } from '../workstreams/activity-format';
import { explainStatus, issueCounts } from '../workstreams/ws-model';
import {
  boundedLines,
  clip,
  oneLine,
  type EstimateChoice,
  type PromptCandidate,
  type PromptDigest,
  type PromptIssue,
  type PromptSimilar,
  type PromptWorkstream,
} from './prompts';
import { rankByOverlap } from './similar';

const DAY = 86_400_000;
const dayStr = (iso: string): string => iso.slice(0, 10);
const daysBetween = (a: string, b: string | number): number => Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY);

/** Workspace estimate scale as prompt choices, or `null` when estimates are off. */
export function estimateChoices(store: NablaStore): EstimateChoice[] | null {
  const scale = store.estimateScale();
  if (scale === 'none') return null;
  const list = estimateOptions(scale).map((o) => ({ value: o.value, label: o.label }));
  return list.length ? list : null;
}

export const KIND_LIST: readonly string[] = ISSUE_KINDS;
export const PRIORITY_LIST: readonly string[] = PRIORITIES;

// ───────────────────────────── issues ─────────────────────────────

/** Recent comments and status changes of one issue, oldest first, at most ~3500 characters. */
export function issueDigest(store: NablaStore, issue: Issue): string {
  const rows: { at: string; line: string }[] = [];
  for (const c of store.commentsFor({ type: 'issue', id: issue.id })) {
    rows.push({ at: c.createdAt, line: `${dayStr(c.createdAt)} ${store.actorName(c.author)} commented: ${oneLine(c.body, 380)}` });
  }
  const events = store.eventsBySubject().get(`issue:${issue.id}`) ?? [];
  for (const e of events) {
    if (e.type !== 'issue.status_changed') continue;
    const to = String(e.data['to'] ?? '');
    const from = String(e.data['from'] ?? '');
    const label = (s: string) => ISSUE_STATUS_META[s as Issue['status']]?.label ?? s;
    rows.push({ at: e.at, line: `${dayStr(e.at)} ${store.actorName(e.actor)} moved status ${from ? `${label(from)} → ` : 'to '}${label(to)}` });
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : 1));
  return boundedLines(rows.map((r) => r.line));
}

export function issuePromptData(store: NablaStore, issue: Issue): PromptIssue {
  return {
    key: issue.key,
    title: issue.title,
    body: issue.body,
    kind: ISSUE_KIND_META[issue.kind]?.label ?? issue.kind,
    status: ISSUE_STATUS_META[issue.status]?.label ?? issue.status,
    priority: PRIORITY_META[issue.priority]?.label ?? issue.priority,
    estimate: issue.estimate ?? null,
    assignee: issue.assigneeId ? store.getUser(issue.assigneeId)?.name : undefined,
    workstreams: issue.workstreamIds.flatMap((id) => {
      const w = store.workstreamById().get(id);
      return w ? [`${w.key} ${w.title}`] : [];
    }),
    createdAt: dayStr(issue.createdAt),
    digest: issueDigest(store, issue),
  };
}

export interface TriageInputs {
  estimates: EstimateChoice[] | null;
  candidates: PromptCandidate[];
  similar: PromptSimilar[];
}

/** ≤8 active workstreams and ≤4 finished issues ranked by word overlap with `issue`. */
export function triageInputs(store: NablaStore, issue: Issue): TriageInputs {
  const query = `${issue.title}\n${issue.body ?? ''}`;

  const linked = new Set(issue.workstreamIds);
  const active = store.workstreams().filter((w) => !linked.has(w.id) && w.status !== 'shipped' && w.status !== 'canceled');
  const candidates = rankByOverlap(query, active, (w) => `${w.title} ${w.title} ${w.objective} ${w.description ?? ''}`, 8, 0.05).map(
    ({ item: w }): PromptCandidate => ({ key: w.key, title: oneLine(w.title, 120), status: WORKSTREAM_STATUS_META[w.status]?.label ?? w.status }),
  );

  const finished = store
    .issues()
    .filter((i) => i.id !== issue.id && i.status === 'done' && !i.duplicateOfId)
    .sort((a, b) => ((a.completedAt ?? '') < (b.completedAt ?? '') ? 1 : -1));
  const similar = rankByOverlap(query, finished, (i) => `${i.title} ${i.title} ${i.body ?? ''}`, 4).map(
    ({ item: i }): PromptSimilar => ({
      key: i.key,
      title: oneLine(i.title, 120),
      kind: ISSUE_KIND_META[i.kind]?.label ?? i.kind,
      priority: PRIORITY_META[i.priority]?.label ?? i.priority,
      estimate: i.estimate ?? null,
      cycleDays: i.startedAt && i.completedAt ? Math.max(0, Math.round((daysBetween(i.startedAt, i.completedAt) + Number.EPSILON) * 10) / 10) : null,
    }),
  );
  return { estimates: estimateChoices(store), candidates, similar };
}

// ───────────────────────────── workstreams ─────────────────────────────

const keyTitle = (i: Pick<Issue, 'key' | 'title'>): string => `${i.key} ${i.title}`;

export function workstreamPromptData(store: NablaStore, info: MilestoneInfo, ws: Workstream): PromptWorkstream {
  const today = new Date().toISOString();
  const issues = (store.issuesByWorkstream().get(ws.id) ?? []).filter((i) => i.status !== 'canceled');
  const counts = issueCounts(issues);
  const open = (s: Issue['status']) => issues.filter((i) => i.status === s);
  const inProgress = [...open('in_progress'), ...open('in_review')];
  const todo = [...open('todo'), ...open('backlog')];
  const recentDone = open('done').sort((a, b) => ((a.completedAt ?? '') < (b.completedAt ?? '') ? 1 : -1));

  const criteria = ws.acceptanceCriteria;
  const milestones = (store.milestonesByWorkstream().get(ws.id) ?? []).map((m) => ({
    name: m.name,
    targetDate: m.targetDate ? dayStr(m.targetDate) : undefined,
    percent: info.stats().get(m.id)?.percent ?? 0,
    state: info.states().get(m.id) ?? 'idle',
  }));
  const questions = (store.inputRequestsByWorkstream().get(ws.id) ?? []).filter((r) => r.state === 'open');

  const signals = workstreamSignals(store, ws, issues, milestones, questions.length);
  const events: DomainEvent[] = (store.eventsByWorkstream().get(ws.id) ?? []).slice(0, 10).reverse();
  const recent = events.map((e) => {
    const line = describeEvent(store, e);
    return `${dayStr(e.at)} ${store.actorName(e.actor)} ${line.verb}${line.detail ? `: ${line.detail}` : ''}`;
  });

  return {
    key: ws.key,
    title: ws.title,
    status: WORKSTREAM_STATUS_META[ws.status]?.label ?? ws.status,
    statusNote: ws.statusOverride ? 'status set manually' : undefined,
    priority: PRIORITY_META[ws.priority]?.label ?? ws.priority,
    objective: ws.objective,
    description: ws.description,
    targetDate: ws.targetDate ? dayStr(ws.targetDate) : undefined,
    accountable: ws.accountableUserId ? store.getUser(ws.accountableUserId)?.name : undefined,
    criteria: {
      met: criteria.filter((c) => c.state === 'met').length,
      total: criteria.length,
      open: criteria.filter((c) => c.state !== 'met').map((c) => c.text),
    },
    issues: {
      done: counts.issuesDone,
      inProgress: counts.issuesActive,
      todo: counts.issuesTotal - counts.issuesDone - counts.issuesActive,
      total: counts.issuesTotal,
      doneList: recentDone.map(keyTitle),
      inProgressList: inProgress.map(keyTitle),
      todoList: todo.map(keyTitle),
    },
    milestones,
    openQuestions: questions.map((q) => `${q.question} (open ${Math.max(0, daysBetween(q.createdAt, Date.now()))}d)`),
    signals,
    recent,
    today: dayStr(today),
  };
}

/** Plain-language risk signals: blocked, overdue, failing CI, stale work, old questions. */
function workstreamSignals(
  store: NablaStore,
  ws: Workstream,
  issues: readonly Issue[],
  milestones: readonly { name: string; state: string; percent: number }[],
  openQuestions: number,
): string[] {
  const out: string[] = [];
  const finished = ws.status === 'shipped' || ws.status === 'canceled';
  if (!finished) {
    if (ws.status === 'blocked' || ws.status === 'needs_input') out.push(...explainStatus(store, ws).reasons.slice(0, 3));
    if (ws.targetDate) {
      const left = dayOf(ws.targetDate) - todayDay();
      if (left < 0) out.push(`Target date passed ${-left} day(s) ago`);
      else if (left <= 14) out.push(`Target date in ${left} day(s)`);
    }
    for (const m of milestones) if (m.state === 'overdue') out.push(`Milestone "${m.name}" is overdue (${m.percent}% done)`);
    const stale = issues.filter((i) => (i.status === 'in_progress' || i.status === 'in_review') && daysBetween(i.updatedAt, Date.now()) >= 10);
    if (stale.length) out.push(`${stale.length} issue(s) in progress without an update for 10+ days: ${stale.slice(0, 3).map((i) => i.key).join(', ')}`);
  }
  for (const a of store.artifactsByWorkstream().get(ws.id) ?? []) {
    if (a.kind !== 'pull_request' && a.kind !== 'merge_request') continue;
    if (a.state !== 'open' && a.state !== 'draft') continue;
    const label = a.externalId ? `${a.externalId} ` : '';
    if (a.ci === 'failing') out.push(`${label}${oneLine(a.title, 80)}: CI failing`);
    else if (a.hasConflicts) out.push(`${label}${oneLine(a.title, 80)}: merge conflicts`);
    else if (a.review === 'changes_requested') out.push(`${label}${oneLine(a.title, 80)}: changes requested`);
  }
  if (openQuestions) out.push(`${openQuestions} open question(s) waiting for an answer`);
  return out;
}

export function breakdownInputs(store: NablaStore, ws: Workstream) {
  return {
    ws: { key: ws.key, title: ws.title, objective: ws.objective, description: ws.description, context: ws.context },
    existingTitles: (store.issuesByWorkstream().get(ws.id) ?? []).map((i) => i.title),
    estimates: estimateChoices(store),
    kinds: KIND_LIST,
    priorities: PRIORITY_LIST,
  };
}

// ───────────────────────────── standup digest ─────────────────────────────

/** Workspace-wide facts for the standup digest: windows 24h / 7d, at-risk, overdue, waiting longest. */
export function digestData(store: NablaStore, info: MilestoneInfo): PromptDigest {
  const now = Date.now();
  const ageDays = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
  const within = (iso: string | undefined, days: number) => !!iso && now - new Date(iso).getTime() <= days * DAY;
  const issues = store.issues().filter((i) => !i.duplicateOfId);
  const wsLabel = (w: Workstream) => `${w.key} ${oneLine(w.title, 80)}`;

  const last24h: string[] = [];
  const last7d: string[] = [];
  const push = (iso: string, line: string) => (within(iso, 1) ? last24h : last7d).push(line);
  for (const i of issues) {
    if (within(i.completedAt, 7) && i.status === 'done') push(i.completedAt!, `Done: ${i.key} ${oneLine(i.title, 90)}`);
    if (within(i.createdAt, 7)) push(i.createdAt, `New: ${i.key} ${oneLine(i.title, 90)}`);
  }
  for (const e of store.events()) {
    if (e.type !== 'workstream.status_changed' || !within(e.at, 7)) continue;
    const ws = store.workstreamById().get(e.subject.id);
    if (ws) push(e.at, `${wsLabel(ws)} moved to ${WORKSTREAM_STATUS_META[String(e.data['to']) as Workstream['status']]?.label ?? String(e.data['to'])}`);
  }

  const today = todayDay();
  const atRisk: { rank: number; line: string }[] = [];
  for (const w of store.workstreams()) {
    if (w.status === 'shipped' || w.status === 'canceled' || w.status === 'draft') continue;
    const c = issueCounts(store.issuesByWorkstream().get(w.id) ?? []);
    const bits: string[] = [];
    let rank = 9;
    if (w.status === 'blocked') (bits.push('blocked'), (rank = 0));
    else if (w.status === 'needs_input') (bits.push('waiting for input'), (rank = 2));
    if (w.targetDate) {
      const left = dayOf(w.targetDate) - today;
      if (left < 0) (bits.push(`target passed ${-left}d ago`), (rank = Math.min(rank, 1)));
      else if (left <= 7 && c.issuesDone < c.issuesTotal) (bits.push(`target in ${left}d with ${c.issuesTotal - c.issuesDone} issue(s) left`), (rank = Math.min(rank, 3)));
    }
    if (bits.length) atRisk.push({ rank, line: `${wsLabel(w)}: ${bits.join('; ')} (${c.issuesDone}/${c.issuesTotal} issues done)` });
  }
  atRisk.sort((a, b) => a.rank - b.rank);

  const overdue: string[] = [];
  for (const m of store.milestones()) {
    if (info.states().get(m.id) !== 'overdue') continue;
    const p = store.getProject(m.projectId);
    if (!p || p.status === 'completed' || p.status === 'canceled') continue;
    overdue.push(`${oneLine(p.name, 40)} › ${oneLine(m.name, 60)}: ${info.stats().get(m.id)?.percent ?? 0}% done, due ${m.targetDate ? dayStr(m.targetDate) : '?'}`);
  }

  const waiting = issues
    .filter((i) => i.status === 'todo' || i.status === 'in_progress' || i.status === 'in_review')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
    .slice(0, 5)
    .map((i) => `${i.key} ${oneLine(i.title, 80)}: ${ISSUE_STATUS_META[i.status].label.toLowerCase()}, untouched ${ageDays(i.updatedAt)}d`);
  for (const q of store.openInputRequests().slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).slice(0, 3)) {
    const w = store.workstreamById().get(q.workstreamId);
    waiting.push(`Question on ${w?.key ?? 'a workstream'}: "${oneLine(q.question, 100)}" open ${ageDays(q.createdAt)}d`);
  }

  const cap = (xs: string[], n: number) => xs.slice(0, n).map((x) => clip(x, 220));
  return {
    today: dayStr(new Date().toISOString()),
    window: { last24h: cap(last24h, 12), last7d: cap(last7d, 12) },
    atRisk: cap(atRisk.map((x) => x.line), 8),
    overdueMilestones: cap(overdue, 8),
    waitingLongest: cap(waiting, 8),
    counts: {
      issuesOpen: issues.filter((i) => i.status !== 'done' && i.status !== 'canceled').length,
      workstreamsActive: store.workstreams().filter((w) => w.status !== 'shipped' && w.status !== 'canceled' && w.status !== 'draft').length,
    },
  };
}
