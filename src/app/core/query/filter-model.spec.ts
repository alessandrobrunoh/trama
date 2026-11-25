import type { Issue, ViewFilter } from '../contracts/domain';
import { FIELD_DEFS } from './fields';
import {
  buildFilter,
  datePresetOf,
  filterFields,
  operatorLabel,
  operatorOf,
  operatorsFor,
  parseFilters,
  resolveDate,
  sameFilters,
  serializeFilters,
  valuesOf,
} from './filter-model';
import { applyFilters, matchesFilter } from './query';

// Wednesday 2026-05-13, midday local time.
const NOW = new Date(2026, 4, 13, 12, 0, 0);

const task = (over: Partial<Issue>): Issue =>
  ({ id: 't', key: 'T-1', title: 't', status: 'todo', labels: [], milestoneIds: [], ...over }) as unknown as Issue;

const matches = (item: Issue, filter: ViewFilter): boolean =>
  matchesFilter('issue', item, filter, { now: NOW });

describe('resolveDate', () => {
  it('reads dates and relative tokens', () => {
    expect(resolveDate('2026-01-05T10:00:00Z', NOW)).toBe('2026-01-05');
    expect(resolveDate('today', NOW)).toBe('2026-05-13');
    expect(resolveDate('yesterday', NOW)).toBe('2026-05-12');
    expect(resolveDate('-7d', NOW)).toBe('2026-05-06');
    expect(resolveDate('+30d', NOW)).toBe('2026-06-12');
    expect(resolveDate('week_start', NOW)).toBe('2026-05-11');
    expect(resolveDate('week_end', NOW)).toBe('2026-05-17');
    expect(resolveDate('month_start', NOW)).toBe('2026-05-01');
    expect(resolveDate('month_end', NOW)).toBe('2026-05-31');
    expect(resolveDate('soon', NOW)).toBeNull();
  });

  it('puts Sunday at the end of its Monday-first week', () => {
    const sunday = new Date(2026, 4, 17, 9, 0, 0);
    expect(resolveDate('week_start', sunday)).toBe('2026-05-11');
    expect(resolveDate('week_end', sunday)).toBe('2026-05-17');
  });
});

describe('operators', () => {
  const def = (field: string) => FIELD_DEFS.issue.find((f) => f.field === field)!;

  it('offers each property its own operators', () => {
    expect(operatorsFor(def('status'), true)).toEqual(['in', 'not_in']);
    expect(operatorsFor(def('labels'), true)).toEqual(['in', 'all', 'not_in', 'set', 'unset']);
    expect(operatorsFor(def('labels'), false)).not.toContain('all');
    expect(operatorsFor(def('dueDate'), true)).toContain('overdue');
    expect(operatorsFor(def('createdAt'), true)).not.toContain('overdue');
    expect(operatorsFor(def('estimate'), true)).toEqual(['eq', 'gte', 'lte', 'set', 'unset']);
  });

  it('keeps task-only properties and dates out of saved views', () => {
    const view = filterFields('issue', false).map((f) => f.field);
    expect(view).not.toContain('dueDate');
    expect(view).not.toContain('createdAt');
    expect(view).not.toContain('thread');
    expect(view).toContain('status');
    const task = filterFields('issue', true).map((f) => f.field);
    expect(task).toEqual(expect.arrayContaining(['dueDate', 'createdAt', 'estimate', 'thread', 'subtasks', 'reporterId']));
    expect(task).not.toContain('title');
  });

  it('maps filters to operators and back', () => {
    expect(operatorOf({ field: 'status', op: 'is', value: 'todo' }, 'enum')).toBe('in');
    expect(operatorOf({ field: 'status', op: 'is_not', value: 'todo' }, 'enum')).toBe('not_in');
    expect(operatorOf({ field: 'assigneeId', op: 'is', value: '' }, 'id')).toBe('unset');
    expect(operatorOf({ field: 'assigneeId', op: 'is_not', value: '' }, 'id')).toBe('set');
    expect(operatorOf({ field: 'estimate', op: 'is', value: '3' }, 'number')).toBe('eq');
    expect(operatorOf({ field: 'labels', op: 'all', value: ['a'] }, 'tags')).toBe('all');
    expect(buildFilter('assigneeId', 'set', ['x'])).toEqual({ field: 'assigneeId', op: 'is_not', value: '' });
    expect(buildFilter('labels', 'all', ['a', 'b'])).toEqual({ field: 'labels', op: 'all', value: ['a', 'b'] });
    expect(buildFilter('dueDate', 'last', ['7'])).toEqual({ field: 'dueDate', op: 'last', value: '7' });
    expect(valuesOf({ field: 'assigneeId', op: 'is_not', value: '' })).toEqual([]);
    expect(valuesOf({ field: 'labels', op: 'in', value: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('words operators by how many values they take', () => {
    expect(operatorLabel('in', 'enum', 1)).toBe('is');
    expect(operatorLabel('in', 'enum', 3)).toBe('is any of');
    expect(operatorLabel('not_in', 'enum', 1)).toBe('is not');
    expect(operatorLabel('not_in', 'enum', 2)).toBe('is none of');
    expect(operatorLabel('in', 'tags', 2)).toBe('includes any of');
    expect(operatorLabel('not_in', 'tags', 2)).toBe('excludes');
    expect(operatorLabel('all', 'tags', 2)).toBe('includes all of');
  });
});

describe('matching', () => {
  it('is / is not / any of / none of', () => {
    const t = task({ status: 'todo', priority: 'high' });
    expect(matches(t, { field: 'status', op: 'in', value: ['todo', 'done'] })).toBe(true);
    expect(matches(t, { field: 'status', op: 'in', value: ['done'] })).toBe(false);
    expect(matches(t, { field: 'status', op: 'not_in', value: ['done', 'canceled'] })).toBe(true);
    expect(matches(t, { field: 'status', op: 'not_in', value: ['todo'] })).toBe(false);
  });

  it('is set / is not set', () => {
    const assigned = task({ assigneeId: 'u1' });
    const loose = task({});
    const isSet: ViewFilter = { field: 'assigneeId', op: 'is_not', value: '' };
    const isNotSet: ViewFilter = { field: 'assigneeId', op: 'is', value: '' };
    expect(matches(assigned, isSet)).toBe(true);
    expect(matches(loose, isSet)).toBe(false);
    expect(matches(assigned, isNotSet)).toBe(false);
    expect(matches(loose, isNotSet)).toBe(true);
  });

  it('labels: includes any / includes all / excludes', () => {
    const t = task({ labels: ['a', 'b'] });
    expect(matches(t, { field: 'labels', op: 'in', value: ['b', 'c'] })).toBe(true);
    expect(matches(t, { field: 'labels', op: 'all', value: ['a', 'b'] })).toBe(true);
    expect(matches(t, { field: 'labels', op: 'all', value: ['a', 'c'] })).toBe(false);
    expect(matches(t, { field: 'labels', op: 'not_in', value: ['c'] })).toBe(true);
    expect(matches(t, { field: 'labels', op: 'not_in', value: ['a'] })).toBe(false);
  });

  it('numbers: is / at least / at most', () => {
    const t = task({ estimate: 5 });
    expect(matches(t, { field: 'estimate', op: 'is', value: '5' })).toBe(true);
    expect(matches(t, { field: 'estimate', op: 'gte', value: '8' })).toBe(false);
    expect(matches(t, { field: 'estimate', op: 'lte', value: '8' })).toBe(true);
    expect(matches(task({ estimate: 0 }), { field: 'estimate', op: 'is_not', value: '' })).toBe(true);
    expect(matches(task({}), { field: 'estimate', op: 'is_not', value: '' })).toBe(false);
  });

  it('derived fields: thread and sub-tasks', () => {
    const linked = task({ id: 'p', threadUrl: 'https://x.dev/t/1' });
    const ctx = { now: NOW, subtaskParents: new Set(['p']) };
    expect(matchesFilter('issue', linked, { field: 'thread', op: 'in', value: ['linked'] }, ctx)).toBe(true);
    expect(matchesFilter('issue', task({}), { field: 'thread', op: 'in', value: ['linked'] }, ctx)).toBe(false);
    expect(matchesFilter('issue', linked, { field: 'subtasks', op: 'in', value: ['yes'] }, ctx)).toBe(true);
    expect(matchesFilter('issue', task({ id: 'q' }), { field: 'subtasks', op: 'in', value: ['yes'] }, ctx)).toBe(false);
  });

  describe('dates', () => {
    const due = (day: string) => task({ dueDate: `${day}T00:00:00.000Z` });

    it('before / after compare calendar days', () => {
      expect(matches(due('2026-05-12'), { field: 'dueDate', op: 'before', value: 'today' })).toBe(true);
      expect(matches(due('2026-05-13'), { field: 'dueDate', op: 'before', value: 'today' })).toBe(false);
      expect(matches(due('2026-05-14'), { field: 'dueDate', op: 'after', value: '2026-05-13' })).toBe(true);
      expect(matches(due('2026-05-13'), { field: 'dueDate', op: 'after', value: '2026-05-13' })).toBe(false);
      expect(matches(task({}), { field: 'dueDate', op: 'before', value: 'today' })).toBe(false);
    });

    it('between is inclusive and takes presets', () => {
      const between: ViewFilter = { field: 'dueDate', op: 'between', value: ['2026-05-10', '2026-05-12'] };
      expect(matches(due('2026-05-10'), between)).toBe(true);
      expect(matches(due('2026-05-12'), between)).toBe(true);
      expect(matches(due('2026-05-13'), between)).toBe(false);
      const thisWeek = buildFilter('dueDate', 'between', ['week_start', 'week_end']);
      expect(datePresetOf(valuesOf(thisWeek))?.label).toBe('This week');
      expect(matches(due('2026-05-11'), thisWeek)).toBe(true);
      expect(matches(due('2026-05-18'), thisWeek)).toBe(false);
      const last7 = buildFilter('dueDate', 'between', ['-7d', 'today']);
      expect(matches(due('2026-05-06'), last7)).toBe(true);
      expect(matches(due('2026-05-05'), last7)).toBe(false);
    });

    it('in the next / last N days', () => {
      const next3: ViewFilter = { field: 'dueDate', op: 'next', value: '3' };
      expect(matches(due('2026-05-13'), next3)).toBe(true);
      expect(matches(due('2026-05-16'), next3)).toBe(true);
      expect(matches(due('2026-05-17'), next3)).toBe(false);
      expect(matches(due('2026-05-12'), next3)).toBe(false);
      const last2: ViewFilter = { field: 'dueDate', op: 'last', value: '2' };
      expect(matches(due('2026-05-11'), last2)).toBe(true);
      expect(matches(due('2026-05-10'), last2)).toBe(false);
      expect(matches(due('2026-05-14'), last2)).toBe(false);
    });

    it('overdue ignores closed tasks', () => {
      const overdue: ViewFilter = { field: 'dueDate', op: 'overdue', value: '' };
      expect(matches(due('2026-05-12'), overdue)).toBe(true);
      expect(matches(due('2026-05-13'), overdue)).toBe(false);
      expect(matches(task({ dueDate: '2026-05-01T00:00:00.000Z', completedAt: '2026-05-02T10:00:00.000Z' }), overdue)).toBe(false);
    });

    it('timestamps count on the local day they fall on', () => {
      const created = task({ createdAt: new Date(2026, 4, 13, 23, 30).toISOString() });
      expect(matches(created, { field: 'createdAt', op: 'between', value: ['today', 'today'] })).toBe(true);
      expect(matches(created, { field: 'createdAt', op: 'before', value: 'today' })).toBe(false);
    });
  });

  it('every filter must match (AND)', () => {
    const list = [
      task({ id: '1', status: 'todo', assigneeId: 'u1' }),
      task({ id: '2', status: 'todo', assigneeId: 'u2' }),
      task({ id: '3', status: 'done', assigneeId: 'u1' }),
    ];
    const filters: ViewFilter[] = [
      { field: 'status', op: 'in', value: ['todo'] },
      { field: 'assigneeId', op: 'in', value: ['u1'] },
    ];
    expect(applyFilters('issue', list, filters, { now: NOW }).map((i) => i.id)).toEqual(['1']);
  });
});

describe('URL', () => {
  const sample: ViewFilter[] = [
    { field: 'status', op: 'in', value: ['todo', 'in_progress'] },
    { field: 'assigneeId', op: 'is_not', value: '' },
    { field: 'dueDate', op: 'between', value: ['-7d', 'today'] },
    { field: 'estimate', op: 'gte', value: '3' },
    { field: 'labels', op: 'all', value: ['a', 'b'] },
  ];

  it('round-trips a filter set', () => {
    const query = serializeFilters(sample);
    expect(query).toEqual([
      'status:in:todo,in_progress',
      'assigneeId:is_not:',
      'dueDate:between:-7d,today',
      'estimate:gte:3',
      'labels:all:a,b',
    ]);
    expect(parseFilters(query, 'issue')).toEqual(sample);
    expect(sameFilters(parseFilters(query, 'issue'), sample)).toBe(true);
  });

  it('escapes separators inside values', () => {
    const odd: ViewFilter[] = [{ field: 'labels', op: 'in', value: ['a,b', 'c:d', '100%'] }];
    const query = serializeFilters(odd);
    expect(query[0]).toBe('labels:in:a%2Cb,c%3Ad,100%25');
    expect(parseFilters(query, 'issue')).toEqual(odd);
  });

  it('reads a single value given as a plain string', () => {
    expect(parseFilters('status:in:done', 'issue')).toEqual([{ field: 'status', op: 'in', value: ['done'] }]);
  });

  it('drops what it cannot trust', () => {
    expect(parseFilters(undefined, 'issue')).toEqual([]);
    expect(
      parseFilters(
        [
          'nonsense',
          'status:wat:todo',
          'secret:in:x',
          'status:in:todo',
          'status:in:done',
          'title:contains:x',
          'dueDate:overdue:',
          'priority:overdue:',
          'labels:all:a',
        ],
        'issue',
      ),
    ).toEqual([
      { field: 'status', op: 'in', value: ['todo'] },
      { field: 'dueDate', op: 'overdue', value: '' },
      { field: 'labels', op: 'all', value: ['a'] },
    ]);
  });

  it('refuses task-only filters when they are not extended', () => {
    expect(parseFilters(['dueDate:overdue:', 'status:in:todo'], 'issue', false)).toEqual([
      { field: 'status', op: 'in', value: ['todo'] },
    ]);
  });
});
