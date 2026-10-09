// ListStateStore — in-memory UI state of list screens (filters, search, tabs), kept alive while the
// user navigates inside the app so "Issues → open an issue → Issues" comes back as it was left.
// Not persisted: a full page reload (or logout) forgets it. Display options (layout, grouping,
// ordering) that already persist in localStorage stay where they are.
// State is keyed by `<workspace slug>::<key>`, so each workspace has its own filters.
import { Injectable, Signal, WritableSignal, computed, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { scopedKey, workspaceSlugOf } from './list-state-scope';
import { NablaStore } from './nabla.store';

@Injectable({ providedIn: 'root' })
export class ListStateStore {
  private readonly nabla = inject(NablaStore);
  private readonly router = inject(Router);
  private readonly cells = new Map<string, WritableSignal<unknown>>();

  /**
   * The workspace the user is looking at. Taken from the route, not captured when a page is
   * built: going from `/acme/issues` straight to `/globex/issues` keeps the same component
   * alive, and its remembered values must switch to Globex's.
   */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  private readonly scope: Signal<string> = computed(() => workspaceSlugOf(this.url()) ?? this.nabla.slug() ?? '');

  /**
   * The signal remembered under `key` for the current workspace, created with `initial` the first
   * time. Use it in place of a component's own `signal(initial)`: the component can be destroyed
   * and rebuilt, the value stays. Call it from the constructor / field initialisers. The returned
   * signal follows the workspace: reading and writing it always hits the current workspace's value.
   */
  remember<T>(key: string, initial: T): WritableSignal<T> {
    const read = computed(() => this.cell(this.scope(), key, initial)());
    const current = () => untracked(() => this.cell(this.scope(), key, initial));
    const set = (value: T) => current().set(value);
    const update = (fn: (value: T) => T) => current().update(fn);
    return Object.assign(read, { set, update, asReadonly: () => read }) as unknown as WritableSignal<T>;
  }

  /** Forget everything (logout). */
  clear(): void {
    this.cells.clear();
  }

  private cell<T>(slug: string, key: string, initial: T): WritableSignal<T> {
    const scoped = scopedKey(slug, key);
    let cell = this.cells.get(scoped);
    if (!cell) {
      cell = signal<unknown>(initial);
      this.cells.set(scoped, cell);
    }
    return cell as WritableSignal<T>;
  }
}
