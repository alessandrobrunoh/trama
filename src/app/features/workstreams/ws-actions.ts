// Workstream actions shared by the list rows, board cards, context menus, the bulk bar and the
// detail page: copy key / link, open the Delta thread, status override / priority / accountable /
// target date for one or many workstreams (with Undo), and delete with confirmation.
// Also a tiny "intent" bus so keyboard shortcuts can open an inline picker that lives in another
// component (e.g. `s` on a focused row opens that row's status picker).
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  BranchNames,
  Clipboard,
  NablaStore,
  Notifier,
  PRIORITY_META,
  UiStore,
  WORKSTREAM_STATUS_META,
  type ID,
  type Priority,
  type UpdateWorkstreamInput,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';

export type WsIntentKind =
  | 'status'
  | 'priority'
  | 'accountable'
  | 'date'
  | 'link-issue'
  | 'new-issue'
  | 'add-dependency'
  | 'ask'
  | 'title';

export interface WsIntent {
  kind: WsIntentKind;
  /** Workstream id, or `bulk` for the bulk bar. */
  target: string;
  n: number;
}

let seq = 0;

@Injectable({ providedIn: 'root' })
export class WsActions {
  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);
  private readonly clipboard = inject(Clipboard);
  private readonly branches = inject(BranchNames);
  private readonly router = inject(Router);

  /** Pending "open this editor" request (consumed by the component that owns the editor). */
  readonly intent = signal<WsIntent | null>(null);

  request(kind: WsIntentKind, target: string): void {
    this.intent.set({ kind, target, n: ++seq });
  }

  /** True (and clears the intent) when the pending intent is `kind` for `target`. */
  consume(kind: WsIntentKind, target: string): boolean {
    const i = this.intent();
    if (!i || i.kind !== kind || i.target !== target) return false;
    queueMicrotask(() => {
      if (this.intent()?.n === i.n) this.intent.set(null);
    });
    return true;
  }

  /** The workstreams an action on `ws` applies to: the multi-selection when `ws` is part of it. */
  targetsFor(ws: Workstream): Workstream[] {
    const sel = this.ui.selectedRowIds();
    if (sel.length > 1 && sel.includes(ws.id)) return this.selected();
    return [ws];
  }

  /** Selected rows that are workstreams. */
  selected(): Workstream[] {
    return this.ui
      .selectedRowIds()
      .map((id) => this.store.workstreamById().get(id))
      .filter((w): w is Workstream => !!w);
  }

  url(ws: Workstream): string {
    const origin = globalThis.location?.origin ?? '';
    return `${origin}/${this.store.slug() ?? ''}/workstreams/${ws.key}`;
  }

  copyKey(list: readonly Workstream[]): void {
    if (!list.length) return;
    const text = list.map((w) => w.key).join(', ');
    void this.clipboard.copy(text, list.length > 1 ? `Copied ${list.length} keys` : `Copied ${text}`);
  }

  copyLink(list: readonly Workstream[]): void {
    if (!list.length) return;
    void this.clipboard.copy(list.map((w) => this.url(w)).join('\n'), list.length > 1 ? `Copied ${list.length} links` : 'Link copied');
  }

  /** "Copy git branch name" for a workstream (key = workstream key). */
  copyBranch(ws: Workstream): void {
    void this.branches.copy(ws.key, ws.title);
  }

  /** Copy "AUTH-42 Title" (handy for chat / commit messages). */
  copyKeyAndTitle(ws: Workstream): void {
    void this.clipboard.copy(`${ws.key} ${ws.title}`, 'Copied key and title');
  }

  openDelta(ws: Workstream): void {
    if (ws.deltaThreadUrl) globalThis.open?.(ws.deltaThreadUrl, '_blank', 'noopener,noreferrer');
  }

  open(ws: Workstream, tab?: string): void {
    const slug = this.store.slug();
    if (slug) void this.router.navigate(['/', slug, 'workstreams', ws.key], tab ? { queryParams: { tab } } : {});
  }

  /** `null` = back to the derived status. */
  setStatus(list: readonly Workstream[], status: WorkstreamStatus | null): void {
    const label = status ? WORKSTREAM_STATUS_META[status].label : 'automatic';
    this.patchAll(
      list.filter((w) => (w.statusOverride ?? null) !== status),
      () => ({ statusOverride: status }),
      (w) => ({ statusOverride: w.statusOverride ?? null }),
      `Status set to ${label}`,
    );
  }

  setPriority(list: readonly Workstream[], priority: Priority): void {
    this.patchAll(
      list.filter((w) => w.priority !== priority),
      () => ({ priority }),
      (w) => ({ priority: w.priority }),
      `Priority set to ${PRIORITY_META[priority].label}`,
    );
  }

  setAccountable(list: readonly Workstream[], userId: ID | null): void {
    const name = userId ? (this.store.getUser(userId)?.name ?? 'someone') : null;
    this.patchAll(
      list.filter((w) => (w.accountableUserId ?? null) !== userId),
      () => ({ accountableUserId: userId }),
      (w) => ({ accountableUserId: w.accountableUserId ?? null }),
      name ? `Accountable: ${name}` : 'Accountable cleared',
    );
  }

  /** `date` is a local calendar day (stored at noon to survive time zones); `null` clears. */
  setTargetDate(list: readonly Workstream[], date: Date | null): void {
    const iso = date ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).toISOString() : null;
    this.patchAll(
      list.filter((w) => (w.targetDate ?? null) !== iso),
      () => ({ targetDate: iso }),
      (w) => ({ targetDate: w.targetDate ?? null }),
      iso ? 'Target date updated' : 'Target date cleared',
    );
  }

  confirmDelete(list: readonly Workstream[], after?: () => void): void {
    if (!list.length || !this.store.allowed('deleteWorkstreams')) return;
    const one = list.length === 1;
    this.ui.setConfirmDelete({
      title: one ? `Delete ${list[0].key}?` : `Delete ${list.length} workstreams?`,
      description: one
        ? `“${list[0].title}” and its artifacts, input requests, dependencies and comments are deleted. Linked issues stay. This cannot be undone.`
        : 'Their artifacts, input requests, dependencies and comments are deleted. Linked issues stay. This cannot be undone.',
      confirmLabel: one ? 'Delete workstream' : `Delete ${list.length}`,
      onConfirm: async () => {
        const ids = new Set(list.map((w) => w.id));
        this.ui.setSelected(this.ui.selectedRowIds().filter((id) => !ids.has(id)));
        const results = await Promise.all(list.map((w) => this.store.deleteWorkstream(w.id)));
        const ok = results.filter(Boolean).length;
        if (ok) this.notify.success(one ? `${list[0].key} deleted` : `${ok} workstreams deleted`);
        after?.();
      },
    });
  }

  /**
   * Apply one patch to several workstreams. Single edits are silent (the row updates in place);
   * bulk edits toast with an Undo that restores each workstream's previous value.
   */
  private patchAll(
    list: readonly Workstream[],
    patch: (w: Workstream) => UpdateWorkstreamInput,
    previous: (w: Workstream) => UpdateWorkstreamInput,
    title: string,
  ): void {
    if (!list.length) return;
    const undo = list.map((w) => ({ id: w.id, patch: previous(w) }));
    for (const w of list) void this.store.updateWorkstream(w.id, patch(w));
    if (list.length > 1) {
      this.notify.success(`${title} · ${list.length} workstreams`, {
        action: {
          label: 'Undo',
          run: () => {
            for (const u of undo) void this.store.updateWorkstream(u.id, u.patch);
          },
        },
      });
    }
  }
}
