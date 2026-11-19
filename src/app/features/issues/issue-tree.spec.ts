import type { Issue } from '../../core';
import { buildIssueTree } from './issue-tree';

const task = (id: string, parentId?: string): Issue => ({ id, key: id.toUpperCase(), title: id, parentId }) as unknown as Issue;

function setup(list: Issue[]) {
  return new Map(list.map((i) => [i.id, i]));
}

describe('buildIssueTree', () => {
  const all = [task('a'), task('b', 'a'), task('c', 'b'), task('d')];
  const byId = setup(all);
  const everything = new Set(all.map((i) => i.id));

  it('nests children under their parent without a depth limit', () => {
    const { rows, parentIds } = buildIssueTree(all, byId, everything, new Set());
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 0],
    ]);
    expect(parentIds).toEqual(['a', 'b']);
    expect(rows[0].childCount).toBe(1);
  });

  it('hides the children of a collapsed row', () => {
    const { rows } = buildIssueTree(all, byId, everything, new Set(['a']));
    expect(rows.map((r) => r.id)).toEqual(['a', 'd']);
    expect(rows[0].expanded).toBe(false);
  });

  it('shows a filtered-out parent as a dimmed ancestor of a matching child', () => {
    const { rows } = buildIssueTree([all[2]], byId, new Set(['c']), new Set());
    expect(rows.map((r) => [r.id, r.ghost, r.depth])).toEqual([
      ['a', true, 0],
      ['b', true, 1],
      ['c', false, 2],
    ]);
  });

  it('keeps a child flat when its parent matches but is in another group', () => {
    const { rows } = buildIssueTree([all[1]], byId, new Set(['a', 'b']), new Set());
    expect(rows.map((r) => [r.id, r.depth])).toEqual([['b', 0]]);
  });

  it('survives a parent cycle', () => {
    const loop = [task('x', 'y'), task('y', 'x')];
    const { rows } = buildIssueTree(loop, setup(loop), new Set(['x', 'y']), new Set());
    expect(rows.length).toBe(2);
  });
});
