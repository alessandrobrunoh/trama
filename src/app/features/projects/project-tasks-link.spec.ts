import { defaultStatusCatalog } from '../../core';
import { OPEN_STATUS, prefilterOf, resolveStatusParam, tasksQuery } from './project-tasks-link';

const entries = defaultStatusCatalog().issue;

describe('tasksQuery', () => {
  it('opens the Tasks tab unfiltered', () => {
    expect(tasksQuery()).toEqual({ tab: 'tasks', status: null, milestone: null });
  });

  it('joins statuses and carries the milestone', () => {
    expect(tasksQuery({ status: ['in_progress', 'in_review'], milestone: 'm1' })).toEqual({
      tab: 'tasks',
      status: 'in_progress,in_review',
      milestone: 'm1',
    });
  });
});

describe('resolveStatusParam', () => {
  it('expands a type to its status ids', () => {
    expect(resolveStatusParam(entries, 'in_progress')).toContain('in_progress');
  });

  it('open leaves out done and canceled', () => {
    const open = resolveStatusParam(entries, OPEN_STATUS);
    expect(open).toContain('todo');
    expect(open).toContain('in_review');
    expect(open).not.toContain('done');
    expect(open).not.toContain('canceled');
  });

  it('ignores what the catalog does not know', () => {
    expect(resolveStatusParam(entries, 'nope')).toEqual([]);
    expect(resolveStatusParam(entries, undefined)).toEqual([]);
  });
});

describe('prefilterOf', () => {
  it('is the project alone for a plain link', () => {
    expect(prefilterOf('p1', entries, null, null)).toEqual([{ field: 'projectId', op: 'in', value: ['p1'] }]);
  });

  it('adds the status and the milestone', () => {
    const f = prefilterOf('p1', entries, 'done', 'm1');
    expect(f.map((x) => x.field)).toEqual(['projectId', 'status', 'milestoneIds']);
    expect(f[2].value).toEqual(['m1']);
  });
});
