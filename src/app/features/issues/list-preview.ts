// Shared state of the task lists.
import { Injectable, computed, inject } from '@angular/core';
import { TramaStore } from '../../core';

/** Ids of the tasks with an open attention item: they need the current user. */
@Injectable({ providedIn: 'root' })
export class NeedsYou {
  private readonly store = inject(TramaStore);
  readonly issueIds = computed(() => {
    const ids = new Set<string>();
    for (const a of this.store.openAttention()) if (a.issueId) ids.add(a.issueId);
    return ids;
  });
}
