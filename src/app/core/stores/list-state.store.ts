// ListStateStore — in-memory UI state of list screens (filters, search, tabs), kept alive while the
// user navigates inside the app so "Issues → open an issue → Issues" comes back as it was left.
// Not persisted: a full page reload (or logout) forgets it. Display options (layout, grouping,
// ordering) that already persist in localStorage stay where they are.
// State is keyed by `<workspace slug>::<key>`, so each workspace has its own filters.
import { Injectable, WritableSignal, inject, signal } from '@angular/core';
import { NablaStore } from './nabla.store';

@Injectable({ providedIn: 'root' })
export class ListStateStore {
  private readonly nabla = inject(NablaStore);
  private readonly cells = new Map<string, WritableSignal<unknown>>();

  /**
   * The signal remembered under `key` for the current workspace, created with `initial` the first
   * time. Use it in place of a component's own `signal(initial)`: the component can be destroyed
   * and rebuilt, the value stays. Call it from the constructor / field initialisers.
   */
  remember<T>(key: string, initial: T): WritableSignal<T> {
    const scoped = `${this.nabla.slug() ?? ''}::${key}`;
    let cell = this.cells.get(scoped);
    if (!cell) {
      cell = signal<unknown>(initial);
      this.cells.set(scoped, cell);
    }
    return cell as WritableSignal<T>;
  }

  /** Forget everything (logout). */
  clear(): void {
    this.cells.clear();
  }
}
