import type { ViewEntity, ViewLayout } from '../contracts/domain.js';

export const VIEW_ENTITIES: readonly ViewEntity[] = [
  'workstream',
  'issue',
  'decision',
  'project',
];
export const VIEW_LAYOUTS: readonly ViewLayout[] = [
  'list',
  'board',
  'graph',
  'timeline',
];

/** Entities that carry dates, so a timeline (Gantt) layout makes sense for them. */
const TIMELINE_ENTITIES: readonly ViewEntity[] = ['workstream', 'project'];

/** Why `layout` cannot be used with `entity`, or null when the combination is valid. */
export function viewLayoutProblem(
  entity: ViewEntity,
  layout: ViewLayout,
): string | null {
  if (layout === 'timeline' && !TIMELINE_ENTITIES.includes(entity))
    return `The timeline layout is only available for ${TIMELINE_ENTITIES.join(' and ')} views, not ${entity} views`;
  return null;
}
