// Pure model of a task's story: its domain events and comments as one chronological stream, with runs of
// consecutive events folded into a single muted line ("Changed status 3 times, edited labels"). No Angular
// here, so the grouping is cheap to test.
import { ISSUE_STATUS_META, type Comment, type DomainEvent, type IssueStatus } from '../../core';

export type EventKind = 'created' | 'status' | 'update' | 'other';

export interface EventView {
  kind: EventKind;
  /** One-line wording, without the actor ("changed status", "edited the description"). */
  verb: string;
  from?: IssueStatus;
  to?: IssueStatus;
  /** Task fields an `update` touched. */
  fields: string[];
}

/** Sentence for one changed field when it is the only thing that happened. */
const FIELD_VERB: Record<string, string> = {
  title: 'renamed the task',
  body: 'edited the description',
  assigneeId: 'changed the assignee',
  priority: 'changed the priority',
  reporterName: 'updated the reporter',
  externalUrl: 'updated the external link',
  threadUrl: 'updated the thread link',
  projectId: 'changed the project',
  estimate: 'changed the estimate',
  labels: 'changed the labels',
  milestoneIds: 'changed the milestone',
  kind: 'changed the type',
  duplicateOfId: 'changed the duplicate relation',
};

/** The noun used when several fields are folded together ("edited labels and priority"). */
const FIELD_NOUN: Record<string, string> = {
  title: 'title',
  body: 'description',
  assigneeId: 'assignee',
  priority: 'priority',
  reporterName: 'reporter',
  externalUrl: 'external link',
  threadUrl: 'thread link',
  projectId: 'project',
  estimate: 'estimate',
  labels: 'labels',
  milestoneIds: 'milestone',
  kind: 'type',
  duplicateOfId: 'duplicate relation',
};

function isStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && value in ISSUE_STATUS_META;
}

/** What an event says; null for events the stream does not show (the comment itself is in the stream). */
export function describeEvent(ev: DomainEvent): EventView | null {
  const d = ev.data;
  switch (ev.type) {
    case 'issue.created':
      return { kind: 'created', verb: 'created the task', fields: [] };
    case 'issue.status_changed':
      return {
        kind: 'status',
        verb: 'changed status',
        from: isStatus(d['from']) ? d['from'] : undefined,
        to: isStatus(d['to']) ? d['to'] : undefined,
        fields: [],
      };
    case 'issue.updated': {
      const fields = Array.isArray(d['fields']) ? (d['fields'] as unknown[]).filter((f): f is string => typeof f === 'string') : [];
      const verbs = fields.map((f) => FIELD_VERB[f] ?? `updated ${f}`);
      return { kind: 'update', verb: verbs.length ? verbs.join(', ') : 'updated the task', fields };
    }
    case 'issue.linked':
      return { kind: 'other', verb: 'recorded a legacy task link', fields: [] };
    case 'comment.created':
      return null;
    default:
      return {
        kind: 'other',
        verb: ev.type.replace(/^issue\./, '').replace(/[._]/g, ' '),
        fields: [],
      };
  }
}

export interface StreamEvent {
  id: string;
  at: string;
  ev: DomainEvent;
  view: EventView;
}

export type StreamEntry =
  | { kind: 'comment'; id: string; at: string; comment: Comment }
  | { kind: 'events'; id: string; at: string; events: StreamEvent[] };

function byTime(a: { at: string }, b: { at: string }): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

/**
 * Events and comments oldest first. Consecutive events become one `events` entry; a comment ends the run.
 */
export function buildStream(events: readonly DomainEvent[], comments: readonly Comment[]): StreamEntry[] {
  type Raw =
    | { kind: 'event'; at: string; item: StreamEvent }
    | { kind: 'comment'; at: string; comment: Comment };
  const raw: Raw[] = [];
  for (const ev of events) {
    const view = describeEvent(ev);
    if (view) raw.push({ kind: 'event', at: ev.at, item: { id: ev.id, at: ev.at, ev, view } });
  }
  for (const comment of comments) raw.push({ kind: 'comment', at: comment.createdAt, comment });
  raw.sort(byTime);

  const out: StreamEntry[] = [];
  for (const r of raw) {
    if (r.kind === 'comment') {
      out.push({ kind: 'comment', id: r.comment.id, at: r.at, comment: r.comment });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === 'events') last.events.push(r.item);
    else out.push({ kind: 'events', id: r.item.id, at: r.at, events: [r.item] });
  }
  return out;
}

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * One muted line for a run of events: "Changed status 3 times, edited labels and priority". A run of a
 * single event is not folded (the stream shows the event itself), so this is for two or more.
 */
export function summarizeEvents(events: readonly StreamEvent[]): string {
  const clauses: string[] = [];
  const created = events.some((e) => e.view.kind === 'created');
  if (created) clauses.push('created the task');

  const statusChanges = events.filter((e) => e.view.kind === 'status').length;
  if (statusChanges === 1) clauses.push('changed status');
  else if (statusChanges > 1) clauses.push(`changed status ${statusChanges} times`);

  const nouns: string[] = [];
  let untyped = 0;
  for (const e of events) {
    if (e.view.kind === 'update') {
      if (!e.view.fields.length) untyped++;
      for (const f of e.view.fields) {
        const noun = FIELD_NOUN[f] ?? f;
        if (!nouns.includes(noun)) nouns.push(noun);
      }
    }
  }
  if (nouns.length) clauses.push(`edited ${joinList(nouns)}`);
  else if (untyped) clauses.push('updated the task');

  const others = events.filter((e) => e.view.kind === 'other').length;
  if (others) clauses.push(others === 1 ? events.find((e) => e.view.kind === 'other')!.view.verb : `${others} other changes`);

  const text = clauses.join(', ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Updated the task';
}

/** The distinct people behind a run of events, in order of first appearance. */
export function eventActors(events: readonly StreamEvent[]): DomainEvent['actor'][] {
  const seen = new Set<string>();
  const out: DomainEvent['actor'][] = [];
  for (const e of events) {
    const key = `${e.ev.actor.type}:${e.ev.actor.id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.ev.actor);
  }
  return out;
}

export { splitQuote, toQuote } from '../../shared/comment-quote';
