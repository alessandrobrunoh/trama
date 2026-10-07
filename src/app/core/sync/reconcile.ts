// Structural sharing for refetched snapshots: entities that did not change keep their
// previous object identity (and whole collections their array identity), so `computed()`s
// and OnPush views only react to what actually changed after a refetch.
type Row = { id: string };

export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Returns `prev` itself when nothing changed, else `next` with unchanged rows taken from `prev`. */
export function reconcileList<T extends Row>(prev: readonly T[], next: readonly T[]): readonly T[] {
  const byId = new Map(prev.map((row) => [row.id, row]));
  let changed = prev.length !== next.length;
  const out = next.map((row, index) => {
    const old = byId.get(row.id);
    const kept = old && sameJson(old, row) ? old : row;
    if (kept !== prev[index]) changed = true;
    return kept;
  });
  return changed ? out : prev;
}

/** Same for a single object. */
export function reconcileOne<T>(prev: T | null, next: T): T {
  return prev !== null && sameJson(prev, next) ? prev : next;
}
