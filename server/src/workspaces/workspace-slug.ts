import { slugify } from '../common/util.js';

/** Slugs that would collide with client routes. */
export const RESERVED_SLUGS = new Set([
  'login',
  'signup',
  'register',
  'blog',
  'roadmap',
  'changelog',
  'compare',
  'why',
  'brand',
  '404',
  'new-workspace',
  'settings',
  'api',
  'admin',
  'auth',
  'workspaces',
  'invite',
  'shared',
  'my-tasks',
]);

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const SLUG_MAX = 40;

/** A valid, non-reserved slug derived from a name. Never longer than {@link SLUG_MAX}. */
export function baseSlug(name: string, fallback = 'workspace'): string {
  const base = slugify(name) || fallback;
  if (!RESERVED_SLUGS.has(base) && base.length >= 3) return base;
  return `${base.slice(0, SLUG_MAX - 3).replace(/-+$/, '')}-ws`;
}

/** `root-2`, `root-3`… trimmed so the result still fits {@link SLUG_MAX}. */
export function slugWithSuffix(root: string, n: number): string {
  const suffix = `-${n}`;
  return `${root.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** First free slug for `name`, given a synchronous "is it taken" check (migrations load every slug up front). */
export function freeSlug(name: string, isTaken: (slug: string) => boolean, fallback = 'workspace'): string {
  const root = baseSlug(name, fallback);
  let slug = root;
  for (let n = 2; isTaken(slug); n++) slug = slugWithSuffix(root, n);
  return slug;
}
