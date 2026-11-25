// Pure model of the Delta thread record on the task page (v3 "06 Task detail"): what can be said about a linked
// thread from the data Trama holds today, and nothing more. The thread itself (decisions, files, turns) lives
// in Delta; Trama keeps its link, the pull requests and the task's own events.
import type { Artifact, ActorRef, ISODate, StatusEntry } from '../../core';
import { resolveStatusEntry } from '../../core';
import type { StreamEntry } from './issue-stream-model';

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
