import { describe, expect, it } from 'vitest';
import {
  DRAFT_MAX,
  DRAFT_TTL_MS,
  DRAFTS_STORAGE_KEY,
  DraftBox,
} from '../../../src/app/core/stores/drafts.ts';
import { visitedRef } from '../../../src/app/features/command/visited-ref.ts';

function memory(initial?: string) {
  const data = new Map<string, string>();
  if (initial) data.set(DRAFTS_STORAGE_KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('DraftBox', () => {
  it('returns what was stored, across instances (tabs and reloads)', () => {
    const storage = memory();
    new DraftBox(storage).set('acme:comment:issue:in_1', 'half a thought');
    expect(new DraftBox(storage).get('acme:comment:issue:in_1')).toBe('half a thought');
    expect(new DraftBox(storage).get('acme:comment:issue:in_2')).toBeNull();
  });

  it('removes a draft with null and leaves the others', () => {
    const box = new DraftBox(memory());
    box.set('a', 'one');
    box.set('b', 'two');
    box.set('a', null);
    expect(box.get('a')).toBeNull();
    expect(box.get('b')).toBe('two');
  });

  it('stores structured drafts', () => {
    const box = new DraftBox(memory());
    box.set('create:issue', { title: 'T', text: 'body' });
    expect(box.get('create:issue')).toEqual({ title: 'T', text: 'body' });
  });

  it('drops drafts older than the time to live', () => {
    const storage = memory();
    let now = 1_000;
    const box = new DraftBox(storage, () => now);
    box.set('old', 'x');
    now += DRAFT_TTL_MS - 1;
    expect(box.get('old')).toBe('x');
    now += 1;
    expect(box.get('old')).toBeNull();
  });

  it('keeps only the most recently written drafts', () => {
    let now = 0;
    const box = new DraftBox(memory(), () => ++now);
    for (let i = 0; i < DRAFT_MAX + 5; i++) box.set(`k${i}`, i);
    expect(box.get('k0')).toBeNull();
    expect(box.get('k4')).toBeNull();
    expect(box.get('k5')).toBe(5);
    expect(box.get(`k${DRAFT_MAX + 4}`)).toBe(DRAFT_MAX + 4);
  });

  it('survives corrupt or unavailable storage', () => {
    expect(new DraftBox(memory('{not json')).get('a')).toBeNull();
    expect(new DraftBox(memory('[1,2]')).get('a')).toBeNull();
    expect(new DraftBox(memory(JSON.stringify({ a: { value: 1 } }))).get('a')).toBeNull();
    const none = new DraftBox(null);
    none.set('a', 'x');
    expect(none.get('a')).toBeNull();
    const throwing = new DraftBox({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(() => throwing.set('a', 'x')).not.toThrow();
    expect(throwing.get('a')).toBeNull();
  });
});

describe('visitedRef', () => {
  it('recognises detail pages, with or without tabs and query', () => {
    expect(visitedRef('/acme/issues/BUG-12')).toEqual({ slug: 'acme', type: 'issue', ref: 'BUG-12' });
    expect(visitedRef('/acme/workstreams/AUTH-4/activity?x=1#top')).toEqual({
      slug: 'acme',
      type: 'workstream',
      ref: 'AUTH-4',
    });
    expect(visitedRef('/acme/projects/pj_1')).toEqual({ slug: 'acme', type: 'project', ref: 'pj_1' });
    expect(visitedRef('/acme/decisions/ADR-7')?.type).toBe('decision');
    expect(visitedRef('/acme/repositories/rp_1')?.type).toBe('repository');
    expect(visitedRef('/acme/teams/AUTH')?.type).toBe('team');
  });

  it('ignores lists, other areas and settings', () => {
    expect(visitedRef('/acme/issues')).toBeNull();
    expect(visitedRef('/acme/issues?team=tm_1')).toBeNull();
    expect(visitedRef('/acme/overview')).toBeNull();
    expect(visitedRef('/acme/settings/profile')).toBeNull();
    expect(visitedRef('/acme/views/vw_1')).toBeNull();
    expect(visitedRef('/')).toBeNull();
  });

  it('decodes encoded segments', () => {
    expect(visitedRef('/my%20team/issues/BUG-1')?.slug).toBe('my team');
  });
});
