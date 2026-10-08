// Shared, memoised milestone progress: one computed over the store so lists, chips and the
// timeline never recompute it per row.
import { Injectable, computed, inject } from '@angular/core';
import { NablaStore, type Milestone } from '../../core';
import { milestoneStats, milestoneState, usesPoints, todayDay, type MilestoneState, type MilestoneStats } from './milestone-model';

export interface NextMilestone {
  ms: Milestone;
  /** 1-based position inside the project: "M2". */
  n: number;
  stats: MilestoneStats;
  state: MilestoneState;
}

@Injectable({ providedIn: 'root' })
export class MilestoneInfo {
  private readonly store = inject(NablaStore);

  /** Whether a workstream measures progress in points (else issue counts). */
  readonly pointsByWorkstream = computed(() => {
    const scale = this.store.estimateScale();
    const map = new Map<string, boolean>();
    for (const [id, issues] of this.store.issuesByWorkstream()) map.set(id, usesPoints(issues, scale));
    return map;
  });

  /** Whether a project measures progress in points (else issue counts). */
  readonly pointsByProject = computed(() => {
    const scale = this.store.estimateScale();
    const map = new Map<string, boolean>();
    for (const [id, issues] of this.store.issuesByProject()) map.set(id, usesPoints(issues, scale));
    return map;
  });

  readonly stats = computed(() => {
    const out = new Map<string, MilestoneStats>();
    const byMs = this.store.issuesByMilestone();
    const pts = this.pointsByProject();
    for (const m of this.store.milestones()) out.set(m.id, milestoneStats(byMs.get(m.id) ?? [], pts.get(m.projectId) ?? false));
    return out;
  });

  readonly states = computed(() => {
    const today = todayDay();
    const out = new Map<string, MilestoneState>();
    const stats = this.stats();
    for (const m of this.store.milestones()) out.set(m.id, milestoneState(m, stats.get(m.id)!, today));
    return out;
  });

  /** First milestone of each project that is not complete yet. */
  readonly nextByProject = computed(() => {
    const out = new Map<string, NextMilestone>();
    const stats = this.stats();
    const states = this.states();
    for (const [wsId, list] of this.store.milestonesByProject()) {
      const i = list.findIndex((m) => !stats.get(m.id)?.complete);
      if (i >= 0) out.set(wsId, { ms: list[i], n: i + 1, stats: stats.get(list[i].id)!, state: states.get(list[i].id)! });
    }
    return out;
  });

  /** The next open milestone of the project a workstream carries out. */
  readonly nextByWorkstream = computed(() => {
    const byProject = this.nextByProject();
    const out = new Map<string, NextMilestone>();
    for (const w of this.store.workstreams()) {
      const next = w.projectId ? byProject.get(w.projectId) : undefined;
      if (next) out.set(w.id, next);
    }
    return out;
  });

  /** "M2" for a milestone. */
  ordinal(ms: Milestone): string {
    const list = this.store.milestonesByProject().get(ms.projectId) ?? [];
    return `M${Math.max(1, list.findIndex((m) => m.id === ms.id) + 1)}`;
  }
}
