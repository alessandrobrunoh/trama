import { describe, expect, it } from 'vitest';
import {
  LatestIntent,
  mergePending,
  reconcileSaved,
  withPinned,
} from '../../../src/app/core/stores/latest-intent.ts';

/** A `send` whose calls stay open until the test settles them. */
function manualSend() {
  const calls: { want: boolean; resolve: () => void; reject: (e: Error) => void }[] = [];
  const send = (want: boolean) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ want, resolve, reject });
    });
  return { calls, send };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LatestIntent', () => {
  it('sends a single click once', async () => {
    const q = new LatestIntent();
    const { calls, send } = manualSend();
    const done = q.push('a', true, send);
    expect(q.busy('a')).toBe(true);
    calls[0].resolve();
    await done;
    expect(calls.map((c) => c.want)).toEqual([true]);
    expect(q.busy('a')).toBe(false);
    expect(q.wanted('a')).toBeUndefined();
  });

  it('never overlaps requests for a key and ends on the last wish (add, remove, add)', async () => {
    const q = new LatestIntent();
    const { calls, send } = manualSend();
    const done = q.push('a', true, send);
    void q.push('a', false, send);
    void q.push('a', true, send);
    await tick();
    expect(calls).toHaveLength(1);
    calls[0].resolve();
    await done;
    // The wish is back to what was sent: nothing more to do.
    expect(calls.map((c) => c.want)).toEqual([true]);
  });

  it('follows up when the wish changed while a request was in flight', async () => {
    const q = new LatestIntent();
    const { calls, send } = manualSend();
    const done = q.push('a', true, send);
    void q.push('a', false, send);
    calls[0].resolve();
    await tick();
    expect(calls.map((c) => c.want)).toEqual([true, false]);
    calls[1].resolve();
    await done;
    expect(q.busy('a')).toBe(false);
  });

  it('runs different keys independently', async () => {
    const q = new LatestIntent();
    const { calls, send } = manualSend();
    const a = q.push('a', true, send);
    const b = q.push('b', true, send);
    expect(calls).toHaveLength(2);
    calls[0].resolve();
    calls[1].resolve();
    await Promise.all([a, b]);
  });

  it('rejects to the caller that started the burst and forgets the wish', async () => {
    const q = new LatestIntent();
    const { calls, send } = manualSend();
    const done = q.push('a', true, send);
    void q.push('a', false, send);
    calls[0].reject(new Error('boom'));
    await expect(done).rejects.toThrow('boom');
    expect(q.busy('a')).toBe(false);
    expect(q.wanted('a')).toBeUndefined();
    // A later click starts a fresh request.
    void q.push('a', true, send);
    expect(calls).toHaveLength(2);
  });
});

type Row = { id: string; type: string; subjectId: string };
const row = (id: string, subjectId: string): Row => ({ id, type: 'issue', subjectId });
const subject = (subjectId: string) => ({ type: 'issue', subjectId });

describe('favorite list helpers', () => {
  it('withPinned adds once and removes only the subject', () => {
    const list = [row('f1', 'a')];
    const added = withPinned(list, subject('b'), true, () => row('tmp', 'b'));
    expect(added.map((r) => r.id)).toEqual(['f1', 'tmp']);
    expect(withPinned(added, subject('b'), true, () => row('tmp2', 'b'))).toBe(added);
    expect(withPinned(added, subject('b'), false, () => row('x', 'b')).map((r) => r.id)).toEqual(['f1']);
    expect(withPinned(list, subject('zzz'), false, () => row('x', 'zzz'))).toBe(list);
  });

  it('reconcileSaved swaps the optimistic row and leaves a removed one removed', () => {
    const list = [row('f1', 'a'), row('tmp', 'b')];
    expect(reconcileSaved(list, subject('b'), row('fav_9', 'b')).map((r) => r.id)).toEqual(['f1', 'fav_9']);
    expect(reconcileSaved([row('f1', 'a')], subject('b'), row('fav_9', 'b')).map((r) => r.id)).toEqual(['f1']);
  });

  it('mergePending keeps the local rows of subjects mid-toggle', () => {
    const server = [row('f1', 'a'), row('f2', 'b')];
    const local = [row('f1', 'a'), row('tmp', 'c')];
    const pending = (s: { subjectId: string }) => s.subjectId === 'b' || s.subjectId === 'c';
    // b is mid-unpin locally (absent from local), c mid-pin (only local).
    expect(mergePending(server, local, pending).map((r) => r.id)).toEqual(['f1', 'tmp']);
    expect(mergePending(server, local, () => false)).toEqual(server);
  });
});
