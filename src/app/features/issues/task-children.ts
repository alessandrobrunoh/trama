import { Injectable, computed, inject } from '@angular/core';
import { TramaStore, type Issue } from '../../core';
import { childrenByParent } from './task-subtree-model';

/**
 * The store's tasks grouped by parent, computed once for every subtask tree and status check on screen, so
 * opening a task never costs a request or a scan of the whole list per level.
 */
@Injectable({ providedIn: 'root' })
export class TaskChildren {
  private readonly store = inject(TramaStore);
  readonly byParent = computed<ReadonlyMap<string, readonly Issue[]>>(() =>
    childrenByParent(this.store.issues()),
  );

  /** Direct children of a task, in list order. */
  of(id: string): readonly Issue[] {
    return this.byParent().get(id) ?? [];
  }
}
