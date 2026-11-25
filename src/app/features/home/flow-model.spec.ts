import { describe, expect, it } from 'vitest';
import type { Issue, Milestone, Project } from '../../core/contracts/domain';
import { dailyFlow, weekTotals, type FlowContext } from './flow-model';

// Local noon, so day buckets do not depend on the time zone the tests run in.
const NOW = new Date(2026, 2, 20, 12, 0, 0);
const DAY_MS = 86_400_000;
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

const ctx = (patch: Partial<FlowContext> = {}): FlowContext => ({
  now: NOW,
  issues: [],
  projects: [],
  milestones: [],
  issueType: (s) => s,
  projectType: (s) => s,
  ...patch,
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
    const at = (offset: number) => flow[27 + offset].events;
    expect(at(-4).map((e) => e.kind)).toEqual(['milestone_hit']);
    expect(at(-2).map((e) => e.kind)).toEqual(['milestone_missed']);
    expect(at(-5)).toEqual([{ kind: 'project_done', label: 'Project done completed', projectId: 'done' }]);
    expect(flow.flatMap((d) => d.events)).toHaveLength(3);
  });

  it('cuts the days into four weeks, the last one ending today', () => {
    const flow = dailyFlow(ctx({ issues: [issue('a', { createdAt: iso(0), status: 'done', completedAt: iso(0) }), issue('b', { createdAt: iso(-8) })] }));
    const weeks = weekTotals(flow);
    expect(weeks).toHaveLength(4);
    expect(weeks[3]).toMatchObject({ current: true, created: 1, closed: 1 });
    expect(weeks[2]).toMatchObject({ current: false, created: 1, closed: 0 });
  });
});
