import { Injectable, signal } from '@angular/core';

/**
 * Peek: a read-only preview panel next to a list (Space on the focused row). The panel follows
 * the list's keyboard focus, so j/k move through items while it stays open.
 */
@Injectable({ providedIn: 'root' })
export class PeekStore {
  readonly open = signal(false);

  toggle(): void {
    this.open.update((v) => !v);
  }

  close(): void {
    this.open.set(false);
  }
}
