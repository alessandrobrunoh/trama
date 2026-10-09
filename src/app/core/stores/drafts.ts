// Unsent drafts (create dialog, comments) kept in browser storage so they survive navigation and refresh.
// Plain TypeScript on purpose: the logic is unit tested without Angular.

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Entry {
  at: number;
  value: unknown;
}

export const DRAFTS_STORAGE_KEY = 'nabla.drafts.v1';
/** Drafts older than this are dropped. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The most recently touched drafts are kept; older ones make room. */
export const DRAFT_MAX = 40;

/** Key → value map with expiry and a size cap; every read and write goes to the storage, so tabs agree. */
export class DraftBox {
  constructor(
    private readonly storage: DraftStorage | null,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(id: string): T | null {
    const entry = this.read()[id];
    return entry ? (entry.value as T) : null;
  }

  /** `null` removes the draft. */
  set(id: string, value: unknown): void {
    const all = this.read();
    if (value === null || value === undefined) {
      if (!(id in all)) return;
      delete all[id];
    } else {
      all[id] = { at: this.now(), value };
    }
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, DRAFT_MAX);
    this.write(Object.fromEntries(kept));
  }

  private read(): Record<string, Entry> {
    const out: Record<string, Entry> = {};
    try {
      const raw = this.storage?.getItem(DRAFTS_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (!parsed || typeof parsed !== 'object') return out;
      for (const [id, e] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = e as Partial<Entry> | null;
        if (entry && typeof entry.at === 'number' && 'value' in entry && this.now() - entry.at < DRAFT_TTL_MS)
          out[id] = { at: entry.at, value: entry.value };
      }
    } catch {
      /* unreadable storage: behave as if there were no drafts */
    }
    return out;
  }

  private write(all: Record<string, Entry>): void {
    try {
      this.storage?.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* blocked or full storage: the draft just won't survive */
    }
  }
}
