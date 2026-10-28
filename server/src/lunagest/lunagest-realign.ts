export type SyncField = 'title' | 'description';
export type SyncTake = 'local' | 'remote';

/** What to do with one field since the last agreed copy. */
export type FieldAction = 'same' | 'adopt' | 'push' | 'pull' | 'conflict';

/**
 * `base` null means this field has never been agreed.
 * A choice forces that side even when both changed.
 * No choice and both changed is a conflict: the caller must not write.
 */
export function decideField(
  local: string,
  remote: string,
  base: string | null,
  choice?: SyncTake,
): FieldAction {
  if (choice === 'local') return local === remote ? 'same' : 'push';
  if (choice === 'remote') return local === remote ? 'same' : 'pull';
  if (base === null) return local === remote ? 'adopt' : 'conflict';
  const localChanged = local !== base;
  const remoteChanged = remote !== base;
  if (localChanged && remoteChanged) return 'conflict';
  if (localChanged) return 'push';
  if (remoteChanged) return 'pull';
  return 'same';
}

export function resolvedValue(local: string, remote: string, action: FieldAction): string {
  return action === 'pull' ? remote : local;
}
