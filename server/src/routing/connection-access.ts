import { GIT_PROVIDERS, GIT_PROVIDER_META, connectionHost, type GitProvider } from '../contracts/domain.js';

/**
 * What routing rules need to know about an integration connection row: who owns it, its label and whether
 * it still works. Which connections a person may pick is decided by `ConnectionsService.usableFor`.
 */
export interface RoutingConnection {
  id: string;
  provider: GitProvider;
  account: string;
  baseUrl: string | null;
  host: string;
  /** Null for a personal connection. */
  workspaceId: string | null;
  ownerType: 'workspace' | 'user';
  ownerUserId: string | null;
  label: string;
  /** `connected`, `error` or `revoked`. */
  status: string;
  lastError: string | null;
}

export interface ConnectionCaller {
  workspaceId: string;
  /** Absent for an agent token: it has no personal connections. */
  userId?: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Narrows a connection row (an `IntegrationConnectionEntity`) to the fields routing reads. Null for providers that are not git hosts. */
export function connectionView(row: unknown): RoutingConnection | null {
  const r = row as Record<string, unknown>;
  const provider = r.provider as GitProvider;
  if (!GIT_PROVIDERS.includes(provider)) return null;
  const baseUrl = str(r.baseUrl);
  const account = String(r.account ?? '');
  return {
    id: String(r.id),
    provider,
    account,
    baseUrl,
    host: str(r.host) ?? connectionHost(provider, baseUrl),
    workspaceId: str(r.workspaceId),
    ownerType: r.ownerType === 'user' ? 'user' : 'workspace',
    ownerUserId: str(r.ownerUserId),
    label: str(r.label) ?? `${GIT_PROVIDER_META[provider].label} · ${account}`,
    status: str(r.status) ?? 'connected',
    lastError: str(r.lastError),
  };
}

export const connectionLabel = (c: RoutingConnection): string => c.label;

/** Only `connected` can read. `error` and `revoked` cannot. */
export function connectionHealthy(c: Pick<RoutingConnection, 'status'>): boolean {
  return c.status === 'connected';
}
