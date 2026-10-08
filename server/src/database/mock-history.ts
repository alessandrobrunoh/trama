// Deterministic mock issue history for the "Estimates & time" statistics (and the milestone burn-up).
//
// Pure: no database access. `generateMockHistory()` takes a snapshot of the workspace (members, teams,
// workstreams, existing issues, issue counters) and returns rows to insert plus a few patches for existing
// issues. Used by the demo seed (`createSeed`) and by the `db:mock-estimates` CLI (scripts/mock-estimates.ts).
//
// Everything it creates is tagged by a deterministic id prefix (`in_mock_`, `ev_mock_`, `ms_mock_`), so reruns
// can skip it and `--remove` can delete exactly it. A seeded PRNG makes the shape reproducible; all dates are
// relative to `ctx.now`.
import {
  ISSUE_KEY_PREFIX,
  type ActorRef,
  type EstimateScale,
  type IssueKind,
  type IssueSource,
  type IssueStatus,
  type Priority,
} from '../contracts/domain.js';
import type { DomainEventEntity, IssueEntity, MilestoneEntity } from './entities/index.js';
import type { SeedData } from './seed/builder.js';

export const MOCK_ISSUE_PREFIX = 'in_mock_';
export const MOCK_EVENT_PREFIX = 'ev_mock_';
export const MOCK_MILESTONE_PREFIX = 'ms_mock_';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ESTIMATE_VALUES: Record<string, readonly number[]> = {
  fibonacci: [1, 2, 3, 5, 8, 13],
  linear: [1, 2, 3, 4, 5, 6],
  exponential: [1, 2, 4, 8, 16],
  tshirt: [1, 2, 3, 5, 8],
  none: [1, 2, 3, 5, 8, 13],
};

export interface MockWorkstream {
  id: string;
  key?: string;
  projectId?: string | null;
  ownerTeamId: string;
  status: string;
}

export interface MockExistingIssue {
  id: string;
  kind: IssueKind;
  priority: Priority;
  status: IssueStatus;
  estimate: number | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface MockContext {
  now: number;
  workspaceId: string;
  /** Workspace estimate scale (default fibonacci). */
  estimateScale?: EstimateScale;
  /** People who can own issues (no viewers). */
  userIds: readonly string[];
  teamIds: readonly string[];
  workstreams: readonly MockWorkstream[];
  /** Milestones that already exist (they may receive some mock issues). */
  milestones: readonly { id: string; projectId: string }[];
  /** Last used issue number per kind. */
  issueCounters: Partial<Record<IssueKind, number>>;
  /** Real issues (not mock ones): they only get missing estimates / started / completed timestamps. */
  existingIssues: readonly MockExistingIssue[];
  seed?: number;
}

export interface MockIssuePatch {
  id: string;
  set: Partial<Pick<IssueEntity, 'estimate' | 'startedAt' | 'completedAt'>>;
}

export interface MockHistory {
  issues: Partial<IssueEntity>[];
  events: Partial<DomainEventEntity>[];
  milestones: Partial<MilestoneEntity>[];
  patches: MockIssuePatch[];
  /** `issue:<kind>` → new last number */
  counters: Record<string, number>;
}

// ───────────────────────────── PRNG ─────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, for stable per-id choices. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  f(): number {
    return this.next();
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r < 0) return v;
    }
    return items[items.length - 1][0];
  }
  normal(): number {
    const u = Math.max(1e-9, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  shuffle<T>(list: readonly T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

// ───────────────────────────── content ─────────────────────────────

const TITLES: Record<IssueKind, readonly string[]> = {
  bug: [
    'Pagination skips a row when sorting by date',
    'Avatar upload fails for files over 4 MB',
    'Tooltip stays open after route change',
    'Duplicate notification emails on retry',
    'Timezone shown wrong in the activity feed',
    'Search ignores accented characters',
    'CSV export truncates long descriptions',
    'Date picker closes on first click in Firefox',
    'Race condition when two people edit the same issue',
    'Webhook signature check fails on empty body',
    'Dropdown clipped inside scrollable panel',
    'Stale cache after changing workspace settings',
    'Keyboard shortcut conflicts with browser find',
    'Wrong count on the sidebar badge',
    'Rate limiter counts health checks',
    'Dark theme: low contrast on disabled buttons',
  ],
  feature: [
    'Saved filters on the issue board',
    'Bulk edit for selected issues',
    'Slack digest for blocked workstreams',
    'Inline editing of estimates',
    'Keyboard-first command palette actions',
    'Workstream templates',
    'Per-team notification preferences',
    'Export statistics as CSV',
    'Pin favourite views to the sidebar',
    'Public read-only share links for workstreams',
    'Recurring issue templates',
    'Cycle-time target per team',
    'Subscribe to a milestone',
    'Compact density mode for lists',
  ],
  tech_debt: [
    'Replace hand-rolled retry with a shared helper',
    'Split the 900-line issues service',
    'Drop unused feature flags from the config',
    'Upgrade the ORM and fix deprecations',
    'Consolidate duplicate date utilities',
    'Remove legacy REST v0 handlers',
    'Add missing indexes on events table',
    'Typed event payloads end to end',
    'Move cron jobs out of the web process',
    'Clean up flaky integration tests',
  ],
  security: [
    'Rotate signing keys and add kid support',
    'Sanitise markdown rendered in comments',
    'Enforce MFA for admin roles',
    'Audit log for token creation',
    'Tighten CORS allow-list',
    'Dependency bump for CVE in the markdown parser',
    'Session fixation on SSO callback',
  ],
  incident: [
    'Search latency spike after deploy',
    'Queue backlog on the webhook worker',
    'Database failover took 9 minutes',
    'Elevated 502s behind the load balancer',
    'Certificate expiry on the staging gateway',
    'Event stream disconnects every 60 seconds',
  ],
  feedback: [
    'Customers ask for dark mode in emails',
    'Request: keep filters when reloading',
    'Confusing empty state on the first workstream',
    'Ask for per-person workload view',
    'Want to export decisions as PDF',
  ],
  idea: [
    'Weekly retro summary written by an agent',
    'Estimate suggestions from past cycle times',
    'Auto-link pull requests to issues by branch name',
    'Team health score on the overview',
    'Show forecast ranges instead of single dates',
  ],
};

const SOURCE_WEIGHTS: readonly (readonly [IssueSource, number])[] = [
  ['manual', 40],
  ['github', 25],
  ['api', 10],
  ['agent', 10],
  ['email', 10],
  ['gitlab', 5],
];
const CUSTOMERS = ['Globex', 'Initech', 'Hooli', 'Umbrella', 'Stark Industries', 'Wayne Corp'];
const PRIORITY_WEIGHTS: readonly (readonly [Priority, number])[] = [
  ['none', 5],
  ['low', 20],
  ['medium', 40],
  ['high', 25],
  ['urgent', 10],
];
const DONE_KIND_WEIGHTS: readonly (readonly [IssueKind, number])[] = [
  ['bug', 32],
  ['feature', 28],
  ['tech_debt', 16],
  ['security', 9],
  ['incident', 9],
  ['feedback', 3],
  ['idea', 3],
];
const OPEN_KIND_WEIGHTS: readonly (readonly [IssueKind, number])[] = [
  ['bug', 25],
  ['feature', 25],
  ['tech_debt', 12],
  ['security', 8],
  ['incident', 6],
  ['feedback', 12],
  ['idea', 12],
];

// ───────────────────────────── generation ─────────────────────────────

interface Plan {
  outcome: 'done' | 'in_progress' | 'in_review' | 'canceled' | 'todo' | 'backlog';
  kind: IssueKind;
  /** Index into the estimate scale, or null for "no estimate". */
  tier: number | null;
  createdAt: number;
  startedAt?: number;
  reviewAt?: number;
  todoAt?: number;
  /** done / canceled time */
  endedAt?: number;
  /** canceled before anyone started */
  neverStarted?: boolean;
}

const ISO = (ms: number): Date => new Date(ms);

export function generateMockHistory(ctx: MockContext): MockHistory {
  const rng = new Rng(ctx.seed ?? 20_261_007);
  const values = ESTIMATE_VALUES[ctx.estimateScale ?? 'fibonacci'] ?? ESTIMATE_VALUES['fibonacci'];
  const nTier = values.length;
  const now = ctx.now;
  const ago = (days: number): number => now - days * DAY;
  const out: MockHistory = { issues: [], events: [], milestones: [], patches: patchesFor(ctx, values), counters: {} };
  if (!ctx.userIds.length) return out;

  // ── estimate tiers: bell-shaped over the scale, every tier at least 3 times among done issues
  const tierWeights = values.map((_, i) => {
    const f = nTier > 1 ? i / (nTier - 1) : 0;
    return Math.exp(-(((f - 0.4) / 0.3) ** 2)) + 0.15;
  });
  const drawTier = (): number => rng.weighted(tierWeights.map((w, i) => [i, w] as const));

  const plans: Plan[] = [];

  // ── done: completions spread over 12 weeks with uneven velocity (index 0 = last 7 days)
  const doneByWeek = [5, 5, 3, 5, 5, 4, 4, 3, 3, 3, 2, 1];
  const doneCount = doneByWeek.reduce((a, b) => a + b, 0);
  const unestimatedDone = Math.max(1, Math.round(doneCount * 0.15));
  const estimatedDone = doneCount - unestimatedDone;
  const tiersForDone: number[] = [];
  const base = Math.min(3, Math.floor(estimatedDone / nTier));
  for (let t = 0; t < nTier; t++) for (let k = 0; k < base; k++) tiersForDone.push(t);
  while (tiersForDone.length < estimatedDone) tiersForDone.push(drawTier());
  const doneTiers: (number | null)[] = rng.shuffle([...tiersForDone, ...Array<null>(unestimatedDone).fill(null)]);
  let doneIdx = 0;
  for (let w = 0; w < doneByWeek.length; w++) {
    for (let k = 0; k < doneByWeek[w]; k++) {
      const tier = doneTiers[doneIdx++];
      const dayOffset = w * 7 + rng.range(0.4, 6.6);
      let endedAt = startOfUtcDay(ago(dayOffset)) + rng.range(8, 19) * HOUR;
      if (endedAt > now - HOUR) endedAt -= DAY;
      const est = tier === null ? undefined : values[tier];
      const median = est === undefined ? 3 : 0.9 * est ** 0.95;
      const outlier = tier !== null && rng.chance(0.15);
      let cycle = outlier ? median * rng.range(2.3, 4) * Math.exp(rng.normal() * 0.12) : median * Math.exp(rng.normal() * (tier === null ? 0.6 : 0.33));
      cycle = Math.min(40, Math.max(0.15, cycle));
      let wait = 6 * rng.f() ** 1.4;
      // keep the whole story inside ~13 weeks
      const room = (endedAt - ago(90)) / DAY;
      if (cycle + wait > room) {
        const k = room / (cycle + wait);
        cycle *= k;
        wait *= k;
      }
      const startedAt = endedAt - cycle * DAY;
      const createdAt = startedAt - wait * DAY;
      plans.push({
        outcome: 'done',
        kind: rng.weighted(DONE_KIND_WEIGHTS),
        tier,
        createdAt,
        startedAt,
        endedAt,
        todoAt: wait > 0.8 && rng.chance(0.7) ? createdAt + wait * rng.range(0.2, 0.6) * DAY : undefined,
        reviewAt: cycle > 0.5 && rng.chance(0.55) ? endedAt - Math.min(cycle * 0.3, 2) * DAY : undefined,
      });
    }
  }

  // ── still running for a long time ("currently dragging")
  const longRunning: [number, number | null][] = [
    [34, 1], [27, null], [21, 2], [16, 2], [12, 3], [9, 4],
  ];
  for (const [days, t] of longRunning) {
    const startedAt = ago(days + rng.range(-1, 1));
    plans.push({
      outcome: 'in_progress',
      kind: rng.weighted(DONE_KIND_WEIGHTS),
      tier: t === null ? null : Math.min(t, nTier - 1),
      createdAt: startedAt - 6 * rng.f() ** 1.4 * DAY,
      startedAt,
    });
  }
  // ── in review
  for (const [days, t] of [[13, 3], [7, 2], [4, 4]] as const) {
    const startedAt = ago(days + rng.range(-0.5, 0.5));
    plans.push({
      outcome: 'in_review',
      kind: rng.weighted(DONE_KIND_WEIGHTS),
      tier: Math.min(t, nTier - 1),
      createdAt: startedAt - 6 * rng.f() ** 1.4 * DAY,
      startedAt,
      reviewAt: startedAt + (now - startedAt) * rng.range(0.55, 0.85),
    });
  }
  // ── canceled
  const canceledSpecs: { created: number; neverStarted: boolean; kind: IssueKind }[] = [
    { created: 62, neverStarted: false, kind: 'feature' },
    { created: 41, neverStarted: true, kind: 'idea' },
    { created: 24, neverStarted: true, kind: 'feedback' },
  ];
  for (const c of canceledSpecs) {
    const createdAt = ago(c.created);
    const startedAt = c.neverStarted ? undefined : createdAt + rng.range(1, 4) * DAY;
    plans.push({
      outcome: 'canceled',
      kind: c.kind,
      tier: c.neverStarted ? null : drawTier(),
      createdAt,
      startedAt,
      endedAt: (startedAt ?? createdAt) + rng.range(3, 12) * DAY,
      neverStarted: c.neverStarted,
    });
  }
  // ── todo / backlog
  for (const days of [2, 5, 11]) {
    const createdAt = ago(days + rng.f());
    plans.push({ outcome: 'todo', kind: rng.weighted(OPEN_KIND_WEIGHTS), tier: rng.chance(0.7) ? drawTier() : null, createdAt, todoAt: createdAt + rng.range(0.2, 1) * DAY });
  }
  for (const days of [1, 4, 9, 20, 45, 63]) {
    plans.push({ outcome: 'backlog', kind: rng.weighted(OPEN_KIND_WEIGHTS), tier: rng.chance(0.4) ? drawTier() : null, createdAt: ago(days + rng.f()) });
  }

  // ── workstream / milestone layout
  const eligible = ctx.workstreams.filter((w) => w.status !== 'canceled' && w.status !== 'draft');
  const active = eligible.filter((w) => ['working', 'in_review', 'ready_to_land', 'needs_input', 'blocked', 'planned'].includes(w.status));
  const pool = active.length >= 2 ? active : eligible;
  const sorted = [...pool].sort((a, b) => (a.key ?? a.id).localeCompare(b.key ?? b.id));
  const focusA = sorted.find((w) => w.status === 'working') ?? sorted[0];
  const focusB = sorted.find((w) => w.id !== focusA?.id && w.ownerTeamId !== focusA?.ownerTeamId) ?? sorted.find((w) => w.id !== focusA?.id);
  const mockMilestones: { id: string; workstreamId: string; target: number }[] = [];
  // Milestones belong to a project, so only workstreams that carry out one can get them.
  const addMilestone = (n: number, ws: MockWorkstream, name: string, description: string, targetDays: number, createdDays: number) => {
    if (!ws.projectId) return;
    const id = `${MOCK_MILESTONE_PREFIX}${n}`;
    const target = ago(-targetDays);
    mockMilestones.push({ id, workstreamId: ws.id, target });
    out.milestones.push({
      id, workspaceId: ctx.workspaceId, projectId: ws.projectId, name, description, targetDate: roundTo10Utc(target), sortOrder: 100 + n,
      createdAt: ISO(ago(createdDays)), updatedAt: ISO(ago(createdDays)),
    });
    out.events.push({
      id: `${MOCK_EVENT_PREFIX}ms_${n}`, workspaceId: ctx.workspaceId, at: ISO(ago(createdDays)), actor: { type: 'user', id: ctx.userIds[0] },
      type: 'milestone.created', subject: { type: 'milestone', id }, workstreamId: null, data: { name, projectId: ws.projectId },
    });
  };
  if (focusA) {
    addMilestone(1, focusA, 'Private beta', 'First customers on the new flow.', -9, 80);
    addMilestone(2, focusA, 'General availability', 'Everything needed to open it to all workspaces.', 17, 80);
  }
  if (focusB) addMilestone(3, focusB, 'Hardening pass', 'Performance, edge cases and rollout checks.', 26, 70);

  // ── turn plans into rows
  const titlePool: Record<string, number> = {};
  const nextTitle = (kind: IssueKind): string => {
    const list = TITLES[kind];
    const n = titlePool[kind] ?? 0;
    titlePool[kind] = n + 1;
    const base = list[(n + hash(kind)) % list.length];
    return n >= list.length ? `${base} (follow-up ${Math.floor(n / list.length)})` : base;
  };
  const numbers: Partial<Record<IssueKind, number>> = { ...ctx.issueCounters };
  const people = ctx.userIds;
  const personWeights = people.map((_, i) => [i, [3, 3, 2, 2, 2, 1][i] ?? 1] as const);
  const person = (): string => people[rng.weighted(personWeights)];
  const ordered = [...plans].sort((a, b) => a.createdAt - b.createdAt);

  ordered.forEach((p, n) => {
    const id = `${MOCK_ISSUE_PREFIX}${String(n + 1).padStart(2, '0')}`;
    const number = (numbers[p.kind] ?? 0) + 1;
    numbers[p.kind] = number;
    const key = `${ISSUE_KEY_PREFIX[p.kind]}-${number}`;
    const title = nextTitle(p.kind);
    const source = rng.weighted(SOURCE_WEIGHTS);
    const external = source === 'email' || source === 'api';
    const reporter = external ? undefined : person();
    const assignee = p.outcome === 'backlog' ? (rng.chance(0.3) ? person() : undefined) : rng.chance(0.93) ? person() : undefined;
    const actorOf = (): ActorRef => ({ type: 'user', id: assignee ?? reporter ?? person() });
    const creator: ActorRef = reporter ? { type: 'user', id: reporter } : { type: 'system' };

    // workstreams
    const linkP = { done: 0.85, in_progress: 1, in_review: 1, canceled: 0, todo: 0.7, backlog: 0.2 }[p.outcome];
    const wsIds: string[] = [];
    if (eligible.length && rng.chance(linkP)) {
      const first =
        focusA && focusB
          ? rng.weighted([[focusA, 35], [focusB, 25], [rng.pick(eligible), 40]] as const)
          : focusA ?? rng.pick(eligible);
      wsIds.push(first.id);
      if (eligible.length > 1 && rng.chance(0.08)) {
        const other = rng.pick(eligible);
        if (other.id !== first.id) wsIds.push(other.id);
      }
    }
    const firstWs = ctx.workstreams.find((w) => w.id === wsIds[0]);
    const teamId = firstWs && rng.chance(0.8) ? firstWs.ownerTeamId : ctx.teamIds.length ? rng.pick(ctx.teamIds) : null;

    // milestones (one per workstream)
    const milestoneIds: string[] = [];
    if (p.outcome !== 'canceled' && p.outcome !== 'backlog')
      for (const w of wsIds) {
        const mine = mockMilestones.filter((m) => m.workstreamId === w);
        if (mine.length === 2) {
          const [m1, m2] = mine;
          milestoneIds.push(p.outcome === 'done' && p.endedAt! < m1.target ? m1.id : m2.id);
        } else if (mine.length === 1) {
          if (rng.chance(0.85)) milestoneIds.push(mine[0].id);
        } else {
          const projectId = ctx.workstreams.find((x) => x.id === w)?.projectId;
          const existing = projectId ? ctx.milestones.filter((m) => m.projectId === projectId) : [];
          if (existing.length && rng.chance(0.6)) milestoneIds.push(rng.pick(existing).id);
        }
      }

    // status path: [at, from, to]
    const path: [number, IssueStatus, IssueStatus][] = [];
    let cur: IssueStatus = 'backlog';
    const go = (at: number, to: IssueStatus) => {
      path.push([Math.min(at, now - 60_000), cur, to]);
      cur = to;
    };
    if (p.todoAt !== undefined) go(p.todoAt, 'todo');
    if (p.startedAt !== undefined) go(p.startedAt, 'in_progress');
    if (p.outcome === 'in_review' || (p.outcome === 'done' && p.reviewAt !== undefined)) go(p.reviewAt!, 'in_review');
    if (p.outcome === 'done') go(p.endedAt!, 'done');
    if (p.outcome === 'canceled') go(p.endedAt!, 'canceled');

    const startedAt = path.find(([, , to]) => to === 'in_progress' || to === 'in_review')?.[0];
    const completedAt = path.find(([, , to]) => to === 'done' || to === 'canceled')?.[0];
    const last = path.length ? path[path.length - 1][0] : p.createdAt;
    out.issues.push({
      id,
      workspaceId: ctx.workspaceId,
      key,
      number,
      kind: p.kind,
      title,
      body: null,
      source,
      reporterName: external ? (source === 'email' ? `Customer: ${rng.pick(CUSTOMERS)}` : `Support: Zendesk #${rng.int(4000, 4700)}`) : null,
      reporterId: reporter ?? null,
      assigneeId: assignee ?? null,
      teamId,
      priority: rng.weighted(PRIORITY_WEIGHTS),
      status: p.outcome,
      workstreamIds: wsIds,
      milestoneIds,
      aliases: [],
      estimate: p.tier === null ? null : values[p.tier],
      startedAt: startedAt === undefined ? null : ISO(startedAt),
      completedAt: completedAt === undefined ? null : ISO(completedAt),
      duplicateOfId: null,
      externalUrl: source === 'github' ? `https://github.com/acme/app/issues/${100 + number}` : null,
      createdAt: ISO(p.createdAt),
      updatedAt: ISO(last),
    });

    // events
    let seq = 0;
    const subject = { type: 'issue' as const, id };
    const push = (at: number, actor: ActorRef, type: string, workstreamId: string | null, data: Record<string, unknown>) => {
      out.events.push({ id: `${MOCK_EVENT_PREFIX}${id.slice(MOCK_ISSUE_PREFIX.length)}_${seq++}`, workspaceId: ctx.workspaceId, at: ISO(Math.min(at, now - 30_000)), actor, type, subject, workstreamId, data });
    };
    push(p.createdAt, creator, 'issue.created', null, { key, kind: p.kind, title, status: 'backlog' });
    if (p.tier !== null && rng.chance(0.6)) push(p.createdAt + 5 * 60_000 + rng.range(0, 0.4) * HOUR, actorOf(), 'issue.updated', null, { key, fields: ['estimate'] });
    const firstMove = path.length ? path[0][0] : now;
    for (const w of wsIds)
      push(Math.min(firstMove - 60_000, p.createdAt + Math.max(0.1, (firstMove - p.createdAt) / DAY * rng.range(0.1, 0.5)) * DAY), actorOf(), 'issue.linked', w, { key, workstreamIds: wsIds });
    for (const [at, from, to] of path) push(at, actorOf(), 'issue.status_changed', wsIds[0] ?? null, { key, from, to });
  });

  for (const [kind, n] of Object.entries(numbers) as [IssueKind, number][])
    if (n !== (ctx.issueCounters[kind] ?? 0)) out.counters[`issue:${kind}`] = n;
  return out;
}

// ───────────────────────────── existing issues ─────────────────────────────

const KIND_TIER: Record<IssueKind, number> = { bug: 1, feature: 3, incident: 2, tech_debt: 2, security: 2, feedback: 1, idea: 2 };

/** Missing estimates and timestamps of real issues. Deterministic per issue id, and a no-op once filled. */
function patchesFor(ctx: MockContext, values: readonly number[]): MockIssuePatch[] {
  const patches: MockIssuePatch[] = [];
  for (const i of ctx.existingIssues) {
    if (i.id.startsWith(MOCK_ISSUE_PREFIX)) continue;
    const set: MockIssuePatch['set'] = {};
    if (i.estimate === null && i.status !== 'canceled') {
      const h = hash(i.id);
      const shift = i.priority === 'urgent' || i.priority === 'high' ? 1 : i.priority === 'low' ? -1 : 0;
      const tier = Math.max(0, Math.min(values.length - 1, KIND_TIER[i.kind] + shift + ((h % 3) - 1)));
      set.estimate = values[tier];
    }
    const running = i.status === 'in_progress' || i.status === 'in_review' || i.status === 'done';
    const start = i.startedAt ?? (running ? new Date(Math.min(ctx.now - 60_000, i.createdAt.getTime() + Math.min(DAY, Math.max(HOUR, i.updatedAt.getTime() - i.createdAt.getTime())))) : null);
    if (running && !i.startedAt && start) set.startedAt = start;
    if (i.status === 'done' && !i.completedAt) {
      const end = Math.min(ctx.now - 60_000, Math.max(i.updatedAt.getTime(), (start ?? i.createdAt).getTime() + HOUR));
      set.completedAt = new Date(end);
    }
    if (Object.keys(set).length) patches.push({ id: i.id, set });
  }
  return patches;
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

function roundTo10Utc(ms: number): Date {
  return new Date(startOfUtcDay(ms) + 10 * HOUR);
}

// ───────────────────────────── demo seed ─────────────────────────────

/** Appends the mock history to a freshly built demo seed (same data the `db:mock-estimates` CLI adds to a dev DB). */
export function addMockHistoryToSeed(data: SeedData, now: number): void {
  const workspaceId = data.workspace.id as string;
  const roleOf = new Map(data.memberships.map((m) => [m.userId as string, m.role]));
  const counters: Partial<Record<IssueKind, number>> = {};
  for (const kind of Object.keys(ISSUE_KEY_PREFIX) as IssueKind[]) counters[kind] = data.counters[`issue:${kind}`] ?? 0;
  const history = generateMockHistory({
    now,
    workspaceId,
    estimateScale: resolveScale(data.workspace.settings?.estimateScale),
    userIds: data.users.map((u) => u.id as string).filter((id) => roleOf.get(id) !== 'viewer'),
    teamIds: data.teams.map((t) => t.id as string),
    workstreams: data.workstreams.map((w) => ({ id: w.id as string, key: w.key, ownerTeamId: w.ownerTeamId as string, status: w.status as string, projectId: (w.projectId as string | null | undefined) ?? null })),
    milestones: data.milestones.map((m) => ({ id: m.id as string, projectId: m.projectId as string })),
    issueCounters: counters,
    existingIssues: data.issues.map((i) => ({
      id: i.id as string,
      kind: i.kind as IssueKind,
      priority: i.priority as Priority,
      status: i.status as IssueStatus,
      estimate: i.estimate ?? null,
      createdAt: i.createdAt as Date,
      updatedAt: i.updatedAt as Date,
      startedAt: (i.startedAt as Date | null) ?? null,
      completedAt: (i.completedAt as Date | null) ?? null,
    })),
  });
  for (const patch of history.patches) Object.assign(data.issues.find((i) => i.id === patch.id)!, patch.set);
  data.issues.push(...history.issues);
  data.events.push(...history.events);
  data.milestones.push(...history.milestones);
  for (const [name, value] of Object.entries(history.counters)) data.counters[name] = Math.max(data.counters[name] ?? 0, value);
}

export function resolveScale(scale: string | undefined): EstimateScale {
  return (scale && scale in ESTIMATE_VALUES ? scale : 'fibonacci') as EstimateScale;
}
