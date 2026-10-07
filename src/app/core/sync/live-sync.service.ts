// LiveSync — SSE on /api/w/:slug/events/stream keeps the open workspace fresh.
//
// - Auto-connects when NablaStore has a ready workspace; disconnects on switch / logout.
//   Instantiated by the app initializer in app.config.ts (provideLiveSync()).
// - Events from this tab (X-Client-Id) are ignored; everything else triggers a debounced
//   snapshot refetch (NablaStore.scheduleRefetch). `attention` events too.
// - Reconnects with exponential backoff (1s → 30s + jitter) and refetches after a reconnect
//   to catch missed events. Also refetches when the tab becomes visible / the browser goes online.
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, untracked } from '@angular/core';
import { ApiClient } from '../api/api-client';
import { NablaStore } from '../stores/nabla.store';
import { CLIENT_ID } from './client-id';
import { SyncStatus } from './sync-status';

const MAX_BACKOFF_MS = 30_000;
const EVENT_REFETCH_DEBOUNCE_MS = 300;

@Injectable({ providedIn: 'root' })
export class LiveSync {
  private readonly api = inject(ApiClient);
  private readonly nabla = inject(NablaStore);
  private readonly status = inject(SyncStatus);
  private readonly document = inject(DOCUMENT);

  /** Connection state: 'idle' | 'connecting' | 'open' | 'reconnecting'. */
  readonly state = this.status.live;

  private source: EventSource | null = null;
  private slug: string | null = null;
  private attempt = 0;
  private hadConnection = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const slug = this.nabla.slug();
      const ready = this.nabla.ready();
      untracked(() => {
        if (slug && ready) this.connect(slug);
        else this.disconnect();
      });
    });

    const win = this.document.defaultView;
    const onVisible = () => {
      if (this.document.visibilityState === 'visible' && this.slug) {
        this.nabla.scheduleRefetch(0);
        if (this.state() === 'reconnecting') this.retryNow();
      }
    };
    const onOnline = () => {
      this.retryNow();
      if (this.slug) this.nabla.scheduleRefetch(0);
    };
    this.document.addEventListener('visibilitychange', onVisible);
    win?.addEventListener('online', onOnline);
    inject(DestroyRef).onDestroy(() => {
      this.disconnect();
      this.document.removeEventListener('visibilitychange', onVisible);
      win?.removeEventListener('online', onOnline);
    });
  }

  /** Force a reconnect now (e.g. a "Reconnect" button). */
  retryNow(): void {
    if (!this.slug || this.state() === 'open') return;
    this.clearRetry();
    this.attempt = 0;
    this.open(this.slug);
  }

  private connect(slug: string): void {
    if (this.slug === slug && this.source) return;
    this.disconnect();
    this.slug = slug;
    this.hadConnection = false;
    this.attempt = 0;
    this.open(slug);
  }

  private disconnect(): void {
    this.clearRetry();
    this.source?.close();
    this.source = null;
    this.slug = null;
    this.status.live.set('idle');
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private open(slug: string): void {
    if (typeof EventSource === 'undefined') return;
    this.source?.close();
    this.status.live.set(this.hadConnection ? 'reconnecting' : 'connecting');
    const source = new EventSource(this.api.eventStreamUrl(slug), { withCredentials: true });
    this.source = source;

    source.onopen = () => {
      if (this.hadConnection) this.nabla.scheduleRefetch(0); // catch up on missed events
      this.hadConnection = true;
      this.attempt = 0;
      this.status.live.set('open');
    };
    source.onmessage = (message: MessageEvent<string>) => {
      let event: { type?: string; clientId?: string };
      try {
        event = JSON.parse(message.data) as typeof event;
      } catch {
        return;
      }
      if (!event || event.type === 'ping' || event.type === 'hello') return;
      if (event.clientId && event.clientId === CLIENT_ID) return;
      this.nabla.scheduleRefetch(EVENT_REFETCH_DEBOUNCE_MS);
    };
    source.onerror = () => {
      if (this.source !== source) return;
      source.close();
      this.source = null;
      this.hadConnection = true;
      this.status.live.set('reconnecting');
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
      this.attempt++;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.slug === slug) this.open(slug);
      }, backoff + Math.random() * 500);
    };
  }
}
