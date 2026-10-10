import type { ActorRef, SubjectRef } from '../contracts/domain.js';
import type {
  ArtifactEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  ProjectUpdateEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';

/** An artifact reached from the project plus the chain Project → Workstream → Issue that leads to its owner. */
export interface ProjectContextArtifactRow {
  artifact: ArtifactEntity;
  path: SubjectRef[];
}

/** Wire shape is `ProjectContext` from the shared contracts (entities serialize to it through `toJSON`). */
export interface ProjectContextData {
  project: ProjectEntity;
  milestones: MilestoneEntity[];
  updates: ProjectUpdateEntity[];
  workstreams: WorkstreamEntity[];
  issues: IssueEntity[];
  artifacts: ProjectContextArtifactRow[];
  decisions: DecisionEntity[];
  inputRequests: InputRequestEntity[];
}

export interface ProjectContextRows {
  project: ProjectEntity;
  milestones: readonly MilestoneEntity[];
  updates: readonly ProjectUpdateEntity[];
  /** Candidates: anything fetched is filtered again against the tree, so supersets are fine. */
  workstreams: readonly WorkstreamEntity[];
  issues: readonly IssueEntity[];
  artifacts: readonly ArtifactEntity[];
  decisions: readonly DecisionEntity[];
  inputRequests: readonly InputRequestEntity[];
}

const byNumber = <T extends { number: number }>(a: T, b: T) => a.number - b.number;

/**
 * Builds the tree Project → Workstream (workstream.projectId) → Issue (issue.workstreamIds) → Artifact, plus
 * Project → Issue (issue.projectId) → Artifact, and drops everything that is not reachable from the project.
 *
 * An artifact with several owners appears once, under its highest owner (project > workstream > issue);
 * among several workstreams/issues of the same level the shortest chain, then the lowest key wins.
 */
export function assembleProjectContext(rows: ProjectContextRows): ProjectContextData {
  const { project } = rows;
  const workstreams = rows.workstreams.filter((w) => w.projectId === project.id).sort(byNumber);
  const wsById = new Map(workstreams.map((w) => [w.id, w]));

  const issues = rows.issues
    .filter((i) => i.projectId === project.id || i.workstreamIds.some((id) => wsById.has(id)))
    .sort(byNumber);
  const issueById = new Map(issues.map((i) => [i.id, i]));

  const ref = (type: SubjectRef['type'], id: string): SubjectRef => ({ type, id });
  const projectRef = ref('project', project.id);

  /** Chains from the project to an issue, shortest first: [P, I] when planned under the project, then [P, W, I]. */
  const issueChains = (issue: IssueEntity): SubjectRef[][] => {
    const chains: SubjectRef[][] = [];
    if (issue.projectId === project.id) chains.push([projectRef, ref('issue', issue.id)]);
    for (const w of issue.workstreamIds
      .map((id) => wsById.get(id))
      .filter((w): w is WorkstreamEntity => !!w)
      .sort(byNumber))
      chains.push([projectRef, ref('workstream', w.id), ref('issue', issue.id)]);
    return chains;
  };

  const seen = new Set<string>();
  const artifacts: ProjectContextArtifactRow[] = [];
  for (const artifact of [...rows.artifacts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    if (seen.has(artifact.id)) continue;
    let path: SubjectRef[] | undefined;
    if (artifact.projectId === project.id) path = [projectRef];
    else if (artifact.workstreamId && wsById.has(artifact.workstreamId)) path = [projectRef, ref('workstream', artifact.workstreamId)];
    else if (artifact.issueId && issueById.has(artifact.issueId)) path = issueChains(issueById.get(artifact.issueId)!)[0];
    if (!path) continue;
    seen.add(artifact.id);
    artifacts.push({ artifact, path });
  }

  const decisions = rows.decisions
    .filter((d) => d.originWorkstreamId && wsById.has(d.originWorkstreamId))
    .sort(byNumber);
  const inputRequests = rows.inputRequests
    .filter((r) => r.state === 'open' && wsById.has(r.workstreamId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return {
    project,
    milestones: rows.milestones.filter((m) => m.projectId === project.id).sort((a, b) => a.sortOrder - b.sortOrder),
    updates: rows.updates.filter((u) => u.projectId === project.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    workstreams,
    issues,
    artifacts,
    decisions,
    inputRequests,
  };
}

// ───────────────────────────── markdown briefing ─────────────────────────────

/** Per-section caps so one huge project cannot blow up an agent's context. */
export const CONTEXT_CAPS = {
  updates: 3,
  milestones: 20,
  workstreams: 30,
  issues: 40,
  artifacts: 40,
  decisions: 20,
  inputRequests: 20,
  /** Characters kept of a free-text body (description, update, statement). */
  text: 600,
} as const;

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');
const words = (s: string) => s.replace(/_/g, ' ');
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const CLOSED_ISSUE = new Set(['done', 'canceled']);

export interface ProjectContextNames {
  /** actor/user id → display name */
  names?: ReadonlyMap<string, string>;
}

/** Markdown briefing of the whole project, in the style of the workstream agent context. */
export function projectContextMarkdown(ctx: ProjectContextData, opts: ProjectContextNames = {}): string {
  const p = ctx.project;
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push(`## ${title}`, '', ...lines, '');
  };
  /** Lines capped with a trailing "… N more". */
  const capped = <T>(items: readonly T[], cap: number, line: (item: T) => string): string[] => [
    ...items.slice(0, cap).map(line),
    ...(items.length > cap ? [`- … ${items.length - cap} more`] : []),
  ];
  const nameOf = (a?: ActorRef | null) => (a?.id ? (opts.names?.get(a.id) ?? a.id) : 'system');

  const wsById = new Map(ctx.workstreams.map((w) => [w.id, w]));
  const issueById = new Map(ctx.issues.map((i) => [i.id, i]));
  const label = (s: SubjectRef): string => {
    if (s.type === 'project') return p.name;
    if (s.type === 'workstream') return wsById.get(s.id)?.key ?? s.id;
    if (s.type === 'issue') return issueById.get(s.id)?.key ?? s.id;
    return s.id;
  };

  out.push(`# Project — ${p.name}`, '');
  const meta = [
    `Status: ${words(p.status)}`,
    `Priority: ${p.priority}`,
    p.health ? `Health: ${words(p.health)}` : '',
    p.leadId && opts.names?.get(p.leadId) ? `Lead: ${opts.names.get(p.leadId)}` : '',
    p.startDate ? `Start: ${day(p.startDate)}` : '',
    p.targetDate ? `Target: ${day(p.targetDate)}` : '',
  ].filter(Boolean);
  out.push(meta.join(' · '), '');
  section('Summary', [p.summary?.trim() || '', p.description?.trim() ? oneLine(p.description, CONTEXT_CAPS.text * 3) : ''].filter(Boolean));

  section(
    'Recent updates',
    capped(ctx.updates, CONTEXT_CAPS.updates, (u) => `- ${day(u.createdAt)} — ${nameOf(u.author)} (${words(u.health)}): ${oneLine(u.body, CONTEXT_CAPS.text)}`),
  );
  section(
    'Milestones',
    capped(ctx.milestones, CONTEXT_CAPS.milestones, (m) => {
      const linked = ctx.issues.filter((i) => i.milestoneIds.includes(m.id));
      const done = linked.filter((i) => i.status === 'done').length;
      return `- ${m.name}${m.targetDate ? ` (target ${day(m.targetDate)})` : ''}${linked.length ? ` — ${done}/${linked.length} issues done` : ''}`;
    }),
  );
  section(
    'Workstreams',
    capped(ctx.workstreams, CONTEXT_CAPS.workstreams, (w) => {
      const linked = ctx.issues.filter((i) => i.workstreamIds.includes(w.id));
      return `- ${w.key} ${w.title} (${words(w.status)}${w.statusOverride ? ' (pinned manually)' : ''}${w.delivery && w.delivery !== 'none' ? `, delivery ${words(w.delivery)}` : ''}${w.targetDate ? `, target ${day(w.targetDate)}` : ''}${linked.length ? `, ${linked.length} issues` : ''})${w.objective.trim() ? ` — ${oneLine(w.objective, 160)}` : ''}`;
    }),
  );

  const open = ctx.issues.filter((i) => !CLOSED_ISSUE.has(i.status));
  const closed = ctx.issues.length - open.length;
  section('Open issues', [
    ...capped(open, CONTEXT_CAPS.issues, (i) => {
      const where = i.workstreamIds.map((id) => wsById.get(id)?.key).filter((k): k is string => !!k);
      return `- ${i.key} ${i.title} (${i.kind}, ${words(i.status)}${i.priority !== 'none' ? `, ${i.priority}` : ''}${where.length ? `, in ${where.join(' ')}` : ''})`;
    }),
    ...(closed ? [`_${closed} more issues are done or canceled._`] : []),
  ]);

  // Artifacts grouped by the chain that leads to their owner: "Project › WS-1 › BUG-12".
  const groups = new Map<string, ProjectContextData['artifacts']>();
  for (const row of ctx.artifacts) {
    const key = row.path.map(label).join(' › ');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const artifactLines: string[] = [];
  let shown = 0;
  for (const [chain, rows] of groups) {
    if (shown >= CONTEXT_CAPS.artifacts) break;
    const take = rows.slice(0, CONTEXT_CAPS.artifacts - shown);
    shown += take.length;
    artifactLines.push(`### ${chain}`, '');
    for (const { artifact: a } of take) {
      const bits = [a.state, a.ci ? `CI ${a.ci}` : '', a.review && a.review !== 'none' ? `review ${words(a.review)}` : '', a.hasConflicts ? 'has conflicts' : '', a.environment ?? ''].filter(Boolean);
      artifactLines.push(
        `- ${words(a.kind)}${a.externalId ? ` ${a.externalId}` : ''}: ${a.title}${a.url ? ` — ${a.url}` : ''} (${bits.join(', ')})${a.description?.trim() ? ` — ${oneLine(a.description, 200)}` : ''}`,
      );
    }
    artifactLines.push('');
  }
  if (ctx.artifacts.length > shown) artifactLines.push(`- … ${ctx.artifacts.length - shown} more`);
  section('Artifacts', artifactLines.length && artifactLines[artifactLines.length - 1] === '' ? artifactLines.slice(0, -1) : artifactLines);

  const liveDecisions = ctx.decisions.filter((d) => d.status !== 'rejected' && d.status !== 'draft');
  section(
    'Decisions',
    capped(liveDecisions, CONTEXT_CAPS.decisions, (d) => {
      const origin = d.originWorkstreamId ? wsById.get(d.originWorkstreamId)?.key : undefined;
      const state = d.status === 'accepted' ? '' : d.status === 'superseded' ? ' — superseded; do not follow' : ` — ${d.status}, not yet accepted`;
      return `- ${d.key} ${d.title}: ${oneLine(d.statement, CONTEXT_CAPS.text)}${origin ? ` (from ${origin})` : ''}${state}`;
    }),
  );
  section(
    'Open input requests',
    capped(ctx.inputRequests, CONTEXT_CAPS.inputRequests, (r) => {
      const origin = wsById.get(r.workstreamId)?.key;
      return `- ${origin ? `${origin}: ` : ''}${oneLine(r.question, 300)}${r.options?.length ? ` [options: ${r.options.join(' / ')}]` : ''}`;
    }),
  );
  return `${out.join('\n').trimEnd()}\n`;
}
