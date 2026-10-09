// Plain issue + milestone records for the "time and estimates" analytics. Built once per stats model
// from the store; the maths lives in perf.ts and never touches the store.
import type { Issue, IssueKind, IssueStatus, TramaStore, Priority, Workstream } from '../../core';

export interface WorkRec {
  id: string;
  key: string;
  title: string;
  kind: IssueKind;
  priority: Priority;
  status: IssueStatus;
  teamId?: string;
  assigneeId?: string;
  /** Story points; undefined = not estimated. */
  estimate?: number;
  created: number;
  /** First entry into in_progress / in_review. Missing on issues that predate start tracking. */
  started?: number;
  /** Only set for done / canceled issues. */
  completed?: number;
  workstreamIds: string[];
}

export interface MilestoneRec {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  /** The project's workstreams inside the current filter. */
  workstreamIds: string[];
  /** End of the target day, ms. */
  target?: number;
  sortOrder: number;
  issueIds: string[];
}

export interface WorkData {
  issues: WorkRec[];
  milestones: MilestoneRec[];
  workstreams: { id: string; key: string; title: string; teamId: string; accountableId?: string }[];
}

export const EMPTY_WORK: WorkData = { issues: [], milestones: [], workstreams: [] };

function ts(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** A date-only target means "by the end of that day". */
function endOfDay(iso: string | undefined): number | undefined {
  const t = ts(iso);
  if (t === undefined) return undefined;
  return iso && iso.length <= 10 ? t + 86_400_000 - 1 : t;
}

export function buildWork(store: TramaStore, issues: readonly Issue[], workstreams: readonly Workstream[]): WorkData {
  const recs: WorkRec[] = [];
  for (const i of issues) {
    const created = ts(i.createdAt);
    if (created === undefined) continue;
    recs.push({
      id: i.id,
      key: i.key,
      title: i.title,
      kind: i.kind,
      priority: i.priority,
      status: i.status,
      teamId: i.teamId,
      assigneeId: i.assigneeId,
      estimate: typeof i.estimate === 'number' && Number.isFinite(i.estimate) ? i.estimate : undefined,
      created,
      started: ts(i.startedAt),
      completed: ts(i.completedAt),
      workstreamIds: i.workstreamIds,
    });
  }
  const byMilestone = store.issuesByMilestone();
  // Milestones belong to projects: keep those of a project that has a workstream in the current filter.
  const wsByProject = new Map<string, string[]>();
  for (const w of workstreams) if (w.projectId) wsByProject.set(w.projectId, [...(wsByProject.get(w.projectId) ?? []), w.id]);
  const milestones: MilestoneRec[] = store
    .milestones()
    .filter((m) => wsByProject.has(m.projectId))
    .map((m) => {
      return {
        id: m.id,
        name: m.name,
        projectId: m.projectId,
        projectName: store.getProject(m.projectId)?.name ?? 'Project',
        workstreamIds: wsByProject.get(m.projectId) ?? [],
        target: endOfDay(m.targetDate),
        sortOrder: m.sortOrder,
        issueIds: (byMilestone.get(m.id) ?? []).map((i) => i.id),
      };
    });
  return {
    issues: recs,
    milestones,
    workstreams: workstreams.map((w) => ({
      id: w.id,
      key: w.key,
      title: w.title,
      teamId: w.ownerTeamId,
      accountableId: w.accountableUserId ?? undefined,
    })),
  };
}
