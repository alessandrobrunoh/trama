// How an `issue.thread_synced` event reads: what one `trama sync` added to the task's thread record.
// The payload is small (decisions added, files, whether a PR was attached, minutes), so every key is read
// defensively and a part with nothing in it is left out.

const count = (v: unknown): number => {
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
};

const first = (d: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const k of keys) if (d[k] !== undefined && d[k] !== null) return d[k];
  return undefined;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `['2 decisions', '3 files', 'PR attached', '47m suggested']`: only the parts the sync had. */
export function threadSyncParts(data: Record<string, unknown> | undefined): string[] {
  const d = data ?? {};
  const parts: string[] = [];
  const decisions = count(first(d, ['decisions', 'decisionsAdded']));
  if (decisions) parts.push(plural(decisions, 'decision'));
  const files = count(first(d, ['files', 'fileCount']));
  if (files) parts.push(plural(files, 'file'));
  const pr = first(d, ['pullRequest', 'pullRequestAttached', 'pr']);
  if (pr === true || (typeof pr === 'string' && pr)) parts.push('PR attached');
  const minutes = count(first(d, ['minutes', 'activeMinutes']));
  if (minutes) parts.push(`${duration(minutes)} suggested`);
  return parts;
}

/** `47m`, `1h`, `1h 30m`. */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const m = minutes % 60;
  return m ? `${Math.floor(minutes / 60)}h ${m}m` : `${minutes / 60}h`;
}

/** "synced the record · 2 decisions · 3 files": the verb phrase of the event, without who did it. */
export function threadSyncVerb(data: Record<string, unknown> | undefined): string {
  return ['synced the record', ...threadSyncParts(data)].join(' · ');
}
