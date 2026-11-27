import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { ManualTimeEntryInput, TimeEntry, TimeEntryTarget } from '../api/api.types';
import { TramaStore } from './trama.store';

/** How long a loaded list is reused before `load()` fetches it again. */
const FRESH_MS = 30_000;

/**
 * The time entries the API returns for the signed-in person (the timer feature), kept in one place so the
 * statistics and the task page read the same tracked time. The task inspector also starts and stops the timer
 * and adds, replaces and removes entries through it (each change reloads the list). A failed load keeps the
 * previous list and sets `state` to `error`; a failed change sets `error` to the reason.
 */
@Injectable({ providedIn: 'root' })
export class TimeEntriesStore {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TramaStore);

  /** The entries that count. Suggested entries (from `trama sync`) are never in here: see `suggestions`. */
  readonly entries = signal<readonly TimeEntry[]>([]);
  /** Time `trama sync` suggested from a thread's active time, newest first. They count once accepted. */
  readonly suggestions = signal<readonly TimeEntry[]>([]);
  readonly state = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');

  /** The timer running now, on any task (or none). */
  readonly running = computed(() => this.entries().find((e) => !e.endedAt) ?? null);
  /** A change is being sent. */
  readonly busy = signal(false);
  /** Why the last change failed; cleared by the next one. */
  readonly error = signal('');

  private loadedSlug = '';
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  /** Fetch the entries unless a recent copy for this workspace is already loaded. */
  load(options: { force?: boolean } = {}): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return Promise.resolve();
    const fresh = this.loadedSlug === slug && Date.now() - this.loadedAt < FRESH_MS;
    if (!options.force && fresh) return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (this.loadedSlug !== slug) {
      this.entries.set([]);
      this.suggestions.set([]);
    }
    this.state.set(this.loadedSlug === slug && this.entries().length ? 'ready' : 'loading');
    this.inflight = this.api.timeEntries
      .list(slug, { quiet: true })
      .then((list) => {
        if (this.store.slug() !== slug) return;
        this.entries.set(list.filter((e) => e.source !== 'suggested'));
        this.loadedSlug = slug;
        this.loadedAt = Date.now();
        this.state.set('ready');
      })
      .catch(() => {
        this.state.set('error');
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Fetch the suggested entries. A failure keeps the previous list: they are optional help, not data to lose. */
  async loadSuggestions(): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    try {
      const list = await this.api.timeEntries.suggestions(slug, { quiet: true });
      if (this.store.slug() !== slug) return;
      this.suggestions.set(
        list
          .filter((e) => e.source === 'suggested' && !!e.endedAt)
          .sort((a, b) => (a.endedAt! < b.endedAt! ? 1 : -1)),
      );
    } catch {
      // The suggestions stay as they were.
    }
  }

  /** Accept a suggestion: it becomes a manual entry and counts from then on. */
  async accept(id: string): Promise<boolean> {
    const ok = await this.change((slug) => this.api.timeEntries.accept(slug, id, { quiet: true }));
    await this.loadSuggestions();
    return ok;
  }

  /** Dismiss a suggestion: it is deleted and never counted. */
  async dismiss(id: string): Promise<boolean> {
    const ok = await this.remove(id);
    await this.loadSuggestions();
    return ok;
  }

  /** Start the timer (this stops one that is already running). */
  start(target: TimeEntryTarget): Promise<boolean> {
    return this.change((slug) => this.api.timeEntries.start(slug, target, { quiet: true }));
  }

  stop(): Promise<boolean> {
    return this.change((slug) => this.api.timeEntries.stop(slug, { quiet: true }));
  }

  add(input: ManualTimeEntryInput): Promise<boolean> {
    return this.change((slug) => this.api.timeEntries.add(slug, input, { quiet: true }));
  }

  /**
   * Edit a finished entry. The API has no update call, so the corrected entry is added first and the old one
   * removed after: a failure leaves the old entry in place (at worst both exist for a moment).
   */
  replace(id: string, input: ManualTimeEntryInput): Promise<boolean> {
    return this.change(async (slug) => {
      await this.api.timeEntries.add(slug, input, { quiet: true });
      await this.api.timeEntries.remove(slug, id, { quiet: true });
    });
  }

  remove(id: string): Promise<boolean> {
    return this.change((slug) => this.api.timeEntries.remove(slug, id, { quiet: true }));
  }

  private async change(call: (slug: string) => Promise<unknown>): Promise<boolean> {
    const slug = this.store.slug();
    if (!slug || this.busy()) return false;
    this.busy.set(true);
    this.error.set('');
    try {
      await call(slug);
      await this.load({ force: true });
      return true;
    } catch (e) {
      this.error.set(ApiError.from(e).message);
      await this.load({ force: true });
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
