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
  WORKSTREAM_STATUSES,
  WORKSTREAM_STATUS_META,
  type ActorRef,
  type Artifact,
  type NablaStore,
  type Workstream,
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
}

export const isPr = (a: Artifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';
export const isOpenPr = (a: Artifact): boolean => isPr(a) && (a.state === 'open' || a.state === 'draft');

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
  const people: ActorRef[] = ws.accountableUserId ? [{ type: 'user', id: ws.accountableUserId }] : [];
  return {
    ws,
    criteriaMet: ws.acceptanceCriteria.filter((c) => c.state === 'met').length,
    criteriaInProgress: ws.acceptanceCriteria.filter((c) => c.state === 'in_progress').length,
    criteriaTotal: ws.acceptanceCriteria.length,
    openPrs: arts.filter(isOpenPr),
    mergedPrs: arts.filter((a) => isPr(a) && a.state === 'merged').length,
    performers: uniqueActors(people),
    openInputs: (store.inputRequestsByWorkstream().get(ws.id) ?? []).filter((r) => r.state === 'open').length,
  };
}

// ───────────────────────── picker options ─────────────────────────

export const statusOptions = (): PickOption[] =>
  WORKSTREAM_STATUSES.map((s) => ({ value: s, label: WORKSTREAM_STATUS_META[s].label, kind: 'status' }));

export const priorityOptions = (): PickOption[] =>
  PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label, kind: 'priority' }));

export const providerOptions = (): PickOption[] =>
  PROVIDERS.map((p) => ({ value: p, label: PROVIDER_META[p].label, kind: 'provider' }));

export const teamOptions = (store: NablaStore): PickOption[] =>
  store.teams().map((t) => ({ value: t.id, label: t.name, kind: 'team', hint: t.key }));

export const userOptions = (store: NablaStore): PickOption[] =>
  store.users().map((u) => ({ value: u.id, label: u.name, kind: 'user', search: `${u.name} ${u.email}` }));

export const repoOptions = (store: NablaStore): PickOption[] =>
  store.repositories().map((r) => ({ value: r.id, label: r.fullName, kind: 'repo', provider: r.provider }));

export const labelOptions = (store: NablaStore): PickOption[] => {
  const set = new Set<string>();
  for (const w of store.workstreams()) for (const l of w.labels) set.add(l);
  return [...set].sort().map((l) => ({ value: l, label: l, kind: 'label' }));
};

/** Users + agents + teams as performer options (`type:id` values). */
export const performerOptions = (store: NablaStore): PickOption[] => [
  ...store.users().map((u) => ({ value: `user:${u.id}`, label: u.name, kind: 'actor' as const, hint: 'person' })),
  ...store.agents().map((a) => ({ value: `agent:${a.id}`, label: a.name, kind: 'actor' as const, hint: 'agent' })),
  ...store.teams().map((t) => ({ value: `team:${t.id}`, label: t.name, kind: 'actor' as const, hint: 'team' })),
];

// ───────────────────────── derived-status explanation ─────────────────────────

const prLabel = (a: Artifact): string => (a.externalId ? `${a.externalId}` : a.title);

/**
 * Plain-language reasons why the server derived `ws.derivedStatus` (rules of PLAN.md §2,
 * evaluated client-side from executions / artifacts / input requests / decisions / dependencies).
 */
export function explainStatus(store: NablaStore, ws: Workstream): { headline: string; reasons: string[] } {
  const arts = store.artifactsByWorkstream().get(ws.id) ?? [];
  const inputs = (store.inputRequestsByWorkstream().get(ws.id) ?? []).filter((r) => r.state === 'open');
  const decisions = (store.decisionsByWorkstream().get(ws.id) ?? []).filter(
    (d) => d.status === 'proposed' && d.originWorkstreamId === ws.id,
  );
  const incoming = store.incomingDependencies().get(ws.id) ?? [];
  const prs = arts.filter(isPr);
  const openPrs = prs.filter(isOpenPr);
  const reasons: string[] = [];
  const s = ws.derivedStatus;

  switch (s) {
    case 'shipped': {
      const dep = arts.find((a) => a.kind === 'deployment' && a.state === 'healthy');
      const rel = arts.find((a) => a.kind === 'release' && a.state === 'published');
      if (dep) reasons.push(`${dep.title} is healthy${dep.environment ? ` in ${dep.environment}` : ''}.`);
      else if (rel) reasons.push(`Release ${rel.title} is published.`);
      else reasons.push('Every pull request is merged.');
      break;
    }
    case 'blocked': {
      for (const a of openPrs.filter((x) => x.ci === 'failing')) reasons.push(`${prLabel(a)} has failing CI.`);
      for (const a of openPrs.filter((x) => x.hasConflicts)) reasons.push(`${prLabel(a)} has merge conflicts.`);
      for (const d of incoming) {
        if (d.fromType === 'workstream') {
          const from = store.getWorkstream(d.fromId);
          if (from && from.status !== 'shipped') reasons.push(`Waiting on ${from.key} (${WORKSTREAM_STATUS_META[from.status].label.toLowerCase()}).`);
        }
      }
      break;
    }
    case 'needs_input': {
      if (inputs.length) reasons.push(`${inputs.length} open input request${inputs.length > 1 ? 's' : ''}: “${inputs[0].question}”`);
      for (const d of decisions) reasons.push(`${d.key} “${d.title}” is proposed and awaiting a decision.`);
      break;
    }
    case 'ready_to_land': {
      const a = openPrs.find((x) => x.review === 'approved' && x.ci === 'passing');
      reasons.push(a ? `${prLabel(a)} is approved with passing CI and no conflicts.` : 'A pull request is approved with passing CI.');
      break;
    }
    case 'in_review': {
      for (const a of openPrs.slice(0, 2)) reasons.push(`${prLabel(a)} is open for review.`);
      break;
    }
    case 'working':
      reasons.push('Work is in progress: a criterion is underway, or there is a branch, commit, or build.');
      break;
    case 'planned':
      reasons.push(`${ws.acceptanceCriteria.length} acceptance criteri${ws.acceptanceCriteria.length === 1 ? 'on' : 'a'}, and nothing is in review yet.`);
      break;
    case 'draft':
      reasons.push('No acceptance criteria and no code artifacts yet.');
      break;
    default:
      break;
  }
  if (!reasons.length) reasons.push('Computed from this workstream’s executions, artifacts and input requests.');
  const headline = ws.statusOverride
    ? `Manually set to ${WORKSTREAM_STATUS_META[ws.statusOverride].label}. Derived status would be ${WORKSTREAM_STATUS_META[s].label}.`
    : `${WORKSTREAM_STATUS_META[s].label}, derived from the work.`;
  return { headline, reasons: reasons.slice(0, 4) };
}

/** Artifact kinds in group display order for the Artifacts tab. */
export const ARTIFACT_GROUPS: { id: string; title: string; kinds: Artifact['kind'][] }[] = [
  { id: 'pr', title: 'Pull & merge requests', kinds: ['pull_request', 'merge_request'] },
  { id: 'commit', title: 'Commits & branches', kinds: ['commit', 'branch'] },
  { id: 'doc', title: 'Documents', kinds: ['document'] },
  { id: 'design', title: 'Designs', kinds: ['design'] },
  { id: 'build', title: 'Builds & tests', kinds: ['build', 'test_report'] },
  { id: 'deploy', title: 'Deployments', kinds: ['deployment'] },
  { id: 'release', title: 'Releases', kinds: ['release'] },
];
export const artifactKindLabel = (k: Artifact['kind']): string => ARTIFACT_KIND_META[k].label;
export const decisionStatusLabel = (s: keyof typeof DECISION_STATUS_META): string => DECISION_STATUS_META[s].label;
