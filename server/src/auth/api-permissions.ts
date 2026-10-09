import { API_PERMISSIONS, API_RESOURCES } from '../contracts/domain.js';
import type { ApiAction, ApiPermission, ApiResource } from '../contracts/domain.js';

const KNOWN = new Set<string>(API_PERMISSIONS);

/** Routes under `/w/:slug/<segment>` whose segment is not the resource name. */
const SEGMENT_RESOURCE: Record<string, ApiResource> = {
  settings: 'workspace',
  labels: 'workspace',
  'customer-tiers': 'workspace',
  'customer-requests': 'customers',
  // the triage inbox is customer work; the sources behind it are integrations (admin)
  'customer-intake': 'customers',
  'intake-sources': 'integrations',
};

/**
 * Sub-resources mounted under another resource (`/w/:slug/<parent>/:id/<sub>`) that carry their own
 * permission instead of the parent's: `issues/:id/artifacts` needs `artifacts:*`, not `issues:*`.
 */
const NESTED_RESOURCE: Record<string, ApiResource> = {
  artifacts: 'artifacts',
};

/**
 * Nested segments that are also catalog resources but stay under the parent's permission (the
 * workstream graph). Any other nested segment naming a catalog resource is a sub-resource nobody
 * mapped yet and is refused for custom tokens, so it cannot silently fall under the parent's permission.
 */
const PARENT_OWNED = new Set<string>(['graph']);

/** `POST …/<verb>` routes that need a more specific permission than a plain write. */
const ACTION_OVERRIDES: Record<string, Partial<Record<string, ApiPermission>>> = {
  decisions: { accept: 'decisions:accept', reject: 'decisions:accept', supersede: 'decisions:accept' },
  issues: { 'bulk-delete': 'issues:delete' },
};

function actionFor(method: string): ApiAction {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'delete';
  return 'write';
}

/**
 * The permission a request needs, derived from the matched route pattern (e.g.
 * `/api/w/:slug/issues/:idOrKey`) and the HTTP method. `null` = the route is outside the permission
 * catalog (not workspace-scoped, an unknown resource, or an action the resource does not offer):
 * `custom` tokens are denied there, so new controllers fail closed until they are added to
 * `API_RESOURCES`.
 */
export function requiredPermission(method: string, routePath: string): ApiPermission | null {
  const m = /\/w\/:slug(?:\/([^/]+))?(.*)$/.exec(routePath);
  if (!m) return null;
  const segment = m[1];
  const resource = (segment === undefined ? 'workspace' : (SEGMENT_RESOURCE[segment] ?? segment)) as ApiResource;
  if (!(resource in API_RESOURCES)) return null;
  // `/<segment>/:id/<sub>[/…]`: the sub-segment may switch the permission to its own resource.
  const nested = /^\/:[^/]+\/([^/]+)/.exec(m[2])?.[1];
  let target = resource;
  if (nested !== undefined) {
    if (Object.hasOwn(NESTED_RESOURCE, nested)) target = NESTED_RESOURCE[nested];
    else if (Object.hasOwn(API_RESOURCES, nested) && !PARENT_OWNED.has(nested)) return null;
  }
  const last = routePath.split('/').pop() ?? '';
  const override = method === 'POST' ? ACTION_OVERRIDES[target]?.[last] : undefined;
  const permission = override ?? (`${target}:${actionFor(method)}` as ApiPermission);
  return KNOWN.has(permission) ? permission : null;
}

/** Drops unknown entries, de-duplicates, and makes every write/delete/accept imply `read`. */
export function normalizePermissions(input: readonly string[]): ApiPermission[] {
  const out = new Set<ApiPermission>();
  for (const p of input) {
    if (!KNOWN.has(p)) continue;
    out.add(p as ApiPermission);
    out.add(`${p.split(':')[0]}:read` as ApiPermission);
  }
  return API_PERMISSIONS.filter((p) => out.has(p));
}
