// Issue mutations shared by the list, board, context menu, bulk bar, keyboard and detail page.
// Every bulk-capable action takes ids, applies optimistic store writes and offers Undo.
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  BranchNames,
  Clipboard,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  NablaStore,
  Notifier,
  PRIORITY_META,
  UiStore,
  type Issue,
  type IssueKind,
  type IssueStatus,
  type Priority,
  type UpdateIssueInput,
} from '../../core';

/** What the keyboard / bulk command dialog edits. */
export type IssuePromptField = 'status' | 'priority' | 'assignee' | 'team' | 'workstream' | 'duplicate';

export interface IssuePrompt {
  field: IssuePromptField;
  ids: string[];
}

type Snapshot = Pick<Issue, 'id' | 'status' | 'priority' | 'assigneeId' | 'teamId' | 'workstreamIds'>;

@Injectable({ providedIn: 'root' })
export class IssueActions {
  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);
  private readonly clipboard = inject(Clipboard);
  private readonly branches = inject(BranchNames);

  /** Open command dialog ("Change status…" etc.), or null. */
  readonly prompt = signal<IssuePrompt | null>(null);
  /** Issue ids in the order the last list/board showed them (prev / next on the detail page). */
  readonly navOrder = signal<readonly string[]>([]);

  openPrompt(field: IssuePromptField, ids: readonly string[]): void {
    const list = ids.filter((id) => this.store.issueById().has(id));
    if (list.length && this.store.can('member')) this.prompt.set({ field, ids: list });
  }

  closePrompt(): void {
    this.prompt.set(null);
  }

  issues(ids: readonly string[]): Issue[] {
    const byId = this.store.issueById();
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /** "BUG-142" or "3 issues". */
  subject(ids: readonly string[]): string {
    const list = this.issues(ids);
    return list.length === 1 ? list[0].key : `${list.length} issues`;
  }

  // ───────────────────────── properties ─────────────────────────

  setStatus(ids: readonly string[], status: IssueStatus): void {
    this.patchMany(ids, (i) => (i.status === status ? null : { status }), `Status set to ${ISSUE_STATUS_META[status].label}`);
  }

  setPriority(ids: readonly string[], priority: Priority): void {
    this.patchMany(ids, (i) => (i.priority === priority ? null : { priority }), `Priority set to ${PRIORITY_META[priority].label}`);
  }

  setAssignee(ids: readonly string[], userId: string | null): void {
    const name = userId ? (this.store.getUser(userId)?.name ?? 'someone') : null;
    this.patchMany(
      ids,
      (i) => ((i.assigneeId ?? null) === userId ? null : { assigneeId: userId }),
      name ? `Assigned to ${name}` : 'Unassigned',
    );
  }

  /** Assign to me; when every issue is already mine, unassign. */
  toggleAssignMe(ids: readonly string[]): void {
    const me = this.store.me()?.id;
    if (!me) return;
    const mine = this.issues(ids).every((i) => i.assigneeId === me);
    this.setAssignee(ids, mine ? null : me);
  }

  setTeam(ids: readonly string[], teamId: string | null): void {
    const name = teamId ? (this.store.getTeam(teamId)?.name ?? 'team') : null;
    this.patchMany(ids, (i) => ((i.teamId ?? null) === teamId ? null : { teamId }), name ? `Moved to ${name}` : 'Team cleared');
  }

  // ───────────────────────── workstreams ─────────────────────────

  /** Add when not every issue is linked yet, otherwise remove the link from all. */
  toggleWorkstream(ids: readonly string[], workstreamId: string): void {
    const list = this.issues(ids);
    if (list.length && list.every((i) => i.workstreamIds.includes(workstreamId))) this.unlink(ids, workstreamId);
    else this.link(ids, workstreamId);
  }

  /**
   * Link issues into a workstream. Uses the link endpoint (records `issue.linked` on the workstream;
   * backlog / todo issues move to in progress). Canceled issues are attached with a plain update,
   * duplicates are skipped.
   */
  link(ids: readonly string[], workstreamId: string): void {
    const ws = this.store.getWorkstream(workstreamId);
    if (!ws) return;
    const all = this.issues(ids).filter((i) => !i.workstreamIds.includes(ws.id));
    const dupes = all.filter((i) => i.duplicateOfId);
    const list = all.filter((i) => !i.duplicateOfId);
    if (!list.length) {
      if (dupes.length) this.notifier.error('Duplicates can’t be linked', { description: 'Clear “duplicate of” first.' });
      return;
    }
    const before = list.map((i) => this.snap(i));
    for (const i of list) {
      if (i.status === 'canceled') void this.store.updateIssue(i.id, { workstreamIds: [...i.workstreamIds, ws.id] });
      else void this.store.linkIssue(i.id, { workstreamIds: [ws.id] });
    }
    const moved = list.some((i) => i.status === 'backlog' || i.status === 'todo');
    this.notifier.success(`${this.subject(list.map((i) => i.id))} added to ${ws.key}`, {
      description: moved ? 'Backlog and todo issues moved to In progress.' : ws.title,
      action: { label: 'Undo', run: () => this.restore(before) },
    });
  }

  unlink(ids: readonly string[], workstreamId: string): void {
    const ws = this.store.getWorkstream(workstreamId);
    const list = this.issues(ids).filter((i) => i.workstreamIds.includes(workstreamId));
    if (!list.length) return;
    const before = list.map((i) => this.snap(i));
    for (const i of list) void this.store.updateIssue(i.id, { workstreamIds: i.workstreamIds.filter((x) => x !== workstreamId) });
    this.notifier.success(`${this.subject(list.map((i) => i.id))} removed from ${ws?.key ?? 'workstream'}`, {
      action: { label: 'Undo', run: () => this.restore(before) },
    });
  }

  /**
   * Opens the create dialog prefilled from the issue.
   * Note: the dialog currently reads `ownerTeamId` only (title / issueIds are passed for when it supports them).
   */
  createWorkstreamFrom(issue: Issue): void {
    this.ui.openCreate('workstream', {
      issueIds: [issue.id],
      title: issue.title,
      description: issue.body ?? undefined,
      ...(issue.teamId ? { ownerTeamId: issue.teamId } : {}),
      priority: issue.priority,
    });
  }

  // ───────────────────────── duplicates ─────────────────────────

  markDuplicate(id: string, targetId: string): void {
    const issue = this.store.getIssue(id);
    const target = this.store.getIssue(targetId);
    if (!issue || !target || issue.id === target.id) return;
    const before = this.snap(issue);
    void this.store.updateIssue(issue.id, { duplicateOfId: target.id, status: 'canceled' });
    this.notifier.success(`${issue.key} marked as duplicate of ${target.key}`, {
      description: 'It is canceled; follow the original instead.',
      action: {
        label: 'Undo',
        run: () => void this.store.updateIssue(issue.id, { duplicateOfId: null, status: before.status }),
      },
    });
  }

  clearDuplicate(id: string): void {
    const issue = this.store.getIssue(id);
    if (issue?.duplicateOfId) void this.store.updateIssue(issue.id, { duplicateOfId: null });
  }

  // ───────────────────────── copy / open / delete ─────────────────────────

  url(issue: Issue): string {
    const origin = globalThis.location?.origin ?? '';
    return `${origin}/${this.store.slug() ?? ''}/issues/${issue.key}`;
  }

  copyKeys(ids: readonly string[]): void {
    const list = this.issues(ids);
    if (list.length) void this.clipboard.copy(list.map((i) => i.key).join(', '), list.length === 1 ? 'Key copied' : 'Keys copied');
  }

  copyLinks(ids: readonly string[]): void {
    const list = this.issues(ids);
    if (list.length) void this.clipboard.copy(list.map((i) => this.url(i)).join('\n'), list.length === 1 ? 'Link copied' : 'Links copied');
  }

  copyTitle(id: string): void {
    const i = this.store.getIssue(id);
    if (i) void this.clipboard.copy(`${i.key} ${i.title}`, 'Copied key and title');
  }

  /** "Copy git branch name": `alessandro/bug-142-remove-deprecated-v1-sessions-table` (format in Settings → Appearance). */
  copyBranch(id: string): void {
    const i = this.store.getIssue(id);
    if (i) void this.branches.copy(i.key, i.title);
  }

  open(issue: Issue): void {
    void this.router.navigate(['/', this.store.slug() ?? '', 'issues', issue.key]);
  }

  /**
   * Change the type after a confirmation: the key prefix follows the type, so the issue is re-keyed
   * (the old key stays valid as an alias). The detail page swaps the URL to the new key.
   */
  changeKind(issue: Issue, kind: IssueKind | undefined, after?: (updated: Issue) => void): void {
    if (!kind || kind === issue.kind || !this.store.can('member')) return;
    const meta = ISSUE_KIND_META[kind];
    // The server owns the counter; this mirrors it for the common case (no deletions at the top).
    const next = this.store.issues().reduce((n, i) => (i.kind === kind ? Math.max(n, i.number) : n), 0) + 1;
    this.ui.setConfirmDelete({
      title: `Change type to ${meta.label}?`,
      description: `${issue.key} will become ${meta.prefix}-${next}. The old key keeps working: links and mentions of ${issue.key} still open this issue.`,
      confirmLabel: 'Change type',
      destructive: false,
      onConfirm: async () => {
        const updated = await this.store.changeIssueKind(issue.id, kind);
        if (!updated) return;
        this.notifier.success(`${issue.key} is now ${updated.key}`, { description: `Type: ${meta.label}` });
        after?.(updated);
      },
    });
  }

  /** Set (or clear with `null`) the story-point estimate. */
  setEstimate(ids: readonly string[], estimate: number | null): void {
    for (const i of this.issues(ids)) if (i.estimate !== (estimate ?? undefined)) void this.store.updateIssue(i.id, { estimate });
  }

  /** Confirm, then delete. `after` runs once the deletes succeeded (e.g. navigate back). */
  remove(ids: readonly string[], after?: () => void): void {
    const list = this.issues(ids);
    if (!list.length || !this.store.allowed('deleteIssues')) return;
    const one = list.length === 1;
    this.ui.setConfirmDelete({
      title: one ? `Delete ${list[0].key}?` : `Delete ${list.length} issues?`,
      description: one
        ? `“${list[0].title}” and its comments are deleted. Linked workstreams are not affected. This cannot be undone.`
        : 'These issues and their comments are deleted. Linked workstreams are not affected. This cannot be undone.',
      confirmLabel: one ? 'Delete issue' : `Delete ${list.length} issues`,
      onConfirm: async () => {
        const results = await Promise.all(list.map((i) => this.store.deleteIssue(i.id)));
        const gone = new Set(list.filter((_, n) => results[n]).map((i) => i.id));
        this.ui.setSelected(this.ui.selectedRowIds().filter((id) => !gone.has(id)));
        if (gone.size) this.notifier.success(one ? `${list[0].key} deleted` : `${gone.size} issues deleted`);
        if (gone.size === list.length) after?.();
      },
    });
  }

  // ───────────────────────── internals ─────────────────────────

  private snap(i: Issue): Snapshot {
    return { id: i.id, status: i.status, priority: i.priority, assigneeId: i.assigneeId, teamId: i.teamId, workstreamIds: [...i.workstreamIds] };
  }

  /** Apply `patch(issue)` (null = unchanged) to each issue; bulk changes offer Undo. */
  private patchMany(ids: readonly string[], patch: (i: Issue) => UpdateIssueInput | null, title: string): void {
    const changed: { issue: Issue; patch: UpdateIssueInput }[] = [];
    for (const issue of this.issues(ids)) {
      const p = patch(issue);
      if (p) changed.push({ issue, patch: p });
    }
    if (!changed.length) return;
    const before = changed.map((c) => this.snap(c.issue));
    for (const c of changed) void this.store.updateIssue(c.issue.id, c.patch);
    // Single inline edits are visible in place; bulk edits get a toast with Undo.
    if (changed.length === 1) return;
    this.notifier.success(title, {
      description: this.subject(changed.map((c) => c.issue.id)),
      duration: 4000,
      action: { label: 'Undo', run: () => this.restore(before, Object.keys(changed[0].patch) as (keyof Snapshot)[]) },
    });
  }

  /** Put back snapshot fields (all restorable fields by default). */
  private restore(list: readonly Snapshot[], fields: readonly (keyof Snapshot)[] = ['status', 'workstreamIds']): void {
    for (const s of list) {
      const current = this.store.issueById().get(s.id);
      if (!current) continue;
      const patch: UpdateIssueInput = {};
      if (fields.includes('status') && current.status !== s.status) patch.status = s.status;
      if (fields.includes('priority') && current.priority !== s.priority) patch.priority = s.priority;
      if (fields.includes('assigneeId') && current.assigneeId !== s.assigneeId) patch.assigneeId = s.assigneeId ?? null;
      if (fields.includes('teamId') && current.teamId !== s.teamId) patch.teamId = s.teamId ?? null;
      if (fields.includes('workstreamIds') && current.workstreamIds.join() !== s.workstreamIds.join()) patch.workstreamIds = s.workstreamIds;
      if (Object.keys(patch).length) void this.store.updateIssue(s.id, patch);
    }
  }
}
