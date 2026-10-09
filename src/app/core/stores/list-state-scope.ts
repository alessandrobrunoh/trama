// Pure helpers of ListStateStore (no Angular, so they can be unit-tested).

/** The workspace slug a router URL points into (`/acme/issues?x=1` → `acme`), or null for `/`. */
export function workspaceSlugOf(url: string): string | null {
  const [path] = url.split(/[?#]/);
  const first = path.split('/').find(Boolean);
  if (!first) return null;
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
}

/** Storage key of a remembered value: each workspace has its own copy of every key. */
export const scopedKey = (slug: string | null | undefined, key: string): string => `${slug ?? ''}::${key}`;
