// Milestone writes shared by the project page, issue rows, the issue property and the timeline:
// create / rename / dates / delete (with Undo) / reorder and assigning issues. Milestones belong to a
// project, and an issue is in at most one milestone per project, so assigning replaces the previous one.
import { Injectable, inject } from '@angular/core';
import { NablaStore, Notifier, type Issue, type Milestone } from '../../core';
import type { PickOption } from '../workstreams/picker';
import { isoOfDay } from './milestone-model';

/** Local calendar day of `d`, stored at noon so every time zone shows the same day. */
export const isoFromDate = (d: Date): string => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString();

@Injectable({ providedIn: 'root' })
export class MilestoneActions {
  private readonly store = inject(NablaStore);
  private readonly notify = inject(Notifier);

  create(projectId: string, name: string, targetDate?: string): Promise<Milestone | undefined> {
    const n = name.trim();
    if (!n) return Promise.resolve(undefined);
    return this.store.createMilestone({ projectId, name: n, targetDate });
  }

  rename(ms: Milestone, name: string): void {
    const n = name.trim();
    if (n && n !== ms.name) void this.store.updateMilestone(ms.id, { name: n });
  }

  setDescription(ms: Milestone, text: string): void {
    void this.store.updateMilestone(ms.id, { description: text.trim() || null });
  }

  /** `null` clears the date. */
  setDate(ms: Milestone, date: Date | null): void {
    const iso = date ? isoFromDate(date) : null;
    if ((ms.targetDate ?? null) === iso) return;
    void this.store.updateMilestone(ms.id, { targetDate: iso });
  }

  setDay(ms: Milestone, day: number): void {
    void this.store.updateMilestone(ms.id, { targetDate: isoOfDay(day) });
  }

  /** Move by `delta` positions inside its project. */
  move(ms: Milestone, delta: number): void {
    const ids = (this.store.milestonesByProject().get(ms.projectId) ?? []).map((m) => m.id);
    const from = ids.indexOf(ms.id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from < 0 || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void this.store.reorderMilestones(ms.projectId, ids);
  }

  async remove(ms: Milestone): Promise<void> {
    const issueIds = (this.store.issuesByMilestone().get(ms.id) ?? []).map((i) => i.id);
    if (!(await this.store.deleteMilestone(ms.id))) return;
    this.notify.success(`Deleted milestone “${ms.name}”`, {
      description: issueIds.length ? `${issueIds.length} issue${issueIds.length === 1 ? '' : 's'} no longer in a milestone.` : undefined,
      action: {
        label: 'Undo',
        run: async () => {
          const back = await this.store.createMilestone({
            projectId: ms.projectId,
            name: ms.name,
            description: ms.description,
            targetDate: ms.targetDate,
            sortOrder: ms.sortOrder,
          });
          if (!back) return;
          for (const id of issueIds) {
            const i = this.store.getIssue(id);
            if (i) await this.store.updateIssue(id, { milestoneIds: [...(i.milestoneIds ?? []), back.id] });
          }
        },
      },
    });
  }

  /** Put an issue into a milestone of `projectId` (or none), replacing that project's previous one. */
  assign(issue: Issue, projectId: string, milestoneId: string | null): void {
    const keep = (issue.milestoneIds ?? []).filter((id) => this.store.getMilestone(id)?.projectId !== projectId);
    const next = milestoneId ? [...keep, milestoneId] : keep;
    const cur = issue.milestoneIds ?? [];
    if (next.length === cur.length && next.every((id) => cur.includes(id))) return;
    void this.store.updateIssue(issue.id, { milestoneIds: next });
  }

  /** The milestone of `projectId` an issue is in. */
  milestoneOf(issue: Issue, projectId: string): Milestone | undefined {
    for (const id of issue.milestoneIds ?? []) {
      const m = this.store.getMilestone(id);
      if (m && m.projectId === projectId) return m;
    }
    return undefined;
  }

  /** Picker options for one project's milestones. */
  options(projectId: string): PickOption[] {
    return (this.store.milestonesByProject().get(projectId) ?? []).map((m, i) => ({
      value: m.id,
      label: m.name,
      hint: m.targetDate ? shortDay(m.targetDate) : `M${i + 1}`,
      search: `M${i + 1} ${m.name}`,
    }));
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDay(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
