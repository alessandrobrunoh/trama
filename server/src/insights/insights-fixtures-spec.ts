// Test fixtures for the insights rules. Not imported by production code.
import type {
  IArtifact,
  ICustomerRequest,
  IDecision,
  IInputRequest,
  IIssue,
  IMilestone,
  IShippedWorkstream,
  IWorkstream,
  SignalData,
} from './insights-signals.js';
import { DAY } from './insights-util.js';

export const NOW = new Date('2026-10-09T12:00:00.000Z');

/** A date `days` before NOW. */
export const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

export const NAMES = new Map<string, { name: string; type: 'user' | 'agent' }>([
  ['u_ada', { name: 'Ada', type: 'user' }],
  ['u_bob', { name: 'Bob', type: 'user' }],
  ['ag_bot', { name: 'Bot', type: 'agent' }],
]);

let n = 0;
const id = (p: string) => `${p}_${++n}`;

export function ws(over: Partial<IWorkstream> = {}): IWorkstream {
  const k = ++n;
  return {
    id: `wk_${k}`,
    key: `AUTH-${k}`,
    title: `Workstream ${k}`,
    status: 'working',
    delivery: 'none',
    ownerTeamId: 'tm_1',
    accountableUserId: 'u_ada',
    projectId: null,
    startDate: null,
    targetDate: null,
    createdAt: ago(40),
    updatedAt: ago(1),
    shippedAt: null,
    acceptanceCriteria: [],
    ...over,
  };
}

/** A shipped workstream as the proof check reads it: derived by default, with one proven criterion. */
export function shipped(over: Partial<IShippedWorkstream> = {}): IShippedWorkstream {
  const k = ++n;
  return {
    id: `wk_${k}`,
    key: `AUTH-${k}`,
    title: `Shipped ${k}`,
    status: 'shipped',
    derivedStatus: 'shipped',
    statusOverride: null,
    legacyShipped: false,
    accountableUserId: 'u_ada',
    shippedAt: ago(60),
    updatedAt: ago(60),
    acceptanceCriteria: [{ state: 'met', evidence: { artifactIds: ['ar_1'] } }],
    ...over,
  };
}

export function issue(over: Partial<IIssue> = {}): IIssue {
  const k = ++n;
  return {
    id: `in_${k}`,
    key: `FEAT-${k}`,
    title: `Issue ${k}`,
    kind: 'feature',
    status: 'in_progress',
    assigneeId: 'u_ada',
    teamId: 'tm_1',
    projectId: null,
    workstreamIds: [],
    milestoneIds: [],
    createdAt: ago(20),
    startedAt: ago(10),
    completedAt: null,
    updatedAt: ago(1),
    ...over,
  };
}

export function pr(over: Partial<IArtifact> = {}): IArtifact {
  return {
    id: id('ar'),
    workstreamId: null,
    kind: 'pull_request',
    title: 'Add thing',
    externalId: '#12',
    state: 'open',
    ci: 'passing',
    review: 'requested',
    hasConflicts: false,
    authorRef: { type: 'user', id: 'u_bob' },
    createdAt: ago(10),
    updatedAt: ago(1),
    ...over,
  };
}

export function decision(over: Partial<IDecision> = {}): IDecision {
  const k = ++n;
  return {
    id: `dc_${k}`,
    key: `ADR-${k}`,
    title: `Decision ${k}`,
    status: 'proposed',
    originWorkstreamId: null,
    relatedWorkstreamIds: [],
    proposedBy: { type: 'user', id: 'u_bob' },
    createdAt: ago(2),
    ...over,
  };
}

export function question(over: Partial<IInputRequest> = {}): IInputRequest {
  return {
    id: id('ir'),
    workstreamId: 'wk_x',
    question: 'Which provider?',
    requestedBy: { type: 'agent', id: 'ag_bot' },
    assigneeUserId: null,
    createdAt: ago(2),
    ...over,
  };
}

export function milestone(over: Partial<IMilestone> = {}): IMilestone {
  return {
    id: id('ms'),
    name: 'Beta',
    projectId: 'pj_1',
    projectName: 'Launch',
    projectStatus: 'in_progress',
    targetDate: ago(5),
    openIssues: 3,
    doneIssues: 2,
    ...over,
  };
}

export function demand(over: Partial<ICustomerRequest> = {}): ICustomerRequest {
  return {
    customerName: 'Acme',
    important: false,
    createdAt: ago(40),
    targetType: 'issue',
    targetId: 'in_1',
    targetKey: 'FEAT-1',
    targetTitle: 'SSO',
    ...over,
  };
}

export function emptyData(over: Partial<SignalData> = {}): SignalData {
  return {
    now: NOW,
    rangeFrom: ago(30),
    staleDays: 7,
    names: NAMES,
    workstreams: [],
    shippedHistory: [],
    facts: new Map(),
    issues: [],
    inputRequests: [],
    artifacts: [],
    decisions: [],
    dependencies: [],
    milestones: [],
    issueLinks: [],
    customerRequests: [],
    ...over,
  };
}
