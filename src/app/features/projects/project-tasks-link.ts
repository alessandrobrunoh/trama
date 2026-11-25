// Links from the project page into its Tasks tab, already filtered: `?tab=tasks&status=…&milestone=…`.
// The page reads these params once, writes them into the filters the Tasks tab remembers (the same
// `ListStateStore` cells the issue board reads) and drops them from the URL, so the link can be
// clicked again after the reader changed the filters by hand.
import type { Params } from '@angular/router';
import {
  statusIdsForTypes,
  type IssueStatus,
  type ListStateStore,
  type StatusEntry,
  type ViewFilter,
} from '../../core';

/** `status=open`: every status that is not done or canceled. */
export const OPEN_STATUS = 'open';

/** Where the Tasks tab of a project keeps its filters, search and thread chip. */
export const projectTasksStateKey = (projectId: string): string => `project-tasks.${projectId}`;

export interface TasksFilterSpec {
  /** Status types (`in_progress`), status ids or `open`. */
  status?: readonly string[];
  milestone?: string | null;
}

/** Query params for the project route that open the Tasks tab with the given filter. */
export function tasksQuery(spec: TasksFilterSpec = {}): Params {
  return {
    tab: 'tasks',
    status: spec.status?.length ? spec.status.join(',') : null,
    milestone: spec.milestone ?? null,
  };
}

/** Status ids a `status` param names: a type expands to every status of it, an id stays itself. */
export function resolveStatusParam(
  entries: readonly StatusEntry<IssueStatus>[],
  param: string | null | undefined,
): string[] {
  const out = new Set<string>();
  for (const token of (param ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    if (token === OPEN_STATUS) {
      const open = entries.filter((e) => e.type !== 'done' && e.type !== 'canceled').map((e) => e.type);
      for (const id of statusIdsForTypes(entries, open)) out.add(id);
    } else if (entries.some((e) => e.type === token)) {
      for (const id of statusIdsForTypes(entries, [token as IssueStatus])) out.add(id);
    } else if (entries.some((e) => e.id === token)) {
      out.add(token);
    }
  }
  return [...out];
}

/** The filters the Tasks tab starts from for a link: this project, plus the status and milestone asked for. */
export function prefilterOf(
  projectId: string,
  entries: readonly StatusEntry<IssueStatus>[],
  status: string | null | undefined,
  milestone: string | null | undefined,
): ViewFilter[] {
  const filters: ViewFilter[] = [{ field: 'projectId', op: 'in', value: [projectId] }];
  const ids = resolveStatusParam(entries, status);
  if (ids.length) filters.push({ field: 'status', op: 'in', value: ids });
  if (milestone) filters.push({ field: 'milestoneIds', op: 'in', value: [milestone] });
  return filters;
}

/** Replace what the project's Tasks tab shows by the link's filters (search and thread chip cleared). */
export function applyTasksPrefilter(list: ListStateStore, projectId: string, filters: ViewFilter[]): void {
  const key = projectTasksStateKey(projectId);
  list.remember<ViewFilter[]>(`${key}.filters`, []).set(filters);
  list.remember<string>(`${key}.search`, '').set('');
  list.remember<string>(`${key}.thread`, '').set('');
}
