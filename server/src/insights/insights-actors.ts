import type {
  ActorRef,
  AgentFailureRow,
  ArtifactKind,
  ArtifactState,
  CiState,
  InputRequestState,
  InsightActors,
  InsightContributor,
} from '../contracts/domain.js';
import { actorOf, percentile, round1, type NameIndex } from './insights-util.js';

/** `domain_events` grouped by actor, type and (for status changes) target status. */
export interface EventCountRow {
  actorType: string;
  actorId: string | null;
  type: string;
  to: string | null;
  n: number;
  lastAt: Date;
}

export interface ActorArtifact {
  kind: ArtifactKind;
  state: ArtifactState;
  ci: CiState | null;
  authorRef: ActorRef | null;
  createdAt: Date;
}

export interface ActorInputRequest {
  requestedBy: ActorRef;
  state: InputRequestState;
  createdAt: Date;
  answeredAt: Date | null;
}

export interface ActorsData {
  names: NameIndex;
  /** Every agent of the workspace, so quiet agents show up with zeros only if they did something. */
  agentIds: string[];
  rangeFrom: Date;
  events: EventCountRow[];
  /** Pull requests authored by a person or agent: created in the range, or still open. */
  artifacts: ActorArtifact[];
  /** Questions raised in the range, plus every question still open. */
  inputRequests: ActorInputRequest[];
  /** Issues an agent moved to Done that were moved out of Done again, per agent. */
  reopenedByAgent: ReadonlyMap<string, number>;
}

const isPr = (a: ActorArtifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';

function contributors(d: ActorsData, type: 'user' | 'agent'): InsightContributor[] {
  const rows = new Map<string, InsightContributor>();
  const row = (id: string): InsightContributor =>
    rows.get(id) ??
    rows
      .set(id, {
        actor: actorOf(id, d.names),
        events: 0,
        issuesDone: 0,
        comments: 0,
        pullRequests: 0,
        decisionsProposed: 0,
        inputRequestsRaised: 0,
      })
      .get(id)!;

  for (const e of d.events) {
    if (e.actorType !== type || !e.actorId) continue;
    const r = row(e.actorId);
    r.events += e.n;
    if (e.type === 'issue.status_changed' && e.to === 'done') r.issuesDone += e.n;
    if (e.type === 'comment.created') r.comments += e.n;
    if (e.type === 'decision.proposed') r.decisionsProposed += e.n;
    if (e.type === 'input.requested') r.inputRequestsRaised += e.n;
    if (!r.lastActiveAt || e.lastAt.toISOString() > r.lastActiveAt) r.lastActiveAt = e.lastAt.toISOString();
  }
  for (const a of d.artifacts) {
    if (!isPr(a) || a.authorRef?.type !== type || !a.authorRef.id || a.createdAt < d.rangeFrom) continue;
    row(a.authorRef.id).pullRequests += 1;
  }
  return [...rows.values()].sort((a, b) => b.events - a.events || a.actor.name.localeCompare(b.actor.name));
}

export function failureRows(d: ActorsData): AgentFailureRow[] {
  const out: AgentFailureRow[] = [];
  for (const id of d.agentIds) {
    const asked = d.inputRequests.filter((r) => r.requestedBy.type === 'agent' && r.requestedBy.id === id);
    const raised = asked.filter((r) => r.createdAt >= d.rangeFrom);
    const answered = raised
      .filter((r) => r.state === 'answered' && r.answeredAt)
      .map((r) => (r.answeredAt!.getTime() - r.createdAt.getTime()) / 3_600_000)
      .filter((h) => h >= 0)
      .sort((a, b) => a - b);
    const prs = d.artifacts.filter((a) => isPr(a) && a.authorRef?.type === 'agent' && a.authorRef.id === id);
    const inRange = prs.filter((a) => a.createdAt >= d.rangeFrom);
    const row: AgentFailureRow = {
      agent: actorOf(id, d.names),
      inputRequestsRaised: raised.length,
      inputRequestsOpen: asked.filter((r) => r.state === 'open').length,
      ...(answered.length ? { medianAnswerHours: round1(percentile(answered, 50)!) } : {}),
      pullRequests: inRange.length,
      pullRequestsAbandoned: inRange.filter((a) => a.state === 'closed').length,
      pullRequestsCiFailing: prs.filter((a) => a.state === 'open' && a.ci === 'failing').length,
      issuesReopened: d.reopenedByAgent.get(id) ?? 0,
    };
    const any = row.inputRequestsRaised + row.inputRequestsOpen + row.pullRequests + row.pullRequestsCiFailing + row.issuesReopened;
    if (any > 0) out.push(row);
  }
  return out.sort(
    (a, b) =>
      b.pullRequestsAbandoned + b.issuesReopened + b.pullRequestsCiFailing + b.inputRequestsOpen -
        (a.pullRequestsAbandoned + a.issuesReopened + a.pullRequestsCiFailing + a.inputRequestsOpen) ||
      a.agent.name.localeCompare(b.agent.name),
  );
}

export function computeActors(d: ActorsData): InsightActors {
  const people = contributors(d, 'user');
  const agents = contributors(d, 'agent');
  const p = people.reduce((n, c) => n + c.events, 0);
  const a = agents.reduce((n, c) => n + c.events, 0);
  const total = p + a;
  return {
    people,
    agents,
    share: { people: total ? round1((p / total) * 100) : 0, agents: total ? round1((a / total) * 100) : 0 },
    failures: failureRows(d),
  };
}
