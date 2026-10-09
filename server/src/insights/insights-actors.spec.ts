import { describe, expect, it } from 'vitest';
import { computeActors, failureRows, type ActorsData, type EventCountRow } from './insights-actors.js';
import { NAMES, ago } from './insights-fixtures-spec.js';
import { buildFacts } from './insights-facts.js';
import { ws } from './insights-fixtures-spec.js';

const ev = (actorType: string, actorId: string | null, type: string, n: number, to: string | null = null, lastAgo = 1): EventCountRow => ({
  actorType,
  actorId,
  type,
  to,
  n,
  lastAt: ago(lastAgo),
});

const base = (over: Partial<ActorsData> = {}): ActorsData => ({
  names: NAMES,
  agentIds: ['ag_bot'],
  rangeFrom: ago(30),
  events: [],
  artifacts: [],
  inputRequests: [],
  reopenedByAgent: new Map(),
  ...over,
});

describe('computeActors', () => {
  it('is empty and share 0/0 without events', () => {
    expect(computeActors(base())).toEqual({ people: [], agents: [], share: { people: 0, agents: 0 }, failures: [] });
  });

  it('separates people from agents and computes the share of events', () => {
    const a = computeActors(
      base({
        events: [
          ev('user', 'u_ada', 'issue.updated', 6),
          ev('user', 'u_ada', 'issue.status_changed', 2, 'done'),
          ev('user', 'u_ada', 'issue.status_changed', 1, 'in_progress'),
          ev('user', 'u_ada', 'comment.created', 3),
          ev('agent', 'ag_bot', 'issue.updated', 10, null, 0.5),
          ev('agent', 'ag_bot', 'input.requested', 2),
          ev('agent', 'ag_bot', 'decision.proposed', 1),
          ev('system', null, 'workstream.status_changed', 50),
        ],
      }),
    );
    expect(a.people).toHaveLength(1);
    expect(a.people[0]).toMatchObject({ events: 12, issuesDone: 2, comments: 3, actor: { name: 'Ada', type: 'user' } });
    expect(a.agents[0]).toMatchObject({ events: 13, inputRequestsRaised: 2, decisionsProposed: 1, actor: { name: 'Bot', type: 'agent' } });
    expect(a.share).toEqual({ people: 48, agents: 52 });
    expect(a.agents[0].lastActiveAt).toBe(ago(0.5).toISOString());
  });

  it('ignores events with no actor id and counts a person with an unknown id by id', () => {
    const a = computeActors(base({ events: [ev('user', null, 'x', 4), ev('user', 'u_gone', 'x', 1)] }));
    expect(a.people.map((p) => p.actor.name)).toEqual(['u_gone']);
  });

  it('counts pull requests authored in the range only', () => {
    const pr = (authorType: 'user' | 'agent', id: string, createdAgo: number, kind: 'pull_request' | 'deployment' = 'pull_request') => ({
      kind,
      state: 'open' as const,
      ci: null,
      authorRef: { type: authorType, id },
      createdAt: ago(createdAgo),
    });
    const a = computeActors(
      base({
        events: [ev('user', 'u_ada', 'x', 1), ev('agent', 'ag_bot', 'x', 1)],
        artifacts: [pr('user', 'u_ada', 2), pr('user', 'u_ada', 50), pr('agent', 'ag_bot', 1), pr('agent', 'ag_bot', 1, 'deployment')],
      }),
    );
    expect(a.people[0].pullRequests).toBe(1);
    expect(a.agents[0].pullRequests).toBe(1);
  });
});

describe('failureRows (agent failure signals)', () => {
  const answered = (hours: number, createdAgo = 5) => ({
    requestedBy: { type: 'agent' as const, id: 'ag_bot' },
    state: 'answered' as const,
    createdAt: ago(createdAgo),
    answeredAt: new Date(ago(createdAgo).getTime() + hours * 3_600_000),
  });

  it('omits agents that did nothing', () => {
    expect(failureRows(base())).toEqual([]);
  });

  it('counts questions, median answer time and open questions of any age', () => {
    const rows = failureRows(
      base({
        inputRequests: [
          answered(2),
          answered(10),
          answered(4),
          { requestedBy: { type: 'agent', id: 'ag_bot' }, state: 'open', createdAt: ago(3), answeredAt: null },
          { requestedBy: { type: 'agent', id: 'ag_bot' }, state: 'open', createdAt: ago(90), answeredAt: null },
          { requestedBy: { type: 'agent', id: 'other' }, state: 'open', createdAt: ago(1), answeredAt: null },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({ inputRequestsRaised: 4, inputRequestsOpen: 2, medianAnswerHours: 4 });
  });

  it('has no median answer time when nothing was answered', () => {
    const rows = failureRows(base({ inputRequests: [{ requestedBy: { type: 'agent', id: 'ag_bot' }, state: 'open', createdAt: ago(1), answeredAt: null }] }));
    expect(rows[0].medianAnswerHours).toBeUndefined();
  });

  it('counts abandoned (closed) pull requests, failing CI on open ones and reopened issues', () => {
    const art = (state: 'open' | 'closed' | 'merged', ci: 'failing' | 'passing' | null, createdAgo: number) => ({
      kind: 'pull_request' as const,
      state,
      ci,
      authorRef: { type: 'agent' as const, id: 'ag_bot' },
      createdAt: ago(createdAgo),
    });
    const rows = failureRows(
      base({
        artifacts: [art('closed', null, 3), art('merged', 'passing', 4), art('open', 'failing', 2), art('open', 'failing', 80), art('closed', null, 70)],
        reopenedByAgent: new Map([['ag_bot', 2]]),
      }),
    );
    expect(rows[0]).toMatchObject({
      pullRequests: 3,
      pullRequestsAbandoned: 1,
      pullRequestsCiFailing: 2,
      issuesReopened: 2,
    });
  });

  it('sorts the agent with the most trouble first', () => {
    const names = new Map(NAMES).set('ag_two', { name: 'Two', type: 'agent' });
    const rows = failureRows(base({ names, agentIds: ['ag_bot', 'ag_two'], reopenedByAgent: new Map([['ag_bot', 1], ['ag_two', 4]]) }));
    expect(rows.map((r) => r.agent.name)).toEqual(['Two', 'Bot']);
  });
});

describe('buildFacts', () => {
  const w = ws({ status: 'blocked' });
  const d = (n: number) => ago(n);

  it('takes the last entry into the current status, the first start and the last activity', () => {
    const facts = buildFacts(
      [w],
      [
        { id: w.id, to: 'planned', firstAt: d(30), lastAt: d(30) },
        { id: w.id, to: 'working', firstAt: d(20), lastAt: d(10) },
        { id: w.id, to: 'blocked', firstAt: d(8), lastAt: d(2) },
      ],
      [{ id: w.id, lastAt: d(1) }],
    ).get(w.id)!;
    expect(facts).toEqual({ enteredStatusAt: d(2), startedAt: d(20), lastActivityAt: d(1) });
  });

  it('leaves facts unset when there is no history, and ignores unknown workstreams', () => {
    const facts = buildFacts([w], [{ id: 'wk_other', to: 'working', firstAt: d(1), lastAt: d(1) }], [{ id: 'wk_other', lastAt: d(1) }]);
    expect(facts.get(w.id)).toEqual({});
    expect(facts.has('wk_other')).toBe(false);
  });

  it('does not treat planned or canceled as a start', () => {
    const facts = buildFacts([w], [{ id: w.id, to: 'planned', firstAt: d(3), lastAt: d(3) }, { id: w.id, to: 'canceled', firstAt: d(2), lastAt: d(2) }], []);
    expect(facts.get(w.id)!.startedAt).toBeUndefined();
  });

  it('sets no entry time when the current status was pinned without an event', () => {
    expect(buildFacts([w], [{ id: w.id, to: 'working', firstAt: d(3), lastAt: d(3) }], []).get(w.id)!.enteredStatusAt).toBeUndefined();
  });
});
