// Pure helpers of the Project · Sources tab: filter terms, wording for a rule's state and what a source
// path looks like. Nothing here touches the store or the DOM.
import {
  ROUTING_FILTER_LABELS_MAX,
  ROUTING_FILTER_VALUE_MAX,
  ROUTING_PROVIDER_SUPPORT,
  type GitProvider,
  type RoutingFilters,
  type RoutingRule,
  type RoutingRuleConnection,
  type RoutingSuggestionStatus,
} from '../../../core/contracts/domain';

export interface FilterTerm {
  kind: 'label' | 'milestone';
  value: string;
}

/**
 * One filter as people type it: `label = frontend`, `milestone = v1.2`, or a bare word (a label).
 * `null` for an empty or unusable term.
 */
export function parseFilterTerm(text: string): FilterTerm | null {
  const match = /^\s*(?:(label|milestone)\s*[=:]\s*)?(.*?)\s*$/i.exec(text);
  const value = (match?.[2] ?? '').replace(/^["']|["']$/g, '').trim();
  if (!value || value.length > ROUTING_FILTER_VALUE_MAX) return null;
  return { kind: match?.[1]?.toLowerCase() === 'milestone' ? 'milestone' : 'label', value };
}

/** The filters with the term added. A label already present (any case) is not added twice; a milestone replaces. */
export function addFilterTerm(filters: RoutingFilters, term: FilterTerm): RoutingFilters {
  if (term.kind === 'milestone') return { ...filters, milestone: term.value };
  const labels = filters.labels ?? [];
  if (labels.some((l) => l.toLowerCase() === term.value.toLowerCase())) return filters;
  if (labels.length >= ROUTING_FILTER_LABELS_MAX) return filters;
  return { ...filters, labels: [...labels, term.value] };
}

export function removeFilterTerm(filters: RoutingFilters, term: FilterTerm): RoutingFilters {
  const next: RoutingFilters = { ...filters };
  if (term.kind === 'milestone') {
    delete next.milestone;
    return next;
  }
  const labels = (filters.labels ?? []).filter((l) => l !== term.value);
  if (labels.length) next.labels = labels;
  else delete next.labels;
  return next;
}

export function filterTerms(filters: RoutingFilters | undefined | null): FilterTerm[] {
  return [
    ...(filters?.labels ?? []).map((value): FilterTerm => ({ kind: 'label', value })),
    ...(filters?.milestone ? [{ kind: 'milestone', value: filters.milestone } as FilterTerm] : []),
  ];
}

export function filterText(term: FilterTerm): string {
  return `${term.kind} = ${term.value}`;
}

/** What marks the connection next to a source: "workspace", or "personal · Name" for someone's own. */
export function connectionTag(c: Pick<RoutingRuleConnection, 'ownerType' | 'ownerName'> | undefined): string {
  if (!c) return '';
  if (c.ownerType === 'workspace') return 'workspace';
  return c.ownerName ? `personal · ${c.ownerName}` : 'personal';
}

export function supportsTwoWay(provider: GitProvider): boolean {
  return ROUTING_PROVIDER_SUPPORT[provider]?.twoWay === true;
}

/** Providers a source can be added for, in the order of the picker. */
export function sourceProviders(): GitProvider[] {
  return (Object.keys(ROUTING_PROVIDER_SUPPORT) as GitProvider[]).filter(
    (p) => ROUTING_PROVIDER_SUPPORT[p].issues || ROUTING_PROVIDER_SUPPORT[p].pullRequests,
  );
}

/** The line under a healthy rule: "1h ago · 14 tasks"; before the first arrival, "no tasks yet". */
export function ruleActivity(rule: Pick<RoutingRule, 'lastSyncAt' | 'taskCount'>, ago: (iso: string) => string): string {
  const tasks = `${rule.taskCount} ${rule.taskCount === 1 ? 'task' : 'tasks'}`;
  return rule.lastSyncAt ? `${ago(rule.lastSyncAt)} · ${tasks}` : rule.taskCount ? tasks : 'no tasks yet';
}

/** The line under an error badge: when it last worked. */
export function ruleErrorSince(rule: Pick<RoutingRule, 'lastSyncAt'>, ago: (iso: string) => string): string {
  return rule.lastSyncAt ? `last sync ${ago(rule.lastSyncAt)}` : 'never synced';
}

/** The caption of a suggestion in the source picker. */
export function suggestionNote(status: RoutingSuggestionStatus, projectName?: string): string {
  if (status === 'this_project') return '→ this project';
  if (status === 'other_project') return `→ ${projectName ?? 'another project'} already`;
  return 'available';
}

/** Whether a suggestion may be picked: a source that already goes somewhere cannot be added again. */
export function suggestionPickable(status: RoutingSuggestionStatus): boolean {
  return status === 'available';
}

/** Where to fix a connection: personal ones are the person's own settings, the workspace's are shared. */
export function reconnectSection(c: Pick<RoutingRuleConnection, 'ownerType'> | undefined): 'my-integrations' | 'integrations' {
  return c?.ownerType === 'user' ? 'my-integrations' : 'integrations';
}
