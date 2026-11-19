import {
  buildRows,
  buildSubtree,
  childrenByParent,
  expandableIds,
  percent,
  visibleNodes,
  type SubtreeRow,
  type TreeTask,
} from './task-subtree-model';

interface T extends TreeTask {
  done?: boolean;
}

const tasks: T[] = [
  { id: 'a' },
  { id: 'a1', parentId: 'a', done: true },
  { id: 'a2', parentId: 'a' },
  { id: 'a2x', parentId: 'a2', done: true },
  { id: 'a2y', parentId: 'a2' },
  { id: 'a2y1', parentId: 'a2y', done: true },
  { id: 'b' },
  { id: 'b1', parentId: 'b' },
];
const closed = (t: T) => !!t.done;

describe('buildSubtree', () => {
  const tree = buildSubtree('a', childrenByParent(tasks), closed);

  it('nests to any depth and counts the whole subtree', () => {
    expect(tree.roots.map((n) => n.task.id)).toEqual(['a1', 'a2']);
    expect(tree.total).toBe(5);
    expect(tree.done).toBe(3);
    const a2 = tree.byId.get('a2')!;
    expect(a2.depth).toBe(0);
    expect(a2.descendants).toBe(3);
    expect(a2.descendantsDone).toBe(2);
    expect(tree.byId.get('a2y1')!.depth).toBe(2);
  });

  it('does not include tasks of other trees', () => {
    expect(tree.byId.has('b1')).toBe(false);
  });

  it('is empty for a task without children', () => {
    const empty = buildSubtree('b1', childrenByParent(tasks), closed);
    expect(empty.roots).toEqual([]);
    expect(empty.total).toBe(0);
  });

  it('cuts a cycle instead of looping', () => {
    const loop: T[] = [
      { id: 'x', parentId: 'z' },
      { id: 'y', parentId: 'x' },
      { id: 'z', parentId: 'y' },
    ];
    const t = buildSubtree('x', childrenByParent(loop), closed);
    expect(t.total).toBe(2);
  });
});

describe('visibleNodes', () => {
  const tree = buildSubtree('a', childrenByParent(tasks), closed);

  it('shows everything when nothing is collapsed', () => {
    expect(visibleNodes(tree.roots, new Set()).map((n) => n.task.id)).toEqual(['a1', 'a2', 'a2x', 'a2y', 'a2y1']);
  });

  it('hides what is below a collapsed task', () => {
    expect(visibleNodes(tree.roots, new Set(['a2'])).map((n) => n.task.id)).toEqual(['a1', 'a2']);
    expect(visibleNodes(tree.roots, new Set(['a2y'])).map((n) => n.task.id)).toEqual(['a1', 'a2', 'a2x', 'a2y']);
  });

  it('lists the tasks that can be collapsed', () => {
    expect(expandableIds(tree).sort()).toEqual(['a2', 'a2y']);
  });
});

describe('buildRows', () => {
  const tree = buildSubtree('a', childrenByParent(tasks), closed);
  const ids = (rows: SubtreeRow<T>[]) =>
    rows.map((r) => (r.kind === 'node' ? r.node.task.id : `+${r.parentId}@${r.depth}`));

  it('is the visible rows when nobody is adding', () => {
    expect(ids(buildRows('a', tree.roots, new Set(), null))).toEqual(['a1', 'a2', 'a2x', 'a2y', 'a2y1']);
  });

  it('puts the input after the last child of the task being added to', () => {
    expect(ids(buildRows('a', tree.roots, new Set(), 'a2'))).toEqual(['a1', 'a2', 'a2x', 'a2y', 'a2y1', '+a2@1']);
    expect(ids(buildRows('a', tree.roots, new Set(), 'a2y'))).toEqual(['a1', 'a2', 'a2x', 'a2y', 'a2y1', '+a2y@2']);
    expect(ids(buildRows('a', tree.roots, new Set(), 'a1'))).toEqual(['a1', '+a1@1', 'a2', 'a2x', 'a2y', 'a2y1']);
  });

  it('puts the top-level input at the end', () => {
    expect(ids(buildRows('a', tree.roots, new Set(), 'a'))).toEqual(['a1', 'a2', 'a2x', 'a2y', 'a2y1', '+a@0']);
  });

  it('skips the input of a collapsed task', () => {
    expect(ids(buildRows('a', tree.roots, new Set(['a2']), 'a2'))).toEqual(['a1', 'a2']);
  });
});

describe('percent', () => {
  it('rounds down and never reads 100 before the end', () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(2, 3)).toBe(66);
    expect(percent(3, 3)).toBe(100);
  });
});
