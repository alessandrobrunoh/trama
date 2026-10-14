import {
  PRIORITIES,
  PRIORITY_META,
  PROVIDERS,
  PROVIDER_META,
  type Issue,
  type TramaStore,
} from '../core';
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

export const teamOptions = (store: TramaStore): PickOption[] =>
  store.teams().map((team) => ({
    value: team.id,
    label: team.name,
    kind: 'team',
    hint: team.key,
  }));

export const userOptions = (store: TramaStore): PickOption[] =>
  store.users().map((user) => ({
    value: user.id,
    label: user.name,
    kind: 'user',
    search: `${user.name} ${user.email}`,
  }));

export const repoOptions = (store: TramaStore): PickOption[] =>
  store.repositories().map((repository) => ({
    value: repository.id,
    label: repository.fullName,
    kind: 'repo',
    provider: repository.provider,
  }));

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
