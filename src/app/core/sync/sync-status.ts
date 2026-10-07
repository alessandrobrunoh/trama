import { Injectable, computed, signal } from '@angular/core';

/** Live-update channel (SSE) state. */
export type LiveState = 'idle' | 'connecting' | 'open' | 'reconnecting';

/** Read-only connection status for the UI (sidebar / status chip). Written by NablaStore + LiveSync. */
@Injectable({ providedIn: 'root' })
export class SyncStatus {
  readonly live = signal<LiveState>('idle');
  /** ISO time of the last snapshot applied. */
  readonly lastSyncedAt = signal<string | null>(null);
  /** Last load / refetch / write error message; cleared on the next success. */
  readonly lastError = signal<string | null>(null);
  /** Writes queued or in flight. */
  readonly pendingWrites = signal(0);

  /** Short label for a status chip. */
  readonly label = computed(() => {
    if (this.live() === 'reconnecting') return 'Reconnecting…';
    if (this.pendingWrites() > 0) return 'Saving…';
    if (this.lastError()) return 'Sync error';
    return this.live() === 'open' ? 'Live' : 'Synced';
  });
}
