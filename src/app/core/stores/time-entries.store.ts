import { Injectable, inject, signal } from '@angular/core';
import { ApiClient } from '../api/api-client';
import type { TimeEntry } from '../api/api.types';
import { TramaStore } from './trama.store';

/** How long a loaded list is reused before `load()` fetches it again. */
const FRESH_MS = 30_000;

/**
 * The time entries the API returns for the signed-in person (the timer feature), kept in one place so the
 * statistics and the task page read the same tracked time. Read-only: starting, stopping and adding time
 * stays in the timer page. A failed load keeps the previous list and sets `state` to `error`.
 */
@Injectable({ providedIn: 'root' })
export class TimeEntriesStore {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TramaStore);

  readonly entries = signal<readonly TimeEntry[]>([]);
  readonly state = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');

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
    if (this.loadedSlug !== slug) this.entries.set([]);
    this.state.set(this.loadedSlug === slug && this.entries().length ? 'ready' : 'loading');
    this.inflight = this.api.timeEntries
      .list(slug, { quiet: true })
      .then((list) => {
        if (this.store.slug() !== slug) return;
        this.entries.set(list);
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
}
