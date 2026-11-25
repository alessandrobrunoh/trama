import type { ActorRef } from '../../core';
import { artifactName, linkedBy, threadId } from './task-record-model';

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
