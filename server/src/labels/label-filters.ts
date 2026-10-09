import type { ViewFilter } from '../contracts/domain.js';
import { replaceLabelId } from '../contracts/domain.js';

/**
 * Saved-view filters after label `from` is merged into `into`, or removed when `into` is null.
 * Only `labels` filters change; a filter left with no value is dropped. Returns null when nothing changed.
 */
export function rewriteLabelFilters(filters: readonly ViewFilter[] | null | undefined, from: string, into: string | null): ViewFilter[] | null {
  const list = filters ?? [];
  const touches = (filter: ViewFilter) =>
    filter.field === 'labels' && (Array.isArray(filter.value) ? filter.value.includes(from) : filter.value === from);
  if (!list.some(touches)) return null;
  return list.flatMap((filter) => {
    if (!touches(filter)) return [filter];
    const value = replaceLabelId(Array.isArray(filter.value) ? filter.value : [filter.value], from, into);
    if (!value.length) return [];
    return [{ ...filter, value: Array.isArray(filter.value) ? value : value[0] }];
  });
}
