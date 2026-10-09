// Issue mutations shared by the list, board, context menu, bulk bar, keyboard and detail page.
// Every bulk-capable action takes ids, applies optimistic store writes and offers Undo.
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  BranchNames,
  Clipboard,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  TramaStore,
  Notifier,
  PRIORITY_META,
  UiStore,
  type BulkIssuePatch,
  type Issue,
  type IssueKind,
  type IssueStatus,
  type Priority,
  type UpdateIssueInput,
} from '../../core';

/** What the keyboard / bulk command dialog edits. */
export type IssuePromptField = 'status' | 'priority' | 'assignee' | 'team' | 'project' | 'label' | 'workstream' | 'duplicate';

export interface IssuePrompt {
  field: IssuePromptField;
  ids: string[];
}


@Injectable({ providedIn: 'root' })
export class IssueActions {
  private readonly store = inject(TramaStore);
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

  setProject(ids: readonly string[], projectId: string | null): void {
    const name = projectId ? (this.store.getProject(projectId)?.name ?? 'project') : null;
    this.patchMany(ids, (i) => ((i.projectId ?? null) === projectId ? null : { projectId }), name ? `Moved to project ${name}` : 'Project cleared');
  }

  /** Add the label when not every issue has it yet, otherwise remove it from all. */
  toggleLabel(ids: readonly string[], labelId: string): void {
    const list = this.issues(ids);
    if (!list.length) return;
    const name = this.store.settings().labels.find((l) => l.id === labelId)?.name ?? 'label';
    if (list.every((i) => i.labels.includes(labelId))) {
      this.patchMany(ids, (i) => (i.labels.includes(labelId) ? { removeLabels: [labelId] } : null), `Label ${name} removed`);
    } else {
      this.patchMany(ids, (i) => (i.labels.includes(labelId) ? null : { addLabels: [labelId] }), `Label ${name} added`);
    }
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
   * the issue status is left unchanged). Canceled issues are attached with a plain update,
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
    const done = list.map((i) => i.id);
    void this.run(done, { addWorkstreamIds: [ws.id] });
    this.notifier.success(`${this.subject(done)} added to ${ws.key}`, {
      description: ws.title,
      action: { label: 'Undo', run: () => void this.run(done, { removeWorkstreamIds: [ws.id] }) },
    });
  }

  unlink(ids: readonly string[], workstreamId: string): void {
    const ws = this.store.getWorkstream(workstreamId);
    const list = this.issues(ids).filter((i) => i.workstreamIds.includes(workstreamId));
    if (!list.length) return;
    const done = list.map((i) => i.id);
    void this.run(done, { removeWorkstreamIds: [workstreamId] });
    this.notifier.success(`${this.subject(done)} removed from ${ws?.key ?? 'workstream'}`, {
      action: { label: 'Undo', run: () => void this.run(done, { addWorkstreamIds: [workstreamId] }) },
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
    const beforeStatus = issue.status;
    void this.store.updateIssue(issue.id, { duplicateOfId: target.id, status: 'canceled' });
    this.notifier.success(`${issue.key} marked as duplicate of ${target.key}`, {
      description: 'It is canceled; follow the original instead.',
      action: {
        label: 'Undo',
        run: () => void this.store.updateIssue(issue.id, { duplicateOfId: null, status: beforeStatus }),
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

  /**
   * Delete right away from the UI and on the server after a short grace period, with an Undo toast
   * (one atomic request for the whole selection). `after` runs once the issues are gone from the UI.
   */
  remove(ids: readonly string[], after?: () => void): void {
    const list = this.issues(ids);
    if (!list.length || !this.store.allowed('deleteIssues')) return;
    const staged = this.store.stageIssueDelete(list.map((i) => i.id));
    if (!staged) return;
    const gone = new Set(list.map((i) => i.id));
    this.ui.setSelected(this.ui.selectedRowIds().filter((id) => !gone.has(id)));
    after?.();
    const label = list.length === 1 ? `${list[0].key} deleted` : `${list.length} issues deleted`;
    this.notifier.success(label, {
      description: list.length === 1 ? list[0].title : undefined,
      duration: 6000,
      action: { label: 'Undo', run: () => staged.cancel() },
    });
  }

  // ───────────────────────── internals ─────────────────────────

  /** One atomic bulk request. */
  private run(ids: readonly string[], patch: BulkIssuePatch): Promise<boolean> {
    return this.store.bulkUpdateIssues(ids, patch);
  }

  /**
   * Apply `patch(issue)` (null = unchanged) to each issue with ONE atomic request per distinct patch;
   * bulk changes offer Undo, which puts every issue back to what it had.
   */
  private patchMany(ids: readonly string[], patch: (i: Issue) => BulkIssuePatch | null, title: string): void {
    const changed: { issue: Issue; patch: BulkIssuePatch }[] = [];
    for (const issue of this.issues(ids)) {
      const p = patch(issue);
      if (p) changed.push({ issue, patch: p });
    }
    if (!changed.length) return;
    // The patch is the same for every issue by construction; group defensively by its JSON.
    const groups = new Map<string, { ids: string[]; patch: BulkIssuePatch }>();
    for (const c of changed) {
      const k = JSON.stringify(c.patch);
      const g = groups.get(k) ?? { ids: [], patch: c.patch };
      g.ids.push(c.issue.id);
      groups.set(k, g);
    }
    const before = changed.map((c) => c.issue);
    for (const g of groups.values()) void this.run(g.ids, g.patch);
    // Single inline edits are visible in place; bulk edits get a toast with Undo.
    if (changed.length === 1) return;
    this.notifier.success(title, {
      description: this.subject(changed.map((c) => c.issue.id)),
      duration: 4000,
      action: { label: 'Undo', run: () => void this.undo(before, changed[0].patch) },
    });
  }

  /** Inverse of `patch` for the issues as they were `before`: scalar fields grouped by their old value. */
  private async undo(before: readonly Issue[], patch: BulkIssuePatch): Promise<void> {
    const scalars = ['status', 'priority', 'assigneeId', 'teamId', 'projectId'] as const;
    for (const field of scalars) {
      if (patch[field] === undefined) continue;
      const groups = new Map<string, string[]>();
      for (const i of before) {
        const old = (i[field] ?? null) as string | null;
        const k = old ?? '\0null';
        groups.set(k, [...(groups.get(k) ?? []), i.id]);
      }
      for (const [k, ids] of groups) await this.store.bulkUpdateIssues(ids, { [field]: k === '\0null' ? null : k });
    }
    const inverse: [keyof BulkIssuePatch, keyof BulkIssuePatch][] = [
      ['addLabels', 'removeLabels'],
      ['removeLabels', 'addLabels'],
    ];
    for (const [from, to] of inverse) {
      for (const l of patch[from] ?? []) {
        const had = from === 'removeLabels';
        const ids = before.filter((i) => i.labels.includes(l) === had).map((i) => i.id);
        if (ids.length) await this.store.bulkUpdateIssues(ids, { [to]: [l] });
      }
    }
  }
}
