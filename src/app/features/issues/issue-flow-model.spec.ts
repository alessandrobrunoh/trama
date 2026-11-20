import type { DomainEvent, Issue } from '../../core';
import {
  DAY_MS,
  buildTrack,
  columnIndex,
  flowLength,
  formatSpan,
  idleLabel,
  layoutStays,
  linkSegments,
  type FlowColumn,
  type FlowGeometry,
} from './issue-flow-model';

const COLUMNS: FlowColumn[] = [
  { id: 'backlog', type: 'backlog' },
  { id: 'todo', type: 'todo' },
  { id: 'doing', type: 'in_progress' },
  { id: 'review', type: 'in_review' },
  { id: 'done', type: 'done' },
  { id: 'canceled', type: 'canceled' },
];
const GEO: FlowGeometry = { colWidth: 100, pad: 4, minLen: 8 };
const NOW = Date.parse('2026-03-31T12:00:00Z');
const ago = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();

function issue(status: string, extra: Partial<Issue> = {}): Issue {
  return { id: 'i1', key: 'T-1', status, createdAt: ago(30), updatedAt: ago(1), ...extra } as unknown as Issue;
}

function change(from: string | undefined, to: string, days: number): DomainEvent {
  return {
    id: `e-${to}-${days}`,
    workspaceId: 'w',
    at: ago(days),
    actor: { type: 'user', id: 'u1' },
    type: 'issue.status_changed',
    subject: { type: 'issue', id: 'i1' },
    data: from ? { from, to } : { to },
  } as DomainEvent;
}

describe('columnIndex', () => {
  it('finds a catalog id, then falls back to the semantic type', () => {
    expect(columnIndex(COLUMNS, 'review')).toBe(3);
    expect(columnIndex(COLUMNS, 'in_progress')).toBe(2);
    expect(columnIndex(COLUMNS, 'nope')).toBe(-1);
    expect(columnIndex(COLUMNS, undefined)).toBe(-1);
  });
});

describe('buildTrack from history', () => {
  it('draws one stay per status with its time, ending at now for the current one', () => {
    const events = [change('todo', 'doing', 20), change('doing', 'review', 10)];
    const track = buildTrack(issue('review'), events, COLUMNS, NOW);
    expect(track.fromHistory).toBe(true);
    expect(track.stays.map((s) => s.column)).toEqual([1, 2, 3]);
    expect(track.stays.map((s) => Math.round(s.durationMs / DAY_MS))).toEqual([10, 10, 10]);
    expect(track.stays[2].leftAt).toBeNull();
    expect(track.closed).toBeNull();
  });

  it('orders events by time whatever order they come in', () => {
    const events = [change('doing', 'review', 5), change('todo', 'doing', 15)];
    const track = buildTrack(issue('review'), events, COLUMNS, NOW);
    expect(track.stays.map((s) => s.column)).toEqual([1, 2, 3]);
  });

  it('ends a finished task with a terminal stay that has no duration', () => {
    const events = [change('todo', 'doing', 20), change('doing', 'done', 4)];
    const track = buildTrack(issue('done', { completedAt: ago(4) }), events, COLUMNS, NOW);
    expect(track.closed).toBe('done');
    const last = track.stays[track.stays.length - 1];
    expect(last.terminal).toBe(true);
    expect(last.durationMs).toBe(0);
    expect(track.idle).toBe(false);
  });

  it('puts a task that came back to a status on a second lane', () => {
    const events = [change('todo', 'doing', 20), change('doing', 'review', 14), change('review', 'doing', 8)];
    const track = buildTrack(issue('doing'), events, COLUMNS, NOW);
    expect(track.stays.map((s) => [s.column, s.lane])).toEqual([[1, 0], [2, 0], [3, 0], [2, 1]]);
    const links = linkSegments(layoutStays(track.stays, GEO));
    expect(links.map((l) => l.backward)).toEqual([false, false, true]);
  });

  it('merges consecutive changes into the same status', () => {
    const events = [change('todo', 'doing', 20), change('doing', 'doing', 10)];
    expect(buildTrack(issue('doing'), events, COLUMNS, NOW).stays).toHaveLength(2);
  });

  it('ends on the real status when the history stops early', () => {
    const events = [change('todo', 'doing', 20)];
    const track = buildTrack(issue('review', { updatedAt: ago(3) }), events, COLUMNS, NOW);
    expect(track.stays.map((s) => s.column)).toEqual([1, 2, 3]);
    expect(Math.round(track.stays[2].durationMs / DAY_MS)).toBe(3);
  });
});

describe('buildTrack without history', () => {
  it('rebuilds created, started and now from the task dates', () => {
    const track = buildTrack(issue('review', { startedAt: ago(12), updatedAt: ago(2) }), [], COLUMNS, NOW);
    expect(track.fromHistory).toBe(false);
    expect(track.stays.map((s) => s.column)).toEqual([0, 2, 3]);
  });

  it('uses completedAt for a finished task', () => {
    const track = buildTrack(issue('done', { startedAt: ago(20), completedAt: ago(5) }), [], COLUMNS, NOW);
    expect(track.stays.map((s) => s.column)).toEqual([0, 2, 4]);
    expect(track.stays[2].enteredAt).toBe(NOW - 5 * DAY_MS);
    expect(track.closed).toBe('done');
  });

  it('keeps a task that never moved in its status for its whole life', () => {
    const track = buildTrack(issue('todo'), [], COLUMNS, NOW);
    expect(track.stays).toHaveLength(1);
    expect(track.stays[0].column).toBe(1);
    expect(Math.round(track.stays[0].durationMs / DAY_MS)).toBe(30);
  });

  it('returns no stays for a status that is not in the catalog', () => {
    expect(buildTrack(issue('mystery'), [], COLUMNS, NOW).stays).toEqual([]);
  });
});

describe('idle detection', () => {
  it('flags an open task 7 days or more in its status', () => {
    const events = [change('todo', 'doing', 9)];
    const track = buildTrack(issue('doing'), events, COLUMNS, NOW);
    expect(track.idle).toBe(true);
    expect(idleLabel(track)).toBe('idle 9d');
  });

  it('does not flag a recent stay, a backlog task or a finished one', () => {
    expect(buildTrack(issue('doing'), [change('todo', 'doing', 3)], COLUMNS, NOW).idle).toBe(false);
    expect(buildTrack(issue('backlog', { createdAt: ago(60) }), [], COLUMNS, NOW).idle).toBe(false);
    expect(buildTrack(issue('done', { completedAt: ago(40) }), [change('doing', 'done', 40)], COLUMNS, NOW).idle).toBe(false);
  });

  it('honours the threshold argument', () => {
    const events = [change('todo', 'doing', 3)];
    expect(buildTrack(issue('doing'), events, COLUMNS, NOW, 2).idle).toBe(true);
  });
});

describe('flowLength', () => {
  it('keeps short stays visible and caps long ones at the column', () => {
    expect(flowLength(0, GEO)).toBe(8);
    expect(flowLength(2 * 3_600_000, GEO)).toBeGreaterThanOrEqual(8);
    expect(flowLength(365 * DAY_MS, GEO)).toBe(92);
  });

  it('grows faster at first than later (square root)', () => {
    const day = flowLength(DAY_MS, GEO) - flowLength(0, GEO);
    const lateDay = flowLength(21 * DAY_MS, GEO) - flowLength(20 * DAY_MS, GEO);
    expect(day).toBeGreaterThan(lateDay * 3);
    expect(flowLength(3 * DAY_MS, GEO)).toBeLessThan(flowLength(10 * DAY_MS, GEO));
  });
});

describe('layoutStays and linkSegments', () => {
  it('places segments in their column and joins them in order', () => {
    const track = buildTrack(issue('review'), [change('todo', 'doing', 20), change('doing', 'review', 10)], COLUMNS, NOW);
    const segments = layoutStays(track.stays, GEO);
    expect(segments.map((s) => s.x)).toEqual([104, 204, 304]);
    const links = linkSegments(segments);
    expect(links).toHaveLength(2);
    expect(links[0].from).toBe(segments[0].x + segments[0].width);
    expect(links[0].to).toBe(204);
    expect(links.every((l) => !l.backward)).toBe(true);
  });
});

describe('formatSpan', () => {
  it('speaks in hours, days and months', () => {
    expect(formatSpan(10 * 60_000)).toBe('<1h');
    expect(formatSpan(5 * 3_600_000)).toBe('5h');
    expect(formatSpan(9 * DAY_MS)).toBe('9d');
    expect(formatSpan(120 * DAY_MS)).toBe('4mo');
  });
});
