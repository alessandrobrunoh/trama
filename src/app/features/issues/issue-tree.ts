// Sub-tasks as a tree inside a list group. Pure functions, used by the task table.
//
// A task nests under its parent when the parent is in the same group. A parent that was filtered out
// (or is outside the view tab) still shows, dimmed, so a matching sub-task keeps its context ("ghost"
// rows). A parent that matches but sits in another group does not pull its children along: they are
// plain rows of their own group.
import type { Issue } from '../../core';

/** Deepest nesting followed when walking up parents (also guards against cycles). */
const MAX_DEPTH = 64;

export interface IssueTreeRow {
  /** The task id (unique inside one group). */
  id: string;
  issue: Issue;
  depth: number;
  /** Shown only as context for a matching descendant: dimmed, not selectable. */
  ghost: boolean;
  /** Direct children shown in this group (before collapsing). */
  childCount: number;
  expanded: boolean;
  /** Id of the row it nests under, null for a top-level row. */
  parentId: string | null;
}

interface Node {
  issue: Issue;
  ghost: boolean;
  parentId: string | null;
  children: Node[];
}

export interface IssueTree {
  /** Visible rows in display order (children of collapsed rows are left out). */
  rows: IssueTreeRow[];
  /** Ids of every row that has children (what "collapse all" collapses). */
  parentIds: string[];
}

/**
 * @param items    the group's tasks in display order (already filtered, searched and sorted)
 * @param byId     every task of the workspace, to find ancestors
 * @param matching ids of every task that passed the filters in any group
 * @param collapsed ids of rows whose children are hidden
 */
export function buildIssueTree(
  items: readonly Issue[],
  byId: ReadonlyMap<string, Issue>,
  matching: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): IssueTree {
  const inGroup = new Set(items.map((i) => i.id));
  const nodes = new Map<string, Node>();
  const roots: Node[] = [];
  const placed = new Set<string>();

  const node = (issue: Issue, ghost: boolean): Node => {
    let n = nodes.get(issue.id);
    if (!n) {
      n = { issue, ghost, parentId: null, children: [] };
      nodes.set(issue.id, n);
    }
    return n;
  };

  /** The parent this task nests under in the group: a member, or a filtered-out ancestor shown as context. */
  const parentFor = (issue: Issue): Issue | null => {
    const parent = issue.parentId ? byId.get(issue.parentId) : undefined;
    if (!parent) return null;
    if (inGroup.has(parent.id)) return parent;
    return matching.has(parent.id) ? null : parent;
  };

  for (const item of items) {
    let cur = node(item, false);
    const climbed = new Set<string>();
    while (!placed.has(cur.issue.id)) {
      placed.add(cur.issue.id);
      climbed.add(cur.issue.id);
      const parent = climbed.size > MAX_DEPTH ? null : parentFor(cur.issue);
      if (!parent || climbed.has(parent.id)) {
        roots.push(cur);
        break;
      }
      const parentNode = node(parent, !inGroup.has(parent.id));
      cur.parentId = parent.id;
      parentNode.children.push(cur);
      cur = parentNode;
    }
  }

  const rows: IssueTreeRow[] = [];
  const parentIds: string[] = [];
  const walk = (n: Node, depth: number): void => {
    const hasChildren = n.children.length > 0;
    const expanded = hasChildren && !collapsed.has(n.issue.id);
    if (hasChildren) parentIds.push(n.issue.id);
    rows.push({
      id: n.issue.id,
      issue: n.issue,
      depth,
      ghost: n.ghost,
      childCount: n.children.length,
      expanded,
      parentId: n.parentId,
    });
    if (expanded) for (const child of n.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return { rows, parentIds };
}

/** A flat list: every task is a top-level row. */
export function flatIssueRows(items: readonly Issue[]): IssueTreeRow[] {
  return items.map((issue) => ({
    id: issue.id,
    issue,
    depth: 0,
    ghost: false,
    childCount: 0,
    expanded: false,
    parentId: null,
  }));
}
