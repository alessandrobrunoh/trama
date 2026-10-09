// Latest-intent-wins synchronisation of a boolean per key (pin / unpin, follow / unfollow).
// The UI flips immediately and records what the person now wants; requests for one key never
// overlap, and when a request settles the next one is only sent if the wish changed meanwhile.
// Pure TypeScript, no Angular, so it can be unit-tested.

export class LatestIntent {
  private readonly wants = new Map<string, boolean>();
  private readonly running = new Set<string>();

  /** What the person last asked for while a request for `key` is queued or in flight. */
  wanted(key: string): boolean | undefined {
    return this.wants.get(key);
  }

  /** True while a request for `key` is queued or in flight. */
  busy(key: string): boolean {
    return this.running.has(key);
  }

  /**
   * Record `want` for `key` and make sure it reaches the server. If a request for the key is
   * already running this only updates the wish and returns at once; the running loop picks it up.
   * Otherwise it calls `send(want)` until the last wish has been sent, and resolves when settled.
   * `send` throwing aborts the loop, forgets the wish and rejects (to the caller that started it).
   */
  async push(key: string, want: boolean, send: (want: boolean) => Promise<void>): Promise<void> {
    this.wants.set(key, want);
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      for (;;) {
        const sending = this.wants.get(key);
        if (sending === undefined) return;
        await send(sending);
        if (this.wants.get(key) === sending) return;
      }
    } finally {
      this.wants.delete(key);
      this.running.delete(key);
    }
  }
}

/** A row that identifies its subject, as `Favorite` does. */
export interface Subject {
  type: string;
  subjectId: string;
}

const same = (a: Subject, b: Subject): boolean => a.type === b.type && a.subjectId === b.subjectId;

/** `list` with `subject` pinned (`make()` builds the row when it is missing) or unpinned. */
export function withPinned<T extends Subject>(list: readonly T[], subject: Subject, pinned: boolean, make: () => T): readonly T[] {
  const has = list.some((f) => same(f, subject));
  if (pinned) return has ? list : [...list, make()];
  return has ? list.filter((f) => !same(f, subject)) : list;
}

/** `list` with the row for `subject` replaced by `saved`; unchanged when the row is not there. */
export function reconcileSaved<T extends Subject>(list: readonly T[], subject: Subject, saved: T): readonly T[] {
  return list.some((f) => same(f, subject)) ? list.map((f) => (same(f, subject) ? saved : f)) : list;
}

/**
 * A freshly loaded `server` list with the rows of `local` for the subjects `isPending` flags:
 * those are mid-toggle and the local view is newer than the server's.
 */
export function mergePending<T extends Subject>(server: readonly T[], local: readonly T[], isPending: (s: T) => boolean): readonly T[] {
  const kept = server.filter((f) => !isPending(f));
  const mine = local.filter((f) => isPending(f));
  return mine.length ? [...kept, ...mine] : kept;
}
