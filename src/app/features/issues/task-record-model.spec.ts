import type { ActorRef, DomainEvent } from '../../core';
import { buildStream } from './issue-stream-model';
import {
  artifactName,
  linkedBy,
  recordEvents,
  recordFiles,
  recordSize,
  syncedText,
  threadId,
} from './task-record-model';

const actor: ActorRef = { type: 'user', id: 'u1' };

describe('threadId', () => {
  it('uses the last path segment of the thread url', () => {
    expect(threadId('https://delta.example/t/th_8f2a19')).toBe('th_8f2a19');
  });

  it('shortens long segments and tolerates junk', () => {
    expect(threadId('https://delta.example/t/0123456789abcdef')).toBe('th_abcdef');
    expect(threadId('not a url')).toBe('thread');
    expect(threadId(undefined)).toBe('');
  });
});

describe('linkedBy', () => {
  it('finds the latest update that touched threadUrl', () => {
    const other: ActorRef = { type: 'user', id: 'u2' };
    const found = linkedBy([
      { at: '2026-01-01T10:00:00Z', actor, type: 'issue.updated', data: { fields: ['threadUrl'] } },
      { at: '2026-01-02T10:00:00Z', actor: other, type: 'issue.updated', data: { fields: ['threadUrl'] } },
      { at: '2026-01-03T10:00:00Z', actor, type: 'issue.updated', data: { fields: ['title'] } },
    ]);
    expect(found).toEqual({ actor: other, at: '2026-01-02T10:00:00Z' });
  });

  it('is undefined when nothing linked a thread', () => {
    expect(linkedBy([{ at: '2026-01-01T10:00:00Z', actor, type: 'issue.created', data: {} }])).toBeUndefined();
  });
});

describe('artifactName', () => {
  it('names a pull request by repository and number', () => {
    expect(
      artifactName({ kind: 'pull_request', repository: 'acme/web', externalId: '418', title: 'Fix' }),
    ).toBe('acme/web#418');
  });

  it('keeps the title of other artifacts', () => {
    expect(artifactName({ kind: 'document', repository: 'acme/web', externalId: '', title: 'Spec' })).toBe('Spec');
  });
});

describe('syncedText', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');

  it('says how long ago the agent synced', () => {
    expect(syncedText('2026-01-01T11:56:00Z', now)).toBe('synced 4m ago');
    expect(syncedText('2026-01-01T11:59:50Z', now)).toBe('synced just now');
    expect(syncedText(undefined, now)).toBe('');
  });
});

describe('recordSize', () => {
  it('reports turns and files, leaving out what is unknown', () => {
    expect(recordSize({ turns: 38, files: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe('38 turns · 6 files');
    expect(recordSize({ turns: 1, files: ['a'] })).toBe('1 turn · 1 file');
    expect(recordSize({ turns: null, files: ['a', 'b'] })).toBe('2 files');
    expect(recordSize({ turns: null, files: [] })).toBe('');
  });
});

describe('recordFiles', () => {
  it('keeps the first files and counts the rest', () => {
    expect(recordFiles(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], more: 1 });
    expect(recordFiles(['a'], 2)).toEqual({ shown: ['a'], more: 0 });
  });
});

describe('recordEvents', () => {
  it('reads a record sync as one line with what it added', () => {
    const ev = {
      id: 'ev1',
      workspaceId: 'w',
      at: '2026-01-01T10:00:00Z',
      actor,
      type: 'issue.thread_synced',
      subject: { type: 'issue', id: 'i1' },
      data: { decisions: 2, files: 3 },
    } as DomainEvent;
    const lines = recordEvents(buildStream([ev], []), () => 'Agent', []);
    expect(lines.map((l) => l.text)).toEqual(['Agent synced the record · 2 decisions · 3 files']);
  });
});
