import {
  GIT_PROVIDER_META,
  ROUTING_FILTER_LABELS_MAX,
  ROUTING_FILTER_VALUE_MAX,
  routingSourceKind,
  type GitProvider,
  type RoutingFilters,
} from '../contracts/domain.js';

/** A source path or filter the caller wrote is not usable (→ HTTP 400). */
export class SourceInputError extends Error {}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_DEPTH = 20;

export const defaultHost = (provider: GitProvider): string => GIT_PROVIDER_META[provider].host;

/** The host a connection reaches: its base URL's host, else the provider's public host. */
export function hostOfConnection(provider: GitProvider, baseUrl: string | null | undefined): string {
  if (!baseUrl) return defaultHost(provider);
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return defaultHost(provider);
  }
}

export interface SourceInput {
  /** Set when the input was a URL or an ssh remote. */
  host?: string;
  path: string;
}

/** Splits what a person typed (`owner/name`, a web URL, `git@host:owner/name.git`, `group/*`) into host and path. */
export function parseSourceInput(raw: string): SourceInput {
  let text = raw.trim();
  let host: string | undefined;
  const url = /^https?:\/\/([^/\s]+)\/(.*)$/i.exec(text);
  const ssh = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](.*)$/i.exec(text);
  if (url) {
    host = url[1].toLowerCase();
    text = url[2];
  } else if (ssh) {
    host = ssh[1].toLowerCase();
    text = ssh[2];
  }
  text = text.replace(/[?#].*$/, '').replace(/^\/+/, '');
  text = text.replace(/\/+$/, '').replace(/\.git$/i, '');
  return { host, path: text };
}

/**
 * Validates and normalizes a source path for a provider. The shape depends on the host:
 * GitHub and Bitbucket have `owner/name` (and `owner/*`), GitLab nests groups (`a/b/name`, `a/b/*`).
 */
export function normalizeSourcePath(provider: GitProvider, rawPath: string): string {
  const path = rawPath.trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!path) throw new SourceInputError('Enter a repository such as owner/name');
  const group = path.endsWith('/*');
  const segments = (group ? path.slice(0, -2) : path).split('/');
  if (segments.length > MAX_DEPTH) throw new SourceInputError('That path is too deep');
  for (const segment of segments)
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..')
      throw new SourceInputError(`"${segment}" is not a valid name in a source path`);
  const gitlab = provider === 'gitlab';
  if (group) {
    if (!gitlab && segments.length !== 1)
      throw new SourceInputError(`Use owner/* for everything an owner has on ${GIT_PROVIDER_META[provider].label}`);
  } else if (gitlab ? segments.length < 2 : segments.length !== 2) {
    throw new SourceInputError(
      gitlab ? 'Use group/project, or group/* for a whole group' : 'Use owner/name, or owner/* for everything an owner has',
    );
  }
  return path;
}

const lower = (value: string): string => value.toLowerCase();

/** `acme/` for `acme/*`; the whole path for a repository. Compared case-insensitively. */
function prefixOf(path: string): string {
  return lower(routingSourceKind(path) === 'group' ? path.slice(0, -1) : path);
}

/** Does the source `rulePath` (repo or group) include the repository `fullName`? */
export function sourceIncludes(rulePath: string, fullName: string): boolean {
  const prefix = prefixOf(rulePath);
  const repo = lower(fullName);
  return routingSourceKind(rulePath) === 'group' ? repo.startsWith(prefix) : repo === prefix;
}

/** Could one repository be reached by both sources? Equal repositories, a group and a repository inside it, or nested groups. */
export function sourcesOverlap(a: string, b: string): boolean {
  const ka = routingSourceKind(a);
  const kb = routingSourceKind(b);
  if (ka === 'repo' && kb === 'repo') return lower(a) === lower(b);
  if (ka === 'group' && kb === 'repo') return sourceIncludes(a, b);
  if (ka === 'repo' && kb === 'group') return sourceIncludes(b, a);
  const pa = prefixOf(a);
  const pb = prefixOf(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Validates and cleans filters. Label filters are all-of and case-insensitive. */
export function normalizeFilters(raw: RoutingFilters | null | undefined): RoutingFilters {
  const out: RoutingFilters = {};
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const label of raw?.labels ?? []) {
    const value = String(label).trim();
    if (!value || seen.has(lower(value))) continue;
    if (value.length > ROUTING_FILTER_VALUE_MAX) throw new SourceInputError('A label filter is too long');
    seen.add(lower(value));
    labels.push(value);
  }
  if (labels.length > ROUTING_FILTER_LABELS_MAX) throw new SourceInputError(`At most ${ROUTING_FILTER_LABELS_MAX} label filters`);
  if (labels.length) out.labels = labels;
  const milestone = raw?.milestone?.trim();
  if (milestone) {
    if (milestone.length > ROUTING_FILTER_VALUE_MAX) throw new SourceInputError('The milestone filter is too long');
    out.milestone = milestone;
  }
  return out;
}

/** Canonical text of a filter set: equal filters give equal keys. Empty for no filters. */
export function filterKey(filters: RoutingFilters): string {
  const parts: string[] = [];
  if (filters.labels?.length) parts.push(`l:${filters.labels.map(lower).sort().join(',')}`);
  if (filters.milestone) parts.push(`m:${lower(filters.milestone)}`);
  return parts.join('|');
}

/**
 * Could one item satisfy both filter sets? Label filters are all-of, so two label sets can always be
 * met by one item that carries both; only two different milestones exclude each other.
 */
export function filtersOverlap(a: RoutingFilters, b: RoutingFilters): boolean {
  if (a.milestone && b.milestone && lower(a.milestone) !== lower(b.milestone)) return false;
  return true;
}

export interface ItemAttributes {
  labels: readonly string[];
  milestone?: string | null;
}

/** Does an item pass every filter of a rule? */
export function filtersMatch(filters: RoutingFilters, item: ItemAttributes): boolean {
  if (filters.labels?.length) {
    const has = new Set(item.labels.map(lower));
    if (!filters.labels.every((label) => has.has(lower(label)))) return false;
  }
  if (filters.milestone && lower(item.milestone ?? '') !== lower(filters.milestone)) return false;
  return true;
}

/** Higher wins when two rules both match: a repository beats a group, a deeper group beats a shallower one, more filters beat fewer. */
export function specificity(rule: { sourcePath: string; filters: RoutingFilters }): number {
  const repo = routingSourceKind(rule.sourcePath) === 'repo' ? 100_000 : 0;
  const depth = prefixOf(rule.sourcePath).length * 10;
  const filters = (rule.filters.labels?.length ?? 0) + (rule.filters.milestone ? 1 : 0);
  return repo + depth + filters;
}

export interface RepositoryReference {
  provider: GitProvider;
  host: string;
  path: string;
}

/**
 * Reads the free-text `Project.repository` field (`owner/name`, a web URL or an ssh remote) as a source.
 * Bare `owner/name` is GitHub. Another host counts only when it says which provider it is.
 */
export function parseRepositoryReference(raw: string | null | undefined): RepositoryReference | null {
  if (!raw?.trim()) return null;
  const input = parseSourceInput(raw);
  let provider: GitProvider = 'github';
  let host = defaultHost('github');
  if (input.host) {
    host = input.host;
    if (host === 'github.com' || host === 'www.github.com') host = 'github.com';
    else if (host === 'gitlab.com') provider = 'gitlab';
    else if (host === 'bitbucket.org') provider = 'bitbucket';
    else if (host.startsWith('gitlab.')) provider = 'gitlab';
    else if (host.startsWith('github.')) provider = 'github';
    else return null;
  }
  try {
    const segments = input.path.split('/');
    // Web URLs of a repository can go deeper (/tree/main, /pull/3): GitHub and Bitbucket names are two segments.
    const path = normalizeSourcePath(provider, provider === 'gitlab' ? input.path.replace(/\/-\/.*$/, '') : segments.slice(0, 2).join('/'));
    return { provider, host, path };
  } catch {
    return null;
  }
}
