// Pure model of the Delta thread record on the task page (v3 "06 Task detail"): what can be said about a linked
// thread from the data Trama holds. Trama keeps the thread's link, the pull requests, the task's own events and
// what the agent last synced with `trama sync` (summary, decisions, files, turns): the panel shows those.
import type { Artifact, ActorRef, ISODate, StatusEntry, ThreadRecord } from '../../core';
import { resolveStatusEntry } from '../../core';
import { ago } from '../../shared/ago';
import type { StreamEntry } from './issue-stream-model';

/** "synced 4m ago", or "synced just now": when the agent last updated the record. */
export function syncedText(iso: ISODate | undefined | null, now = Date.now()): string {
  const a = ago(iso, now);
  if (!a) return '';
  return a === 'now' ? 'synced just now' : `synced ${a} ago`;
}

/** "38 turns · 6 files": the size of the thread as the last sync reported it. Empty when it reported nothing. */
export function recordSize(r: Pick<ThreadRecord, 'turns' | 'files'>): string {
  const parts: string[] = [];
  if (r.turns !== null && r.turns > 0) parts.push(`${r.turns} turn${r.turns === 1 ? '' : 's'}`);
  if (r.files.length) parts.push(`${r.files.length} file${r.files.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The first `max` changed files, and how many more there are ("2 more files"). */
export function recordFiles(files: readonly string[], max = 6): { shown: string[]; more: number } {
  return { shown: files.slice(0, max), more: Math.max(0, files.length - max) };
}

/** "th_8f2a19" from a Delta thread URL: its last path segment, shortened when it is long. */
export function threadId(url: string | undefined | null): string {
  if (!url) return '';
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return seg.length > 12 ? `th_${seg.slice(-6)}` : seg || 'thread';
  } catch {
    return 'thread';
  }
}

/** Who linked the thread and when: the latest update event that touched `threadUrl`. */
export function linkedBy(
  events: readonly { at: ISODate; actor: ActorRef; type: string; data: Record<string, unknown> }[],
): { actor: ActorRef; at: ISODate } | undefined {
  let found: { actor: ActorRef; at: ISODate } | undefined;
  for (const e of events) {
    if (e.type !== 'issue.updated') continue;
    const fields = e.data['fields'];
    if (!Array.isArray(fields) || !fields.includes('threadUrl')) continue;
    if (!found || e.at > found.at) found = { actor: e.actor, at: e.at };
  }
  return found;
}

export const isRequest = (a: Pick<Artifact, 'kind'>): boolean =>
  a.kind === 'pull_request' || a.kind === 'merge_request';

/** "acme/web#418" for a pull request, else the title. */
export function artifactName(a: Pick<Artifact, 'kind' | 'repository' | 'externalId' | 'title'>): string {
  if (!isRequest(a)) return a.title;
  const num = a.externalId ? (a.externalId.startsWith('#') ? a.externalId : `#${a.externalId}`) : '';
  const repo = a.repository && !/^https?:/i.test(a.repository) ? a.repository : '';
  if (repo && num) return `${repo}${a.kind === 'merge_request' ? num.replace('#', '!') : num}`;
  return num ? `${a.kind === 'merge_request' ? 'MR' : 'PR'} ${num}` : a.title;
}

/** "acme/web#418 · open · checks passing · approved". */
export function artifactLine(a: Artifact): string {
  const parts = [artifactName(a), a.state];
  if (a.ci === 'passing') parts.push('checks passing');
  else if (a.ci === 'failing') parts.push('checks failing');
  else if (a.ci === 'pending') parts.push('checks running');
  if (a.review === 'approved') parts.push('approved');
  else if (a.review === 'changes_requested') parts.push('changes requested');
  if (a.hasConflicts) parts.push('conflicts');
  return parts.join(' · ');
}

/** Pull and merge requests first, then the rest, newest first inside each group. */
export function sortArtifacts(list: readonly Artifact[]): Artifact[] {
  return [...list].sort(
    (a, b) => Number(isRequest(b)) - Number(isRequest(a)) || (a.updatedAt < b.updatedAt ? 1 : -1),
  );
}

export interface RecordEvent {
  id: string;
  at: ISODate;
  text: string;
}

/** The last `limit` events of the task, oldest first, as one line each. */
export function recordEvents(
  entries: readonly StreamEntry[],
  nameOf: (actor: ActorRef | undefined) => string,
  statuses: readonly StatusEntry<string>[],
  limit = 4,
): RecordEvent[] {
  const out: RecordEvent[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'events') continue;
    for (const e of entry.events) {
      const who = nameOf(e.ev.actor);
      const v = e.view;
      const status = (s: string | undefined): string => (s ? (resolveStatusEntry(statuses, s)?.name ?? s) : '');
      let text: string;
      if (v.kind === 'created') text = `${who} created the task`;
      else if (v.kind === 'status' && v.to) text = `${who} moved it to ${status(v.to)}`;
      else text = `${who} ${v.verb}`;
      out.push({ id: e.ev.id, at: e.at, text });
    }
  }
  return out.slice(-limit);
}
