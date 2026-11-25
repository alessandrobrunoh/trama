import type { Issue } from '../../core';
import { dayOf } from '../milestones/milestone-model';
import { buildBurnView, burnBadge, dueText, slackText } from './project-burnup-model';

const TODAY = dayOf('2026-11-25T12:00:00');
const at = (offset: number): string => new Date(Date.parse('2026-11-25T12:00:00') + offset * 86_400_000).toISOString();

const issue = (id: string, patch: Partial<Issue> = {}): Issue =>
  ({
    id,
    workspaceId: 'w',
    key: `TRM-${id}`,
    number: 1,
    kind: 'feature',
    title: `Task ${id}`,
    source: 'manual',
    priority: 'none',
    status: 'todo',
    milestoneIds: [],
    labels: [],
    aliases: [],
    createdAt: at(-30),
    updatedAt: at(-1),
    ...patch,
  }) as Issue;

describe('buildBurnView', () => {
  const issues = [
    issue('1', { status: 'done', startedAt: at(-20), completedAt: at(-10) }),
    issue('2', { status: 'done', startedAt: at(-12), completedAt: at(-4) }),
    issue('3', { status: 'in_progress', startedAt: at(-3) }),
    issue('4'),
  ];

  it('projects to the day the work lands when it fits the chart', () => {
    const v = buildBurnView({
      issues,
      points: false,
      startDay: TODAY - 30,
      targetDay: TODAY + 60,
      today: TODAY,
      endHint: TODAY + 60,
      pad: 14,
    });
    expect(v.endDay).toBe(TODAY + 60);
    expect(v.proj?.reachesScope).toBe(true);
    expect(v.proj?.toValue).toBe(4);
    expect(v.etaDay).not.toBeNull();
    expect(v.slackDays).toBeLessThan(0);
  });

  it('clips the projection at the chart edge when the pace is too slow', () => {
    const slow = [issue('1', { status: 'done', startedAt: at(-29), completedAt: at(-28) }), ...Array.from({ length: 40 }, (_, i) => issue(`t${i}`))];
    const v = buildBurnView({ issues: slow, points: false, startDay: TODAY - 30, targetDay: null, today: TODAY, endHint: null, pad: 14 });
    expect(v.endDay).toBe(TODAY + 14);
    expect(v.proj?.reachesScope).toBe(false);
    expect(v.proj?.toDay).toBe(TODAY + 14);
    expect(v.proj?.toValue).toBeLessThan(41);
  });

  it('has no projection without a pace or when everything is done', () => {
    const idle = buildBurnView({ issues: [issue('1')], points: false, startDay: TODAY - 10, targetDay: null, today: TODAY, endHint: null, pad: 14 });
    expect(idle.proj).toBeNull();
    const done = buildBurnView({
      issues: [issue('1', { status: 'done', startedAt: at(-5), completedAt: at(-2) })],
      points: false,
      startDay: TODAY - 10,
      targetDay: null,
      today: TODAY,
      endHint: null,
      pad: 14,
    });
    expect(done.proj).toBeNull();
    expect(burnBadge(done.model, 'Shipped')).toEqual({ label: 'Shipped', tone: 'ok' });
    expect(burnBadge(idle.model, 'Shipped', 'Planned')).toEqual({ label: 'Planned', tone: 'idle' });
  });
});

describe('wording', () => {
  it('says how early or late', () => {
    expect(slackText(-31)).toBe('a month early');
    expect(slackText(-3)).toBe('3 days early');
    expect(slackText(1)).toBe('1 day late');
    expect(slackText(0)).toBe('on the date');
    expect(slackText(90)).toBe('3 months late');
  });

  it('says when a milestone is due', () => {
    expect(dueText(18)).toBe('in 18 days');
    expect(dueText(0)).toBe('today');
    expect(dueText(-1)).toBe('1 day overdue');
  });
});
