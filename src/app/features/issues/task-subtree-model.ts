// Pure model of a task's subtask tree: the children of any task are the tasks whose `parentId` is its id, to any
// depth. The tree is built once from the store's flat list (no request per level), with the roll-up numbers each
// row shows (child count, progress of its whole subtree) and the flattened list of visible rows for a given set of
// collapsed tasks. No Angular here, so it is cheap to test.

export interface TreeTask {
  id: string;
  parentId?: string;
}

export interface SubtreeNode<T extends TreeTask> {
  task: T;
  /** 0 for the direct children of the root. */
  depth: number;
  children: SubtreeNode<T>[];
  /** Tasks below this one, at any depth. */
  descendants: number;
  /** Finished tasks (done or canceled) among the descendants. */
  descendantsDone: number;
}

export interface Subtree<T extends TreeTask> {
  roots: SubtreeNode<T>[];
  /** Every node by task id, for lookups from a row. */
  byId: Map<string, SubtreeNode<T>>;
  /** Tasks under the root at any depth. */
  total: number;
  /** Finished ones among them. */
  done: number;
}

/** Groups tasks by parent, keeping the input order inside each group. */
export function childrenByParent<T extends TreeTask>(tasks: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const list = map.get(t.parentId);
    if (list) list.push(t);
    else map.set(t.parentId, [t]);
  }
  return map;
}

/**
 * The tree below `rootId`. `isClosed` says whether a task counts as finished. A cycle in the data (a task that
 * is its own ancestor) is cut where it would repeat, so the walk always ends.
 */
export function buildSubtree<T extends TreeTask>(
  rootId: string,
  byParent: ReadonlyMap<string, readonly T[]>,
  isClosed: (task: T) => boolean,
): Subtree<T> {
  const byId = new Map<string, SubtreeNode<T>>();
  const seen = new Set<string>([rootId]);

  const walk = (parentId: string, depth: number): SubtreeNode<T>[] => {
    const out: SubtreeNode<T>[] = [];
    for (const task of byParent.get(parentId) ?? []) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      const node: SubtreeNode<T> = { task, depth, children: [], descendants: 0, descendantsDone: 0 };
      byId.set(task.id, node);
      node.children = walk(task.id, depth + 1);
      for (const child of node.children) {
        node.descendants += 1 + child.descendants;
        node.descendantsDone += (isClosed(child.task) ? 1 : 0) + child.descendantsDone;
      }
      out.push(node);
    }
    return out;
  };

  const roots = walk(rootId, 0);
  let total = 0;
  let done = 0;
  for (const r of roots) {
    total += 1 + r.descendants;
    done += (isClosed(r.task) ? 1 : 0) + r.descendantsDone;
  }
  return { roots, byId, total, done };
}

/** The rows to draw, in order: a collapsed task hides everything below it. */
export function visibleNodes<T extends TreeTask>(
  roots: readonly SubtreeNode<T>[],
  collapsed: ReadonlySet<string>,
): SubtreeNode<T>[] {
  const out: SubtreeNode<T>[] = [];
  const walk = (nodes: readonly SubtreeNode<T>[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length && !collapsed.has(n.task.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export type SubtreeRow<T extends TreeTask> =
  | { kind: 'node'; node: SubtreeNode<T> }
  /** The inline "new subtask" input under `parentId` (the tree's root id for the top level). */
  | { kind: 'add'; parentId: string; depth: number };

/**
 * The visible rows plus, when `addingTo` is set, the new-subtask input as the last row of that task's children
 * (a collapsed task with children does not show it: the caller expands it first).
 */
export function buildRows<T extends TreeTask>(
  rootId: string,
  roots: readonly SubtreeNode<T>[],
  collapsed: ReadonlySet<string>,
  addingTo: string | null,
): SubtreeRow<T>[] {
  const rows: SubtreeRow<T>[] = [];
  const walk = (nodes: readonly SubtreeNode<T>[]): void => {
    for (const node of nodes) {
      rows.push({ kind: 'node', node });
      const open = !collapsed.has(node.task.id);
      if (node.children.length && open) walk(node.children);
      if (addingTo === node.task.id && (open || !node.children.length)) {
        rows.push({ kind: 'add', parentId: node.task.id, depth: node.depth + 1 });
      }
    }
  };
  walk(roots);
  if (addingTo === rootId) rows.push({ kind: 'add', parentId: rootId, depth: 0 });
  return rows;
}

/** Ids of every task that has children (what "collapse all" collapses). */
export function expandableIds<T extends TreeTask>(subtree: Subtree<T>): string[] {
  const ids: string[] = [];
  for (const [id, node] of subtree.byId) if (node.children.length) ids.push(id);
  return ids;
}

/** 0-100, rounded down so a tree that is not finished never reads 100. */
export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}
