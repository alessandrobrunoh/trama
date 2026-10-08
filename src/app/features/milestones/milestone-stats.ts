// Shared, memoised milestone progress: one computed over the store so lists, chips and the
// timeline never recompute it per row.
import { Injectable, computed, inject } from '@angular/core';
import { NablaStore, type Milestone } from '../../core';
import { milestoneStats, milestoneState, usesPoints, todayDay, type MilestoneState, type MilestoneStats } from './milestone-model';

export interface NextMilestone {
  ms: Milestone;
  /** 1-based position inside the workstream: "M2". */
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

  readonly stats = computed(() => {
    const out = new Map<string, MilestoneStats>();
    const byMs = this.store.issuesByMilestone();
    const pts = this.pointsByWorkstream();
    for (const m of this.store.milestones()) out.set(m.id, milestoneStats(byMs.get(m.id) ?? [], pts.get(m.workstreamId) ?? false));
    return out;
  });

  readonly states = computed(() => {
    const today = todayDay();
    const out = new Map<string, MilestoneState>();
    const stats = this.stats();
    for (const m of this.store.milestones()) out.set(m.id, milestoneState(m, stats.get(m.id)!, today));
    return out;
  });

  /** First milestone of each workstream that is not complete yet. */
  readonly nextByWorkstream = computed(() => {
    const out = new Map<string, NextMilestone>();
    const stats = this.stats();
    const states = this.states();
    for (const [wsId, list] of this.store.milestonesByWorkstream()) {
      const i = list.findIndex((m) => !stats.get(m.id)?.complete);
      if (i >= 0) out.set(wsId, { ms: list[i], n: i + 1, stats: stats.get(list[i].id)!, state: states.get(list[i].id)! });
    }
    return out;
  });

  /** "M2" for a milestone. */
  ordinal(ms: Milestone): string {
    const list = this.store.milestonesByWorkstream().get(ms.workstreamId) ?? [];
    return `M${Math.max(1, list.findIndex((m) => m.id === ms.id) + 1)}`;
  }
}
