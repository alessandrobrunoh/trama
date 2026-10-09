// Pure helpers shared by the workstream list, board, detail and execution screens:
// per-workstream summaries (criteria progress, PR signals, performers), picker option
// builders and the client-side explanation of a derived status (PLAN.md §2).
import {
  ARTIFACT_KIND_META,
  DECISION_STATUS_META,
  PRIORITIES,
  PRIORITY_META,
  PROVIDERS,
  PROVIDER_META,
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  WORKSTREAM_STATUSES,
  WORKSTREAM_STATUS_META,
  type ActorRef,
  type Artifact,
  type Issue,
  type IssueStatus,
  type NablaStore,
  type DeliveryState,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import type { PickOption } from './picker';

// ───────────────────────── summaries ─────────────────────────

export interface WsSummary {
  ws: Workstream;
  criteriaMet: number;
  criteriaInProgress: number;
  criteriaTotal: number;
  /** Open (non-draft, not merged/closed) PRs / MRs. */
  openPrs: Artifact[];
  mergedPrs: number;
  /** Accountable person, when set. */
  performers: ActorRef[];
  openInputs: number;
  /** Linked issues (demand this workstream resolves), canceled ones excluded. */
  issuesTotal: number;
  issuesDone: number;
  issuesActive: number;
  /** Unshipped workstreams this one waits on. */
  waitingOn: number;
}

export const isPr = (a: Artifact): boolean =>
  a.kind === 'pull_request' || a.kind === 'merge_request';
export const isOpenPr = (a: Artifact): boolean =>
  isPr(a) && (a.state === 'open' || a.state === 'draft');

function uniqueActors(list: ActorRef[]): ActorRef[] {
  const seen = new Set<string>();
  const out: ActorRef[] = [];
  for (const a of list) {
    const k = `${a.type}:${a.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function buildSummary(store: NablaStore, ws: Workstream): WsSummary {
  const arts = store.artifactsByWorkstream().get(ws.id) ?? [];
  const people: ActorRef[] = ws.accountableUserId
    ? [{ type: 'user', id: ws.accountableUserId }]
    : [];
  return {
    ws,
    criteriaMet: ws.acceptanceCriteria.filter((c) => c.state === 'met').length,
    criteriaInProgress: ws.acceptanceCriteria.filter((c) => c.state === 'in_progress').length,
    criteriaTotal: ws.acceptanceCriteria.length,
    openPrs: arts.filter(isOpenPr),
    mergedPrs: arts.filter((a) => isPr(a) && a.state === 'merged').length,
    performers: uniqueActors(people),
    openInputs: (store.inputRequestsByWorkstream().get(ws.id) ?? []).filter(
      (r) => r.state === 'open',
    ).length,
    ...issueCounts(store.issuesByWorkstream().get(ws.id) ?? []),
    waitingOn: (store.incomingDependencies().get(ws.id) ?? []).filter(
      (d) => d.fromType === 'workstream' && store.getWorkstream(d.fromId)?.status !== 'shipped',
    ).length,
  };
}

/** Issue progress of a workstream: done / active / total (canceled issues don't count). */
export function issueCounts(issues: readonly Issue[]): {
  issuesTotal: number;
  issuesDone: number;
  issuesActive: number;
} {
  let total = 0;
  let done = 0;
  let active = 0;
  for (const i of issues) {
    if (i.status === 'canceled') continue;
    total++;
    if (i.status === 'done') done++;
    else if (i.status === 'in_progress' || i.status === 'in_review') active++;
  }
  return { issuesTotal: total, issuesDone: done, issuesActive: active };
}

/** Token colour per issue status (issues reuse the workstream status palette). */
export const ISSUE_STATUS_COLOR: Record<IssueStatus, string> = {
  draft: 'var(--status-draft)',
  backlog: 'var(--status-draft)',
  todo: 'var(--status-planned)',
  in_progress: 'var(--status-working)',
  in_review: 'var(--status-in-review)',
  done: 'var(--status-shipped)',
  canceled: 'var(--status-canceled)',
};

/** Issue status breakdown in workflow order (only statuses that occur). */
export function issueBreakdown(
  issues: readonly Issue[],
): { status: IssueStatus; count: number; label: string }[] {
  const counts = new Map<IssueStatus, number>();
  for (const i of issues) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  return ISSUE_STATUSES.filter((s) => counts.has(s)).map((s) => ({
    status: s,
    count: counts.get(s)!,
    label: ISSUE_STATUS_META[s].label,
  }));
}

/**
 * People and agents who actually worked on a workstream (VISION §19): accountable person,
 * artifact authors, commenters, input requesters / answerers and assignees of linked issues.
 * Teams and the system actor are left out.
 */
export function contributors(store: NablaStore, ws: Workstream): ActorRef[] {
  const out: ActorRef[] = [];
  if (ws.accountableUserId) out.push({ type: 'user', id: ws.accountableUserId });
  for (const a of store.artifactsByWorkstream().get(ws.id) ?? [])
    if (a.authorRef) out.push(a.authorRef);
  for (const i of store.issuesByWorkstream().get(ws.id) ?? [])
    if (i.assigneeId) out.push({ type: 'user', id: i.assigneeId });
  out.push(...store.commentAuthorsFor({ type: 'workstream', id: ws.id }));
  for (const r of store.inputRequestsByWorkstream().get(ws.id) ?? []) {
    out.push(r.requestedBy);
    if (r.answeredById) out.push({ type: 'user', id: r.answeredById });
  }
  return uniqueActors(out.filter((a) => (a.type === 'user' || a.type === 'agent') && !!a.id));
}

// ───────────────────────── list view tabs ─────────────────────────

export type WsViewTab = 'active' | 'backlog' | 'shipped' | 'all';
export const WS_VIEW_TABS: {
  id: WsViewTab;
  label: string;
  statuses: WorkstreamStatus[] | null;
  hint: string;
}[] = [
  {
    id: 'active',
    label: 'Active',
    statuses: ['working', 'needs_input', 'in_review', 'blocked', 'ready_to_land'],
    hint: 'In flight: working, waiting for input, in review, blocked or ready to land',
  },
  {
    id: 'backlog',
    label: 'Planned',
    statuses: ['draft', 'planned'],
    hint: 'Drafts and planned outcomes nobody started yet',
  },
  {
    id: 'shipped',
    label: 'Shipped',
    statuses: ['shipped'],
    hint: 'Outcomes that reached production',
  },
  { id: 'all', label: 'All', statuses: null, hint: 'Every workstream, including canceled' },
];

// ───────────────────────── picker options ─────────────────────────

export const statusOptions = (): PickOption[] =>
  WORKSTREAM_STATUSES.map((s) => ({
    value: s,
    label: WORKSTREAM_STATUS_META[s].label,
    kind: 'status',
    statusEntity: 'workstream',
  }));

export const issueStatusOptions = (): PickOption[] =>
  ISSUE_STATUSES.map((s) => ({
    value: s,
    label: ISSUE_STATUS_META[s].label,
    kind: 'status',
    statusEntity: 'issue',
  }));

/** Issues as picker options (circle status glyph, key as hint). */
export const issueOptions = (issues: readonly Issue[]): PickOption[] =>
  issues.map((i) => ({
    value: i.id,
    label: i.title,
    kind: 'status',
    status: i.status,
    statusEntity: 'issue',
    hint: i.key,
    search: `${i.key} ${i.title}`,
  }));

/** Workstreams as picker options (hexagon status glyph, key as hint). */
export const workstreamOptions = (list: readonly Workstream[]): PickOption[] =>
  list.map((w) => ({
    value: w.id,
    label: w.title,
    kind: 'status',
    status: w.status,
    statusEntity: 'workstream',
    hint: w.key,
    search: `${w.key} ${w.title}`,
  }));

export const priorityOptions = (): PickOption[] =>
  PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label, kind: 'priority' }));

export const providerOptions = (): PickOption[] =>
  PROVIDERS.map((p) => ({ value: p, label: PROVIDER_META[p].label, kind: 'provider' }));

export const teamOptions = (store: NablaStore): PickOption[] =>
  store.teams().map((t) => ({ value: t.id, label: t.name, kind: 'team', hint: t.key }));

export const userOptions = (store: NablaStore): PickOption[] =>
  store
    .users()
    .map((u) => ({ value: u.id, label: u.name, kind: 'user', search: `${u.name} ${u.email}` }));

export const repoOptions = (store: NablaStore): PickOption[] =>
  store
    .repositories()
    .map((r) => ({ value: r.id, label: r.fullName, kind: 'repo', provider: r.provider }));

/** Open projects (plus `currentId` even when closed), for the Project picker. */
export const projectOptions = (store: NablaStore, currentId?: string | null): PickOption[] =>
  store
    .projects()
    .filter((p) => (p.status !== 'completed' && p.status !== 'canceled') || p.id === currentId)
    .map((p) => ({ value: p.id, label: p.name, kind: 'project' }));

/** Projects as filter options ("No project" first), closed ones included so old issues stay findable. */
export function projectFilterOptions(store: NablaStore): PickOption[] {
  return [
    { value: '', label: 'No project' },
    ...store
      .projects()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.id, label: p.name, kind: 'project' as const })),
  ];
}

/** Repositories a workstream of `projectId` may use: the project's own; everything when it has no project. */
export const repoOptionsIn = (store: NablaStore, projectId?: string | null): PickOption[] => {
  const project = store.getProject(projectId);
  const all = repoOptions(store);
  return project ? all.filter((o) => project.repositoryIds.includes(o.value)) : all;
};

export const labelOptions = (store: NablaStore): PickOption[] =>
  store.settings().labels.map((label) => ({ value: label.id, label: label.name, kind: 'label' as const, color: label.color }));

export const labelName = (store: NablaStore, id: string): string =>
  store.settings().labels.find((label) => label.id === id)?.name ?? id;

/** Users + agents + teams as performer options (`type:id` values). */
export const performerOptions = (store: NablaStore): PickOption[] => [
  ...store
    .users()
    .map((u) => ({ value: `user:${u.id}`, label: u.name, kind: 'actor' as const, hint: 'person' })),
  ...store
    .agents()
    .map((a) => ({ value: `agent:${a.id}`, label: a.name, kind: 'actor' as const, hint: 'agent' })),
  ...store
    .teams()
    .map((t) => ({ value: `team:${t.id}`, label: t.name, kind: 'actor' as const, hint: 'team' })),
];

// ───────────────────────── derived-status explanation ─────────────────────────

export const isDeliveredState = (d: DeliveryState): boolean =>
  d === 'merged' || d === 'released' || d === 'deployed';

function deliveryReason(d: DeliveryState, prs: Artifact[]): string {
  if (d === 'deployed') return 'A healthy deployment is live';
  if (d === 'released') return 'A release is published';
  const merged = prs.filter((p) => p.state === 'merged');
  return merged.length === 1
    ? `${prLabel(merged[0])} is merged`
    : `${merged.length} pull requests are merged`;
}

const prLabel = (a: Artifact): string => (a.externalId ? `${a.externalId}` : a.title);

/**
 * Plain-language reasons why the server derived `ws.derivedStatus` (rules of PLAN.md §2,
 * evaluated client-side from executions / artifacts / input requests / decisions / dependencies).
 */
export function explainStatus(
  store: NablaStore,
  ws: Workstream,
): { headline: string; reasons: string[] } {
  const arts = store.artifactsByWorkstream().get(ws.id) ?? [];
  const inputs = (store.inputRequestsByWorkstream().get(ws.id) ?? []).filter(
    (r) => r.state === 'open',
  );
  const decisions = (store.decisionsByWorkstream().get(ws.id) ?? []).filter(
    (d) => d.status === 'proposed' && d.originWorkstreamId === ws.id,
  );
  const incoming = store.incomingDependencies().get(ws.id) ?? [];
  const prs = arts.filter(isPr);
  const openPrs = prs.filter(isOpenPr);
  const linked = (store.issuesByWorkstream().get(ws.id) ?? []).filter(
    (i) => i.status !== 'canceled',
  );
  const reasons: string[] = [];
  const s = ws.derivedStatus;

  switch (s) {
    case 'shipped': {
      const dep = arts.find((a) => a.kind === 'deployment' && a.state === 'healthy');
      const rel = arts.find((a) => a.kind === 'release' && a.state === 'published');
      if (dep)
        reasons.push(`${dep.title} is healthy${dep.environment ? ` in ${dep.environment}` : ''}.`);
      else if (rel) reasons.push(`Release ${rel.title} is published.`);
      else if (linked.length > 0 && linked.every((i) => i.status === 'done'))
        reasons.push(
          linked.length === 1
            ? 'The linked issue is done.'
            : `All ${linked.length} linked issues are done.`,
        );
      else reasons.push('Every pull request is merged.');
      if (ws.acceptanceCriteria.length)
        reasons.push('All acceptance criteria are met, with no blockers or open questions.');
      break;
    }
    case 'blocked': {
      for (const a of openPrs.filter((x) => x.ci === 'failing'))
        reasons.push(`${prLabel(a)} has failing CI.`);
      for (const a of openPrs.filter((x) => x.hasConflicts))
        reasons.push(`${prLabel(a)} has merge conflicts.`);
      for (const d of incoming) {
        if (d.fromType === 'workstream') {
          const from = store.getWorkstream(d.fromId);
          if (from && from.status !== 'shipped')
            reasons.push(
              `Waiting on ${from.key} (${WORKSTREAM_STATUS_META[from.status].label.toLowerCase()}).`,
            );
        }
      }
      break;
    }
    case 'needs_input': {
      if (inputs.length)
        reasons.push(
          `${inputs.length} open input request${inputs.length > 1 ? 's' : ''}: “${inputs[0].question}”`,
        );
      for (const d of decisions)
        reasons.push(`${d.key} “${d.title}” is proposed and awaiting a decision.`);
      break;
    }
    case 'ready_to_land': {
      const a = openPrs.find((x) => x.review === 'approved' && x.ci === 'passing');
      reasons.push(
        a
          ? `${prLabel(a)} is approved with passing CI and no conflicts.`
          : 'A pull request is approved with passing CI.',
      );
      break;
    }
    case 'in_review': {
      for (const a of openPrs.slice(0, 2)) reasons.push(`${prLabel(a)} is open for review.`);
      const reviewing = linked.filter((i) => i.status === 'in_review').length;
      if (reviewing)
        reasons.push(
          reviewing === 1 ? 'An issue is in review.' : `${reviewing} issues are in review.`,
        );
      break;
    }
    case 'working':
      if (isDeliveredState(ws.delivery)) {
        reasons.push(`${deliveryReason(ws.delivery, prs)}, but the outcome is not achieved yet.`);
        const unmet = ws.acceptanceCriteria.filter((c) => c.state !== 'met').length;
        if (unmet)
          reasons.push(
            `${unmet} acceptance criteri${unmet === 1 ? 'on is' : 'a are'} not met.`,
          );
        const open = linked.filter((i) => i.status !== 'done').length;
        if (open) reasons.push(`${open} linked issue${open === 1 ? ' is' : 's are'} not done.`);
        break;
      }
      reasons.push(
        linked.some((i) => i.status === 'in_progress')
          ? 'An issue is in progress.'
          : 'Work is in progress: a criterion is underway, or there is a build or test report.',
      );
      break;
    case 'planned':
      reasons.push(
        `${ws.acceptanceCriteria.length} acceptance criteri${ws.acceptanceCriteria.length === 1 ? 'on' : 'a'}, and nothing is in review yet.`,
      );
      break;
    case 'draft':
      reasons.push('No acceptance criteria and no code artifacts yet.');
      break;
    default:
      break;
  }
  // Delivery evidence is shown separately; it never reads as "done" while the outcome is open.
  if (s !== 'shipped' && s !== 'working' && isDeliveredState(ws.delivery)) {
    const unmet = ws.acceptanceCriteria.filter((c) => c.state !== 'met').length;
    reasons.push(
      `${deliveryReason(ws.delivery, prs)}; the outcome is not achieved${unmet ? ` (${unmet} acceptance criteri${unmet === 1 ? 'on' : 'a'} not met)` : ''}.`,
    );
  }
  if (!reasons.length)
    reasons.push(
      'Computed from this workstream’s criteria, artifacts, input requests and dependencies.',
    );
  const headline = ws.statusOverride
    ? `Manually set to ${WORKSTREAM_STATUS_META[ws.statusOverride].label}. Derived status would be ${WORKSTREAM_STATUS_META[s].label}.`
    : `${WORKSTREAM_STATUS_META[s].label}, derived from the work.`;
  return { headline, reasons: reasons.slice(0, 4) };
}

/** Artifact kinds in group display order for the Artifacts tab. */
export const ARTIFACT_GROUPS: { id: string; title: string; kinds: Artifact['kind'][] }[] = [
  { id: 'pr', title: 'Pull & merge requests', kinds: ['pull_request', 'merge_request'] },
  { id: 'doc', title: 'Documents', kinds: ['document'] },
  { id: 'design', title: 'Designs', kinds: ['design'] },
  { id: 'build', title: 'Builds & tests', kinds: ['build', 'test_report'] },
  { id: 'deploy', title: 'Deployments', kinds: ['deployment'] },
  { id: 'release', title: 'Releases', kinds: ['release'] },
];
export const artifactKindLabel = (k: Artifact['kind']): string => ARTIFACT_KIND_META[k].label;
export const decisionStatusLabel = (s: keyof typeof DECISION_STATUS_META): string =>
  DECISION_STATUS_META[s].label;
