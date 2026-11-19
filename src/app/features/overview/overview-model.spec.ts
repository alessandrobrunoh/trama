import { describe, expect, it } from 'vitest';
import type { AttentionItem, Issue, Milestone, Project } from '../../core/contracts/domain';
import {
  DAY_MS,
  dailyFlow,
  deltaText,
  headline,
  lanes,
  phaseOf,
  projectRows,
  pulse,
  trackScale,
  watchlist,
  weekTotals,
  type HeadlinePart,
  type OverviewContext,
} from './overview-model';

// Local noon, so day buckets do not depend on the time zone the tests run in.
const NOW = new Date(2026, 2, 20, 12, 0, 0);
const iso = (offsetDays: number): string => new Date(NOW.getTime() + offsetDays * DAY_MS).toISOString();

const issue = (id: string, patch: Partial<Issue> = {}): Issue =>
  ({
    id,
    workspaceId: 'w',
    key: `T-${id}`,
    number: 1,
    kind: 'feature',
    title: `Task ${id}`,
    source: 'manual',
    priority: 'none',
    status: 'todo',
    milestoneIds: [],
    labels: [],
    aliases: [],
    createdAt: iso(-60),
    updatedAt: iso(-60),
    ...patch,
  }) as Issue;

const project = (id: string, patch: Partial<Project> = {}): Project =>
  ({
    id,
    workspaceId: 'w',
    name: `Project ${id}`,
    key: id.toUpperCase(),
    color: '#888',
    status: 'in_progress',
    priority: 'none',
    labels: [],
    createdAt: iso(-100),
    updatedAt: iso(-1),
    ...patch,
  }) as Project;

const milestone = (id: string, projectId: string, patch: Partial<Milestone> = {}): Milestone =>
  ({ id, workspaceId: 'w', projectId, name: `Milestone ${id}`, sortOrder: 0, createdAt: iso(-90), updatedAt: iso(-1), ...patch }) as Milestone;

const ctx = (patch: Partial<OverviewContext> = {}): OverviewContext => {
  const issues = patch.issues ?? [];
  return {
    now: NOW,
    issues,
    projects: [],
    milestones: [],
    issueType: (s) => s,
    projectType: (s) => s,
    issueLabel: (s) => (s === 'in_review' ? 'In review' : 'In progress'),
    activityAt: (i) => Date.parse(i.updatedAt),
    idleDays: 7,
    attention: [],
    timers: [],
    ...patch,
  };
};

const text = (parts: HeadlinePart[]): string => parts.map((p) => p.text).join('');

describe('phaseOf', () => {
  it('groups status types by what they mean for the flow of work', () => {
    expect(phaseOf('in_progress')).toBe('active');
    expect(phaseOf('in_review')).toBe('active');
    expect(phaseOf('done')).toBe('done');
    expect(phaseOf('canceled')).toBe('canceled');
    expect(phaseOf('backlog')).toBe('open');
    expect(phaseOf(undefined)).toBe('open');
  });
});

describe('dailyFlow', () => {
  it('covers 28 days ending today and counts opened and closed tasks per day', () => {
    const flow = dailyFlow(
      ctx({
        issues: [
          issue('a', { createdAt: iso(0), status: 'todo' }),
          issue('b', { createdAt: iso(0) }),
          issue('c', { createdAt: iso(-3), status: 'done', completedAt: iso(-1) }),
          issue('old', { createdAt: iso(-40), status: 'done', completedAt: iso(-35) }),
          issue('gone', { createdAt: iso(-2), status: 'canceled', completedAt: iso(-1) }),
        ],
      }),
    );
    expect(flow).toHaveLength(28);
    expect(flow[27].today).toBe(true);
    expect(flow[27].created).toBe(2);
    expect(flow[26].closed).toBe(1);
    // Canceled tasks were opened but never count as closed work.
    expect(flow[25].created).toBe(1);
    expect(flow.reduce((n, d) => n + d.closed, 0)).toBe(1);
  });

  it('pins milestones reached, milestones missed and projects completed on their day', () => {
    const flow = dailyFlow(
      ctx({
        projects: [project('p1'), project('done', { status: 'completed', completedAt: iso(-5) })],
        milestones: [
          milestone('hit', 'p1'),
          milestone('late', 'p1', { targetDate: iso(-2) }),
          milestone('future', 'p1', { targetDate: iso(10) }),
        ],
        issues: [
          issue('a', { projectId: 'p1', milestoneIds: ['hit'], status: 'done', completedAt: iso(-4) }),
          issue('b', { projectId: 'p1', milestoneIds: ['late'], status: 'in_progress' }),
          issue('c', { projectId: 'p1', milestoneIds: ['future'], status: 'in_progress' }),
        ],
      }),
    );
    const kinds = (offset: number): string[] => flow[27 + offset].events.map((e) => e.kind);
    expect(kinds(-4)).toEqual(['milestone_hit']);
    expect(kinds(-2)).toEqual(['milestone_missed']);
    expect(kinds(-5)).toEqual(['project_done']);
    expect(flow.flatMap((d) => d.events)).toHaveLength(3);
  });

  it('cuts the river into four weeks, the last one ending today', () => {
    const flow = dailyFlow(ctx({ issues: [issue('a', { createdAt: iso(0), status: 'done', completedAt: iso(0) }), issue('b', { createdAt: iso(-8) })] }));
    const weeks = weekTotals(flow);
    expect(weeks).toHaveLength(4);
    expect(weeks[3]).toMatchObject({ current: true, created: 1, closed: 1 });
    expect(weeks[2]).toMatchObject({ current: false, created: 1, closed: 0 });
  });
});

describe('lanes', () => {
  it('groups work in flight by assignee, running timers first and unowned work last', () => {
    const result = lanes(
      ctx({
        issues: [
          issue('1', { status: 'in_progress', assigneeId: 'ana', updatedAt: iso(-1) }),
          issue('2', { status: 'in_review', assigneeId: 'ana', updatedAt: iso(-12) }),
          issue('3', { status: 'in_progress', assigneeId: 'bo', updatedAt: iso(-1) }),
          issue('4', { status: 'in_progress', updatedAt: iso(-1) }),
          issue('5', { status: 'todo', assigneeId: 'bo' }),
        ],
        timers: [{ issueId: '3', userId: 'bo', startedAt: iso(0) }],
      }),
    );
    expect(result.map((l) => l.userId)).toEqual(['bo', 'ana', null]);
    expect(result[0].running).toBe(true);
    expect(result[1].tasks.map((t) => t.issue.id)).toEqual(['1', '2']);
    expect(result[1].idle).toBe(1);
    expect(result[1].tasks[1]).toMatchObject({ idle: true, idleDays: 12 });
  });
});

describe('projectRows', () => {
  const rows = (): ReturnType<typeof projectRows> => {
    const closed = (id: string, p: string, at: number): Issue =>
      issue(id, { projectId: p, status: 'done', createdAt: iso(-60), completedAt: iso(at), updatedAt: iso(at) });
    return projectRows(
      ctx({
        projects: [
          project('calm', { targetDate: iso(120), startDate: iso(-30) }),
          project('late', { targetDate: iso(-9), startDate: iso(-60) }),
          project('shipped', { status: 'completed' }),
          project('slow', { targetDate: iso(20), startDate: iso(-60) }),
        ],
        issues: [
          // calm: a steady pace and plenty of time
          closed('c1', 'calm', -2),
          closed('c2', 'calm', -3),
          closed('c3', 'calm', -9),
          issue('c4', { projectId: 'calm', status: 'in_progress', updatedAt: iso(-1) }),
          // late: its target passed with work left
          closed('l1', 'late', -20),
          issue('l2', { projectId: 'late', status: 'todo' }),
          // slow: 2 tasks per 6 weeks against 10 open tasks
          closed('s1', 'slow', -10),
          closed('s2', 'slow', -20),
          ...Array.from({ length: 10 }, (_, n) => issue(`s-open${n}`, { projectId: 'slow', status: 'todo' })),
        ],
      }),
    );
  };

  it('leaves closed projects out and puts the most worrying first', () => {
    const r = rows();
    // Both are off track; the one further behind comes first.
    expect(r.map((x) => x.project.id)).toEqual(['slow', 'late', 'calm']);
    expect(r[0].signal).toBe('off_track');
    expect(r[0].behindDays).toBeGreaterThan(100);
    expect(r[1].behindDays).toBe(9);
    expect(r[2].signal).toBe('on_track');
  });

  it('measures progress and momentum', () => {
    const calm = rows().find((x) => x.project.id === 'calm')!;
    expect(calm).toMatchObject({ done: 3, active: 1, open: 0, total: 4, percent: 75 });
    expect(calm.closedThisWeek).toBe(2);
    expect(calm.closedLastWeek).toBe(1);
    expect(calm.momentum).toBe('up');
    expect(rows().find((x) => x.project.id === 'late')!.momentum).toBe('none');
  });

  it('keeps every target and projected end on one shared track', () => {
    const r = rows();
    const scale = trackScale(r, NOW);
    expect(scale.todayPos).toBeGreaterThan(0);
    expect(scale.todayPos).toBeLessThan(1);
    // An overdue target sits to the left of today.
    expect(scale.pos(r[1].target!)).toBeLessThan(scale.todayPos);
    // A target far ahead sits to the right of today.
    expect(scale.pos(r[2].target!)).toBeGreaterThan(scale.todayPos);
    // Dates outside the window stick to its edge.
    expect(scale.pos(new Date(2100, 0, 1))).toBe(1);
  });
});

describe('headline', () => {
  it('says how much is moving and stuck, and which project is furthest behind', () => {
    const c = ctx({
      projects: [project('atlas', { name: 'Atlas', targetDate: iso(-9), startDate: iso(-60) })],
      issues: [
        issue('1', { projectId: 'atlas', status: 'in_progress', updatedAt: iso(-1) }),
        issue('2', { projectId: 'atlas', status: 'in_progress', updatedAt: iso(-2) }),
        issue('3', { projectId: 'atlas', status: 'in_review', updatedAt: iso(-20) }),
      ],
    });
    const parts = headline(pulse(c), projectRows(c));
    expect(text(parts)).toBe('2 tasks moving, 1 stuck. Atlas is 9 days behind.');
    expect(parts.find((p) => p.text === 'Atlas')?.target).toEqual({ kind: 'project', id: expect.any(String) });
  });

  it('counts the other slipping projects and handles a quiet workspace', () => {
    const c = ctx({
      projects: [
        project('a', { name: 'A', targetDate: iso(-9) }),
        project('b', { name: 'B', targetDate: iso(-3) }),
      ],
      issues: [
        issue('1', { projectId: 'a', status: 'todo' }),
        issue('2', { projectId: 'b', status: 'todo' }),
      ],
    });
    expect(text(headline(pulse(c), projectRows(c)))).toBe(
      'Nothing is in progress, 2 waiting to start. A is 9 days behind, and 1 other project is slipping.',
    );
    expect(text(headline(pulse(ctx()), []))).toBe('Nothing is in progress.');
  });

  it('uses the singular, and only calls the projects on track when every one is projected on time', () => {
    const closed = (id: string, at: number): Issue =>
      issue(id, { projectId: 'a', status: 'done', completedAt: iso(at), updatedAt: iso(at) });
    const base = {
      projects: [project('a', { name: 'A', targetDate: iso(200), startDate: iso(-30) })],
    };
    // No pace yet: nothing to claim.
    const unknown = ctx({ ...base, issues: [issue('1', { projectId: 'a', status: 'in_progress', updatedAt: iso(0) })] });
    expect(text(headline(pulse(unknown), projectRows(unknown)))).toBe('1 task moving.');
    const steady = ctx({
      ...base,
      issues: [issue('1', { projectId: 'a', status: 'in_progress', updatedAt: iso(0) }), closed('2', -2), closed('3', -5)],
    });
    expect(text(headline(pulse(steady), projectRows(steady)))).toBe('1 task moving. Every project is on track.');
  });

  it('writes the weekly delta', () => {
    expect(deltaText(8, 5)).toBe('+3 vs last week');
    expect(deltaText(2, 5)).toBe('−3 vs last week');
    expect(deltaText(4, 4)).toBe('same as last week');
  });
});

describe('watchlist', () => {
  const attention = (patch: Partial<AttentionItem>): AttentionItem => ({
    id: 'att',
    kind: 'review_requested',
    severity: 'high',
    title: 'Review requested on a pull request',
    detail: '',
    issueId: 'r',
    since: iso(-1),
    state: 'open',
    ...patch,
  });

  it('ranks what needs a human above stale work and explains each entry in plain words', () => {
    const items = watchlist(
      ctx({
        issues: [
          issue('r', { status: 'in_review', updatedAt: iso(-1) }),
          issue('s', { status: 'in_progress', updatedAt: iso(-15) }),
          issue('u', { status: 'todo', priority: 'urgent' }),
        ],
        attention: [attention({})],
      }),
    );
    expect(items.map((i) => i.kind)).toEqual(['needs_you', 'unowned_urgent', 'stale']);
    expect(items[0].reason).toBe('Review requested on a pull request');
    expect(items[1].reason).toBe('Urgent and nobody owns it');
    expect(items[2].reason).toBe('In progress, but nothing has happened for 15 days');
    expect(items[2].target).toEqual({ kind: 'task', idOrKey: 'T-s' });
  });

  it('flags a parent held up by quiet subtasks and a milestone that passed its date', () => {
    const items = watchlist(
      ctx({
        projects: [project('p')],
        milestones: [milestone('m', 'p', { targetDate: iso(-6) })],
        issues: [
          issue('parent', { status: 'in_progress', updatedAt: iso(-1) }),
          issue('k1', { parentId: 'parent', status: 'todo', updatedAt: iso(-20) }),
          issue('k2', { parentId: 'parent', status: 'todo', updatedAt: iso(-30) }),
          issue('m1', { projectId: 'p', milestoneIds: ['m'], status: 'done', completedAt: iso(-8) }),
          issue('m2', { projectId: 'p', milestoneIds: ['m'], status: 'todo' }),
        ],
      }),
    );
    const held = items.find((i) => i.kind === 'held_up')!;
    expect(held.reason).toBe('Waits on 2 subtasks that nobody touched for 20 days');
    const overdue = items.find((i) => i.kind === 'milestone_overdue')!;
    expect(overdue.reason).toBe('Due 6 days ago, 1 of 2 tasks still open');
    expect(overdue.target).toEqual({ kind: 'project', id: 'p' });
  });

  it('shows at most five and gives other kinds a turn before a third of one kind', () => {
    const issues = Array.from({ length: 8 }, (_, n) => issue(`s${n}`, { status: 'in_progress', updatedAt: iso(-20 - n) }));
    const items = watchlist(
      ctx({
        issues: [...issues, issue('u', { status: 'todo', priority: 'urgent' }), issue('h', { status: 'todo', priority: 'high' })],
      }),
    );
    expect(items).toHaveLength(5);
    // Two urgent / high tasks nobody owns made the list; the fifth slot goes to a third stale task.
    expect(items.filter((i) => i.kind === 'unowned_urgent')).toHaveLength(2);
    expect(items.filter((i) => i.kind === 'stale')).toHaveLength(3);
  });

  it('lists a task once even when it matches several rules', () => {
    const items = watchlist(ctx({ issues: [issue('x', { status: 'in_progress', priority: 'urgent', updatedAt: iso(-20) })] }));
    expect(items).toHaveLength(1);
  });

  it('is empty when nothing is wrong', () => {
    expect(watchlist(ctx({ issues: [issue('ok', { status: 'in_progress', updatedAt: iso(0) })] }))).toEqual([]);
  });
});
