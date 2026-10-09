import { Injectable, inject } from '@angular/core';
import { DraftBox } from './drafts';
import { TramaStore } from './trama.store';

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Unsent text per workspace (localStorage): `get`/`set` with a key like `comment:issue:in_x`. */
@Injectable({ providedIn: 'root' })
export class DraftStore {
  private readonly store = inject(TramaStore);
  private readonly box = new DraftBox(browserStorage());

  get<T>(key: string): T | null {
    return this.box.get<T>(this.id(key));
  }

  /** `null` clears the draft. */
  set(key: string, value: unknown): void {
    this.box.set(this.id(key), value);
  }

  private id(key: string): string {
    return `${this.store.slug() ?? '-'}:${key}`;
  }
}
