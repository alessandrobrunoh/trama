import type { Comment, DomainEvent } from '../../core';
import { buildStream, eventActors, splitQuote, summarizeEvents, toQuote } from './issue-stream-model';

let n = 0;
function event(type: string, at: string, data: Record<string, unknown> = {}, actorId = 'u1'): DomainEvent {
  return {
    id: `ev${++n}`,
    workspaceId: 'w',
    at,
    actor: { type: 'user', id: actorId },
    type,
    subject: { type: 'issue', id: 'i1' },
    data,
  } as DomainEvent;
}

function comment(at: string, body = 'hello'): Comment {
  return {
    id: `c${++n}`,
    workspaceId: 'w',
    subject: { type: 'issue', id: 'i1' },
    author: { type: 'user', id: 'u1' },
    body,
    createdAt: at,
    updatedAt: at,
  } as Comment;
}

describe('buildStream', () => {
  it('folds consecutive events into one entry and lets a comment end the run', () => {
    const entries = buildStream(
      [
        event('issue.created', '2026-01-01T10:00:00Z'),
        event('issue.status_changed', '2026-01-01T10:05:00Z', { from: 'todo', to: 'in_progress' }),
        event('issue.status_changed', '2026-01-01T12:00:00Z', { from: 'in_progress', to: 'done' }),
      ],
      [comment('2026-01-01T11:00:00Z')],
    );
    expect(entries.map((e) => e.kind)).toEqual(['events', 'comment', 'events']);
    expect(entries[0].kind === 'events' && entries[0].events).toHaveLength(2);
    expect(entries[2].kind === 'events' && entries[2].events).toHaveLength(1);
  });

  it('sorts oldest first and hides comment.created events', () => {
    const entries = buildStream(
      [event('comment.created', '2026-01-01T09:00:00Z')],
      [comment('2026-01-02T00:00:00Z', 'b'), comment('2026-01-01T00:00:00Z', 'a')],
    );
    expect(entries.map((e) => e.kind === 'comment' && e.comment.body)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty task', () => {
    expect(buildStream([], [])).toEqual([]);
  });
});

describe('summarizeEvents', () => {
  const events = (...evs: DomainEvent[]) => {
    const [entry] = buildStream(evs, []);
    return entry.kind === 'events' ? entry.events : [];
  };

  it('counts status changes and names the edited fields once', () => {
    const text = summarizeEvents(
      events(
        event('issue.status_changed', '2026-01-01T10:00:00Z', { from: 'todo', to: 'in_progress' }),
        event('issue.status_changed', '2026-01-01T10:01:00Z', { from: 'in_progress', to: 'in_review' }),
        event('issue.status_changed', '2026-01-01T10:02:00Z', { from: 'in_review', to: 'done' }),
        event('issue.updated', '2026-01-01T10:03:00Z', { fields: ['labels'] }),
        event('issue.updated', '2026-01-01T10:04:00Z', { fields: ['labels', 'priority'] }),
      ),
    );
    expect(text).toBe('Changed status 3 times, edited labels and priority');
  });

  it('starts with the creation and falls back for updates without fields', () => {
    expect(
      summarizeEvents(
        events(event('issue.created', '2026-01-01T10:00:00Z'), event('issue.updated', '2026-01-01T10:01:00Z')),
      ),
    ).toBe('Created the task, updated the task');
  });
});

describe('eventActors', () => {
  it('lists each person once, in order', () => {
    const [entry] = buildStream(
      [
        event('issue.updated', '2026-01-01T10:00:00Z', {}, 'a'),
        event('issue.updated', '2026-01-01T10:01:00Z', {}, 'b'),
        event('issue.updated', '2026-01-01T10:02:00Z', {}, 'a'),
      ],
      [],
    );
    expect(entry.kind === 'events' && eventActors(entry.events).map((a) => a.id)).toEqual(['a', 'b']);
  });
});

describe('splitQuote', () => {
  it('separates a leading quote from the reply', () => {
    expect(splitQuote('> closer to 5MB\n> per 10M items\n\nCan we link the benchmark?')).toEqual({
      quote: 'closer to 5MB\nper 10M items',
      rest: 'Can we link the benchmark?',
    });
  });

  it('leaves a body without a leading quote alone', () => {
    expect(splitQuote('plain\n> not leading')).toEqual({ quote: null, rest: 'plain\n> not leading' });
  });

  it('round-trips with toQuote', () => {
    expect(splitQuote(`${toQuote('one\ntwo')}reply`)).toEqual({ quote: 'one\ntwo', rest: 'reply' });
  });
});
