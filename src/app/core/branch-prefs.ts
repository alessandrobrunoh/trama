// "Copy git branch name": the per-user format preference (localStorage 'nabla.prefs.v1' → branchFormat)
// and the entry point every menu / shortcut / palette action calls.
import { Injectable, inject, signal } from '@angular/core';
import { BRANCH_FORMATS, DEFAULT_BRANCH_FORMAT, branchName, branchUser, type BranchFormat } from './branch-name';
import { Clipboard } from './notify/notifier';
import { NablaStore } from './stores/nabla.store';

export const PREFS_STORAGE_KEY = 'nabla.prefs.v1';

function readPrefs(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(PREFS_STORAGE_KEY) ?? 'null') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writePrefs(patch: Record<string, unknown>): void {
  try {
    globalThis.localStorage?.setItem(PREFS_STORAGE_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    /* blocked storage: the choice just won't persist */
  }
}

@Injectable({ providedIn: 'root' })
export class BranchNames {
  private readonly store = inject(NablaStore);
  private readonly clipboard = inject(Clipboard);

  readonly format = signal<BranchFormat>(this.initialFormat());

  setFormat(format: BranchFormat): void {
    this.format.set(format);
    writePrefs({ branchFormat: format });
  }

  /** Branch name for any key + title, using the current user's first name and saved format. */
  name(key: string, title: string, format: BranchFormat = this.format()): string {
    return branchName({ user: branchUser(this.store.me()?.name), key, title, format });
  }

  /** Copies the branch name and toasts "Branch name copied" with the name as description. */
  async copy(key: string, title: string): Promise<boolean> {
    return this.clipboard.copy(this.name(key, title), 'Branch name copied');
  }

  private initialFormat(): BranchFormat {
    const v = readPrefs()['branchFormat'];
    return (BRANCH_FORMATS as readonly unknown[]).includes(v) ? (v as BranchFormat) : DEFAULT_BRANCH_FORMAT;
  }
}
