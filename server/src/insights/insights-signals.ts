import {
  INSIGHT_SIGNALS,
  INSIGHT_SIGNAL_IDS,
  type ActorRef,
  type ArtifactKind,
  type ArtifactState,
  type CiState,
  type DecisionStatus,
  type DeliveryState,
  type InsightBottleneck,
  type InsightItem,
  type InsightSeverity,
  type InsightSignal,
  type InsightSignalId,
  type IssueStatus,
  type ReviewState,
  type WorkstreamStatus,
} from '../contracts/domain.js';
import { shippedProofGaps, unprovenCriteria, type ProofCriterion, type ProofGap } from '../status/completion-proof.js';
import { DAY, UNASSIGNED, actorOf, daysBetween, plural, round1, short, span, type NameIndex } from './insights-util.js';

// ───── input rows (narrow projections; the service fills them with SQL)

export interface IWorkstream {
  id: string;
  key: string;
  title: string;
  status: WorkstreamStatus;
  delivery: DeliveryState;
  ownerTeamId: string;
  accountableUserId: string | null;
  projectId: string | null;
  startDate: Date | null;
  targetDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  shippedAt: Date | null;
  acceptanceCriteria: { state: string }[];
}

/** A shipped workstream of any age, with what the proof check needs (not limited to the look-back window). */
export interface IShippedWorkstream {
  id: string;
  key: string;
  title: string;
  status: WorkstreamStatus;
  derivedStatus: WorkstreamStatus;
  statusOverride: WorkstreamStatus | null;
  legacyShipped: boolean;
  accountableUserId: string | null;
  shippedAt: Date | null;
  updatedAt: Date;
  acceptanceCriteria: (ProofCriterion & { state: string })[];
}

/** Facts that come from the event log, per workstream. */
export interface WorkstreamFacts {
  /** Last time it entered its current status (`workstream.status_changed`). */
  enteredStatusAt?: Date;
  /** First move out of Draft / Planned: when the work started. */
  startedAt?: Date;
  /** Last event by a person or an agent (system re-derivations do not count). */
  lastActivityAt?: Date;
}

export interface IIssue {
  id: string;
  key: string;
  title: string;
  kind: string;
  status: IssueStatus;
  assigneeId: string | null;
  teamId: string | null;
  projectId: string | null;
  workstreamIds: string[];
  milestoneIds: string[];
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface IInputRequest {
  id: string;
  workstreamId: string;
  question: string;
  requestedBy: ActorRef;
  assigneeUserId: string | null;
  createdAt: Date;
}

export interface IArtifact {
  id: string;
  workstreamId: string | null;
  kind: ArtifactKind;
  title: string;
  externalId: string | null;
  state: ArtifactState;
  ci: CiState | null;
  review: ReviewState | null;
  hasConflicts: boolean | null;
  authorRef: ActorRef | null;
  createdAt: Date;
  updatedAt: Date;
  /** When CI last turned failing (event log), when known. */
  ciFailedAt?: Date;
}

export interface IDecision {
  id: string;
  key: string;
  title: string;
  status: DecisionStatus;
  originWorkstreamId: string | null;
  relatedWorkstreamIds: string[];
  proposedBy: ActorRef;
  createdAt: Date;
}

export interface IDependency {
  fromId: string;
  toId: string;
}

export interface IMilestone {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
  targetDate: Date | null;
  openIssues: number;
  doneIssues: number;
}

/** First time an issue was linked to a workstream (`issue.linked` events). */
export interface IIssueLink {
  issueId: string;
  workstreamId: string;
  at: Date;
}

export interface ICustomerRequest {
  customerName: string;
  important: boolean;
  createdAt: Date;
  targetType: 'issue' | 'project';
  targetId: string;
  targetKey?: string;
  targetTitle: string;
}

export interface SignalData {
  now: Date;
  /** Start of the selected range (scope creep only counts links inside it). */
  rangeFrom: Date;
  staleDays: number;
  names: NameIndex;
  workstreams: IWorkstream[];
  /** Every shipped workstream in scope, whenever it shipped (for `shipped_without_proof`). */
  shippedHistory: IShippedWorkstream[];
  facts: ReadonlyMap<string, WorkstreamFacts>;
  issues: IIssue[];
  inputRequests: IInputRequest[];
  artifacts: IArtifact[];
  decisions: IDecision[];
  dependencies: IDependency[];
  milestones: IMilestone[];
  issueLinks: IIssueLink[];
  customerRequests: ICustomerRequest[];
}

export const REVIEW_STUCK_DAYS = 3;
export const SCOPE_CREEP_MIN_ADDED = 2;
export const STALE_STATUSES: readonly WorkstreamStatus[] = ['working', 'in_review', 'blocked', 'needs_input', 'ready_to_land'];
const CLOSED_WS: readonly WorkstreamStatus[] = ['shipped', 'canceled'];

const isOpenWs = (w: IWorkstream): boolean => !CLOSED_WS.includes(w.status);
const isPr = (a: IArtifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';

const PROOF_GAP_TEXT = (gap: ProofGap, unproven: number): string => {
  switch (gap) {
    case 'legacy':
      return 'historic, no acceptance criteria';
    case 'no_criteria':
      return 'no acceptance criteria';
    case 'unproven_criteria':
      return `${plural(unproven, 'met criterion', 'met criteria')} without evidence`;
    case 'pinned':
      return 'status pinned to Shipped, the facts say otherwise';
  }
};

type Found = { item: InsightItem; sortAge: number };

function age(since: Date, now: Date): number {
  return Math.max(0, round1(daysBetween(since, now)));
}

/** All items of every signal, worst (oldest) first. Nothing is cut here: bottlenecks count everything. */
export function computeSignalItems(d: SignalData): Record<InsightSignalId, InsightItem[]> {
  const now = d.now;
  const wsById = new Map(d.workstreams.map((w) => [w.id, w]));
  const nameOfActor = (a: ActorRef): string => (a.id ? (d.names.get(a.id)?.name ?? a.id) : 'system');
  const accountable = (w: Pick<IWorkstream, 'accountableUserId'> | undefined) => actorOf(w?.accountableUserId, d.names);
  const out = Object.fromEntries(INSIGHT_SIGNAL_IDS.map((id) => [id, [] as InsightItem[]])) as Record<InsightSignalId, InsightItem[]>;
  const wsBase = (w: Pick<IWorkstream, 'id' | 'key' | 'title'>) => ({ type: 'workstream' as const, id: w.id, key: w.key, title: w.title, workstreamKey: w.key });
  const finish = (id: InsightSignalId, found: Found[]) => {
    out[id] = found
      .sort((a, b) => b.sortAge - a.sortAge || (a.item.key ?? a.item.id).localeCompare(b.item.key ?? b.item.id))
      .map((f) => f.item);
  };

  // blocked_workstreams: why, from the same facts derive-status uses
  {
    const found: Found[] = [];
    for (const w of d.workstreams) {
      if (w.status !== 'blocked') continue;
      const since = d.facts.get(w.id)?.enteredStatusAt ?? w.updatedAt;
      const reasons: string[] = [];
      const prs = d.artifacts.filter((a) => a.workstreamId === w.id && isPr(a) && a.state === 'open');
      const failing = prs.filter((a) => a.ci === 'failing').length;
      const conflicts = prs.filter((a) => a.hasConflicts).length;
      if (failing) reasons.push(`CI failing on ${plural(failing, 'pull request')}`);
      if (conflicts) reasons.push(`merge conflicts on ${plural(conflicts, 'pull request')}`);
      for (const dep of d.dependencies) {
        const source = wsById.get(dep.fromId);
        if (dep.toId === w.id && source && source.status !== 'shipped') reasons.push(`waiting on ${source.key}`);
      }
      const days = age(since, now);
      found.push({
        sortAge: days,
        item: {
          ...wsBase(w),
          since: since.toISOString(),
          ageDays: days,
          waitingOn: accountable(w),
          detail: `Blocked for ${span(days)}: ${reasons.length ? reasons.join('; ') : 'pinned as blocked, no automatic reason'}`,
        },
      });
    }
    finish('blocked_workstreams', found);
  }

  // needs_input: open questions on workstreams that are still open
  {
    const found: Found[] = [];
    for (const r of d.inputRequests) {
      const w = wsById.get(r.workstreamId);
      if (!w || !isOpenWs(w)) continue;
      const who = r.assigneeUserId ? actorOf(r.assigneeUserId, d.names) : accountable(w);
      const days = age(r.createdAt, now);
      found.push({
        sortAge: days,
        item: {
          type: 'workstream',
          id: w.id,
          key: w.key,
          workstreamKey: w.key,
          title: short(r.question, 120),
          since: r.createdAt.toISOString(),
          ageDays: days,
          waitingOn: who,
          detail: `${w.key} asked by ${nameOfActor(r.requestedBy)}${r.requestedBy.type === 'agent' ? ' (agent)' : ''}, waiting ${span(days)} on ${who.name}`,
        },
      });
    }
    finish('needs_input', found);
  }

  // stale_workstreams
  {
    const found: Found[] = [];
    for (const w of d.workstreams) {
      if (!STALE_STATUSES.includes(w.status)) continue;
      const last = d.facts.get(w.id)?.lastActivityAt ?? w.updatedAt;
      const days = age(last, now);
      if (days < d.staleDays) continue;
      found.push({
        sortAge: days,
        item: {
          ...wsBase(w),
          since: last.toISOString(),
          ageDays: days,
          waitingOn: accountable(w),
          detail: `${w.status.replace(/_/g, ' ')}, no activity for ${span(days)}`,
        },
      });
    }
    finish('stale_workstreams', found);
  }

  // stale_issues
  {
    const found: Found[] = [];
    for (const i of d.issues) {
      if (i.status !== 'in_progress' && i.status !== 'in_review') continue;
      const days = age(i.updatedAt, now);
      if (days < d.staleDays) continue;
      found.push({
        sortAge: days,
        item: {
          type: 'issue',
          id: i.id,
          key: i.key,
          title: i.title,
          workstreamKey: i.workstreamIds.map((id) => wsById.get(id)?.key).find(Boolean),
          since: i.updatedAt.toISOString(),
          ageDays: days,
          waitingOn: actorOf(i.assigneeId, d.names),
          detail: `${i.status.replace(/_/g, ' ')}, not updated for ${span(days)}`,
        },
      });
    }
    finish('stale_issues', found);
  }

  // delivered_outcome_open: delivery evidence is there, the outcome is not
  {
    const openIssues = new Map<string, number>();
    for (const i of d.issues)
      if (i.status !== 'done' && i.status !== 'canceled' && i.status !== 'draft')
        for (const id of i.workstreamIds) openIssues.set(id, (openIssues.get(id) ?? 0) + 1);
    const inputs = new Map<string, number>();
    for (const r of d.inputRequests) inputs.set(r.workstreamId, (inputs.get(r.workstreamId) ?? 0) + 1);
    const decisions = new Map<string, number>();
    for (const dec of d.decisions) {
      if (dec.status !== 'proposed') continue;
      for (const id of new Set([dec.originWorkstreamId, ...dec.relatedWorkstreamIds])) if (id) decisions.set(id, (decisions.get(id) ?? 0) + 1);
    }
    const found: Found[] = [];
    for (const w of d.workstreams) {
      if (!isOpenWs(w) || (w.delivery !== 'merged' && w.delivery !== 'released' && w.delivery !== 'deployed')) continue;
      const delivering = d.artifacts.filter(
        (a) =>
          a.workstreamId === w.id &&
          ((isPr(a) && a.state === 'merged') ||
            (a.kind === 'release' && a.state === 'published') ||
            (a.kind === 'deployment' && a.state === 'healthy')),
      );
      const since = delivering.length ? new Date(Math.max(...delivering.map((a) => a.updatedAt.getTime()))) : w.updatedAt;
      const days = age(since, now);
      const open: string[] = [];
      const pending = w.acceptanceCriteria.filter((c) => c.state !== 'met').length;
      if (pending) open.push(plural(pending, 'criterion', 'criteria') + ' not met');
      if (openIssues.get(w.id)) open.push(plural(openIssues.get(w.id)!, 'open issue'));
      if (w.status === 'blocked') open.push('blocked');
      if (inputs.get(w.id)) open.push(plural(inputs.get(w.id)!, 'open question'));
      if (decisions.get(w.id)) open.push(plural(decisions.get(w.id)!, 'undecided decision'));
      found.push({
        sortAge: days,
        item: {
          ...wsBase(w),
          since: since.toISOString(),
          ageDays: days,
          waitingOn: accountable(w),
          detail: `${w.delivery} ${span(days)} ago, still ${w.status.replace(/_/g, ' ')}: ${open.length ? open.join(', ') : 'outcome not confirmed'}`,
        },
      });
    }
    finish('delivered_outcome_open', found);
  }

  // shipped_without_proof: shipped workstreams that would not ship under today's rules. Read-only:
  // nothing here changes a status, and historic workstreams stay shipped.
  {
    const found: Found[] = [];
    for (const w of d.shippedHistory) {
      const gaps = shippedProofGaps(w);
      if (!gaps.length) continue;
      const since = w.shippedAt ?? w.updatedAt;
      const days = age(since, now);
      const unproven = unprovenCriteria(w.acceptanceCriteria).length;
      found.push({
        sortAge: days,
        item: {
          ...wsBase(w),
          since: since.toISOString(),
          ageDays: days,
          waitingOn: accountable(w),
          value: gaps.includes('unproven_criteria') ? unproven : undefined,
          detail: `Shipped ${span(days)} ago: ${gaps.map((g) => PROOF_GAP_TEXT(g, unproven)).join('; ')}`,
        },
      });
    }
    finish('shipped_without_proof', found);
  }

  // overdue_milestones: a date-only target (midnight UTC) means "by the end of that day"
  {
    const found: Found[] = [];
    for (const m of d.milestones) {
      if (!m.targetDate || m.openIssues <= 0 || m.projectStatus === 'completed' || m.projectStatus === 'canceled') continue;
      const t = m.targetDate.getTime();
      const due = new Date(t % DAY === 0 ? t + DAY - 1 : t);
      if (due.getTime() >= now.getTime()) continue;
      const days = age(due, now);
      found.push({
        sortAge: days,
        item: {
          type: 'milestone',
          id: m.id,
          projectId: m.projectId,
          title: `${m.projectName}: ${m.name}`,
          since: due.toISOString(),
          ageDays: days,
          value: m.openIssues,
          detail: `${m.openIssues} of ${m.openIssues + m.doneIssues} issues still open, ${span(days)} past ${m.targetDate.toISOString().slice(0, 10)}`,
        },
      });
    }
    finish('overdue_milestones', found);
  }

  // overdue_workstreams
  {
    const found: Found[] = [];
    for (const w of d.workstreams) {
      if (!isOpenWs(w) || !w.targetDate || w.targetDate.getTime() >= now.getTime()) continue;
      const t = w.targetDate.getTime();
      const due = new Date(t % DAY === 0 ? t + DAY - 1 : t);
      if (due.getTime() >= now.getTime()) continue;
      const days = age(due, now);
      found.push({
        sortAge: days,
        item: {
          ...wsBase(w),
          since: due.toISOString(),
          ageDays: days,
          waitingOn: accountable(w),
          detail: `${w.status.replace(/_/g, ' ')}, ${span(days)} past ${w.targetDate.toISOString().slice(0, 10)}`,
        },
      });
    }
    finish('overdue_workstreams', found);
  }

  // scope_creep: issues first linked after the workstream started, inside the range
  {
    const issueById = new Map(d.issues.map((i) => [i.id, i]));
    const found: Found[] = [];
    for (const w of d.workstreams) {
      if (!isOpenWs(w)) continue;
      const f = d.facts.get(w.id);
      const started = f?.startedAt ?? (w.startDate && w.startDate.getTime() <= now.getTime() ? w.startDate : undefined);
      if (!started) continue;
      const added = d.issueLinks.filter((l) => {
        if (l.workstreamId !== w.id || l.at.getTime() <= started.getTime() || l.at.getTime() < d.rangeFrom.getTime()) return false;
        const issue = issueById.get(l.issueId);
        return !issue || issue.status !== 'canceled';
      });
      if (added.length < SCOPE_CREEP_MIN_ADDED) continue;
      const first = new Date(Math.min(...added.map((l) => l.at.getTime())));
      const days = age(first, now);
      found.push({
        sortAge: added.length,
        item: {
          ...wsBase(w),
          since: first.toISOString(),
          ageDays: days,
          waitingOn: accountable(w),
          value: added.length,
          detail: `${plural(added.length, 'issue')} added after the work started ${span(age(started, now))} ago`,
        },
      });
    }
    finish('scope_creep', found);
  }

  // prs_stuck_in_review
  {
    const found: Found[] = [];
    for (const a of d.artifacts) {
      if (!isPr(a) || a.state !== 'open' || a.review === 'approved') continue;
      const days = age(a.updatedAt, now);
      if (days < REVIEW_STUCK_DAYS) continue;
      const w = a.workstreamId ? wsById.get(a.workstreamId) : undefined;
      found.push({
        sortAge: days,
        item: {
          type: 'artifact',
          id: a.id,
          key: a.externalId ?? undefined,
          title: short(a.title, 120),
          workstreamKey: w?.key,
          since: a.updatedAt.toISOString(),
          ageDays: days,
          waitingOn: accountable(w),
          detail: `${a.review && a.review !== 'none' ? `Review ${a.review.replace(/_/g, ' ')}` : 'No review yet'}, CI ${a.ci ?? 'unknown'}, no update for ${span(days)}`,
        },
      });
    }
    finish('prs_stuck_in_review', found);
  }

  // ci_failing
  {
    const found: Found[] = [];
    for (const a of d.artifacts) {
      if (!isPr(a) || a.state !== 'open' || a.ci !== 'failing') continue;
      const since = a.ciFailedAt ?? a.updatedAt;
      const days = age(since, now);
      const w = a.workstreamId ? wsById.get(a.workstreamId) : undefined;
      const author = a.authorRef?.id ? actorOf(a.authorRef.id, d.names) : undefined;
      found.push({
        sortAge: days,
        item: {
          type: 'artifact',
          id: a.id,
          key: a.externalId ?? undefined,
          title: short(a.title, 120),
          workstreamKey: w?.key,
          since: since.toISOString(),
          ageDays: days,
          waitingOn: author ?? accountable(w),
          detail: `CI failing for ${span(days)}${author ? `, authored by ${author.name}${author.type === 'agent' ? ' (agent)' : ''}` : ''}`,
        },
      });
    }
    finish('ci_failing', found);
  }

  // undecided_decisions
  {
    const found: Found[] = [];
    for (const dec of d.decisions) {
      if (dec.status !== 'proposed') continue;
      const origin = dec.originWorkstreamId ? wsById.get(dec.originWorkstreamId) : undefined;
      const days = age(dec.createdAt, now);
      found.push({
        sortAge: days,
        item: {
          type: 'decision',
          id: dec.id,
          key: dec.key,
          title: dec.title,
          workstreamKey: origin?.key,
          since: dec.createdAt.toISOString(),
          ageDays: days,
          waitingOn: accountable(origin),
          detail: `Proposed by ${nameOfActor(dec.proposedBy)} ${span(days)} ago, nobody has decided`,
        },
      });
    }
    finish('undecided_decisions', found);
  }

  // customer_demand_waiting: one row per issue or project, oldest request first
  {
    const groups = new Map<string, ICustomerRequest[]>();
    for (const r of d.customerRequests) groups.set(`${r.targetType}:${r.targetId}`, [...(groups.get(`${r.targetType}:${r.targetId}`) ?? []), r]);
    const found: Found[] = [];
    for (const rows of groups.values()) {
      const first = rows[0];
      const oldest = new Date(Math.min(...rows.map((r) => r.createdAt.getTime())));
      const customers = new Set(rows.map((r) => r.customerName));
      const important = rows.filter((r) => r.important).length;
      const days = age(oldest, now);
      found.push({
        sortAge: days,
        item: {
          type: first.targetType,
          id: first.targetId,
          ...(first.targetType === 'project' ? { projectId: first.targetId } : {}),
          key: first.targetKey,
          title: first.targetTitle,
          since: oldest.toISOString(),
          ageDays: days,
          value: customers.size,
          detail: `${plural(customers.size, 'customer')} waiting, oldest ${span(days)}${important ? `, ${important} marked important` : ''}`,
        },
      });
    }
    finish('customer_demand_waiting', found);
  }

  return out;
}

// ───── severity

interface SeverityRule {
  /** Minimum severity as soon as one item exists. */
  base: Exclude<InsightSeverity, 'ok'>;
  warnAt?: number;
  critAt?: number;
}

export function severityRules(staleDays: number): Record<InsightSignalId, SeverityRule> {
  return {
    blocked_workstreams: { base: 'warning', critAt: 3 },
    needs_input: { base: 'info', warnAt: 1, critAt: 3 },
    stale_workstreams: { base: 'warning', critAt: staleDays * 3 },
    stale_issues: { base: 'warning', critAt: staleDays * 3 },
    delivered_outcome_open: { base: 'info', warnAt: 7 },
    // History, not a live problem: it never escalates.
    shipped_without_proof: { base: 'info' },
    overdue_milestones: { base: 'warning', critAt: 7 },
    overdue_workstreams: { base: 'warning', critAt: 7 },
    scope_creep: { base: 'warning' },
    prs_stuck_in_review: { base: 'warning', critAt: 7 },
    ci_failing: { base: 'warning', critAt: 2 },
    undecided_decisions: { base: 'info', warnAt: 3, critAt: 14 },
    customer_demand_waiting: { base: 'info', warnAt: 30, critAt: 90 },
  };
}

export function severityOf(rule: SeverityRule, count: number, oldestDays: number | undefined): InsightSeverity {
  if (count === 0) return 'ok';
  const oldest = oldestDays ?? 0;
  if (rule.critAt !== undefined && oldest >= rule.critAt) return 'critical';
  if (rule.warnAt !== undefined && oldest >= rule.warnAt) return 'warning';
  return rule.base;
}

/** Wraps the full item lists into signals. `limit` cuts the items, never the count. */
export function buildSignals(items: Record<InsightSignalId, InsightItem[]>, staleDays: number, limit: number): InsightSignal[] {
  const rules = severityRules(staleDays);
  return INSIGHT_SIGNAL_IDS.map((id) => {
    const list = items[id];
    const oldest = list.reduce<number | undefined>((m, i) => (i.ageDays === undefined ? m : Math.max(m ?? 0, i.ageDays)), undefined);
    const meta = INSIGHT_SIGNALS[id];
    return {
      id,
      label: meta.label,
      definition: meta.definition,
      unit: meta.unit,
      severity: severityOf(rules[id], list.length, oldest),
      count: list.length,
      ...(oldest !== undefined ? { oldestDays: oldest } : {}),
      items: list.slice(0, limit),
      truncated: list.length > limit,
    };
  });
}

/** Who everything waits on: open questions, undecided decisions and PRs waiting for review. */
export function computeBottlenecks(items: Record<InsightSignalId, InsightItem[]>): InsightBottleneck[] {
  const rows = new Map<string, InsightBottleneck>();
  const add = (list: InsightItem[], field: 'inputRequests' | 'decisions' | 'reviews') => {
    for (const i of list) {
      const actor = i.waitingOn ?? UNASSIGNED;
      const key = actor.id ?? 'unassigned';
      const row = rows.get(key) ?? { actor, inputRequests: 0, decisions: 0, reviews: 0, oldestDays: 0, totalWaitDays: 0 };
      row[field] += 1;
      row.oldestDays = Math.max(row.oldestDays, i.ageDays ?? 0);
      row.totalWaitDays = round1(row.totalWaitDays + (i.ageDays ?? 0));
      rows.set(key, row);
    }
  };
  add(items.needs_input, 'inputRequests');
  add(items.undecided_decisions, 'decisions');
  add(items.prs_stuck_in_review, 'reviews');
  return [...rows.values()].sort((a, b) => b.totalWaitDays - a.totalWaitDays || (a.actor.id ?? '').localeCompare(b.actor.id ?? ''));
}
