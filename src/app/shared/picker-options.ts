import {
  PRIORITIES,
  PRIORITY_META,
  PROVIDERS,
  PROVIDER_META,
  type Issue,
  type TramaStore,
} from '../core';
import { isClosedIssue } from '../features/issues/issue-model';
import type { PickOption } from './picker';

/** Issues as picker options (circle status glyph, key as hint). */
export const issueOptions = (issues: readonly Issue[]): PickOption[] =>
  issues.map((issue) => ({
    value: issue.id,
    label: issue.title,
    kind: 'status',
    status: issue.status,
    statusEntity: 'issue',
    hint: issue.key,
    search: `${issue.key} ${issue.title}`,
  }));

export const priorityOptions = (): PickOption[] =>
  PRIORITIES.map((priority) => ({
    value: priority,
    label: PRIORITY_META[priority].label,
    kind: 'priority',
  }));

export const providerOptions = (): PickOption[] =>
  PROVIDERS.map((provider) => ({
    value: provider,
    label: PROVIDER_META[provider].label,
    kind: 'provider',
  }));

/** People as picker options, each with its open-task count ("3 open", v3 · 17). */
export const userOptions = (store: TramaStore): PickOption[] => {
  const entries = store.settings().statuses.issue;
  const open = new Map<string, number>();
  for (const issue of store.issues()) {
    if (issue.assigneeId && !isClosedIssue(issue, entries)) {
      open.set(issue.assigneeId, (open.get(issue.assigneeId) ?? 0) + 1);
    }
  }
  return store.users().map((user) => ({
    value: user.id,
    label: user.name,
    kind: 'user',
    hint: `${open.get(user.id) ?? 0} open`,
    search: `${user.name} ${user.email}`,
  }));
};

/** Open projects (plus `currentId` even when closed), for the Project picker. */
export const projectOptions = (store: TramaStore, currentId?: string | null): PickOption[] =>
  store
    .projects()
    .filter((project) =>
      (project.status !== 'completed' && project.status !== 'canceled') || project.id === currentId,
    )
    .map((project) => ({ value: project.id, label: project.name, kind: 'project' }));

/** Projects as filter options ("No project" first), including closed projects. */
export function projectFilterOptions(store: TramaStore): PickOption[] {
  return [
    { value: '', label: 'No project' },
    ...store
      .projects()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ value: project.id, label: project.name, kind: 'project' as const })),
  ];
}
