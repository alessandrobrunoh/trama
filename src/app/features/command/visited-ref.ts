// Which record a detail-page URL shows (feeds "recently viewed"). Pure, so it can be unit tested.
export type VisitType = 'issue' | 'workstream' | 'decision' | 'project' | 'repository' | 'team';

/** Detail routes `/:slug/<area>/:ref` that count as a visit. */
const VISIT_AREAS: Record<string, VisitType> = {
  issues: 'issue',
  workstreams: 'workstream',
  decisions: 'decision',
  projects: 'project',
  repositories: 'repository',
  teams: 'team',
};

/** `/acme/issues/BUG-1?x=1` → the record that page shows (also on its tabs), or null for lists and other pages. */
export function visitedRef(url: string): { slug: string; type: VisitType; ref: string } | null {
  const [, slug, area, ref] = url.split(/[?#]/)[0].split('/');
  const type = area ? VISIT_AREAS[area] : undefined;
  if (!slug || !type || !ref) return null;
  return { slug: decodeURIComponent(slug), type, ref: decodeURIComponent(ref) };
}

/** Recently opened items from the palette / search, per workspace (localStorage). */
