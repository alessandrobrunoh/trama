// Pure logic behind the Updates tab of a project (v3 "App · 10 Project · Updates"): the milestone windows, the
// key events of a milestone built from what the app already records (status changes, tasks added after the
// work started, pull requests, posted updates), the people active on the project, the "N new" count,
// the headline text of an update and the changelog export.
import { format } from 'date-fns';
import type {
  ActorRef,
  Artifact,
  DomainEvent,
  Issue,
  Milestone,
  Project,
  ProjectUpdate,
} from '../../core';
import { dateOfDay, dayOf, fmtNum, unitsOf } from '../milestones/milestone-model';
import { slackText } from './project-burnup-model';

// ───────────────────────── text ─────────────────────────

/** Markdown reduced to what reads as one line of plain text: no heading marks, emphasis, code or link targets. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The headline of an update: its first paragraph, as plain text. */
export function firstParagraph(body: string): string {
  return plainText(paragraphs(body)[0] ?? '');
}

/** What follows the headline, as plain text ("" when the update is one paragraph). */
export function restOfBody(body: string): string {
  return plainText(paragraphs(body).slice(1).join('\n\n'));
}

/** "Nov 24" (local calendar day). */
export const shortDay = (day: number): string => format(dateOfDay(day), 'MMM d');
export const shortDate = (iso: string): string => shortDay(dayOf(iso));

const unitWord = (n: number, points: boolean): string =>
  points ? (n === 1 ? 'point' : 'points') : n === 1 ? 'task' : 'tasks';

// ───────────────────────── milestone windows ─────────────────────────

export interface MilestoneWindow {
  milestone: Milestone;
  /** First day of the milestone: the target of the one before it, else the start of the project. */
  startDay: number;
  /** Its target day; `null` without a target date. */
  endDay: number | null;
}

/** The span of each milestone, in the order of the project. A milestone starts where the previous one ended. */
export function milestoneWindows(
  project: Pick<Project, 'startDate' | 'createdAt'>,
  milestones: readonly Milestone[],
): MilestoneWindow[] {
  let start = dayOf(project.startDate ?? project.createdAt);
  return milestones.map((milestone) => {
    const endDay = milestone.targetDate ? dayOf(milestone.targetDate) : null;
    const window: MilestoneWindow = { milestone, startDay: Math.min(start, endDay ?? start), endDay };
    if (endDay !== null) start = endDay;
    return window;
  });
}

/**
 * The milestone a project-level item of that day belongs to: the current one once its time has come (also when
 * it ran past its target), else the one whose span holds the day.
 */
export function milestoneOfDay(
  windows: readonly MilestoneWindow[],
  day: number,
  currentId: string | null,
): string | null {
  const current = windows.find((w) => w.milestone.id === currentId);
  if (current && day >= current.startDay) return current.milestone.id;
  const hit = windows.find((w) => day >= w.startDay && (w.endDay === null || day <= w.endDay));
  return hit?.milestone.id ?? currentId ?? windows[windows.length - 1]?.milestone.id ?? null;
}

// ───────────────────────── key events ─────────────────────────

export interface KeyEvent {
  id: string;
  at: string;
  actor: ActorRef;
  text: string;
  /** Milestone it belongs to; `null` for what is not tied to one. */
  milestoneId: string | null;
  /** Amber kicker of a highlighted row ("SCOPE CHANGE"). */
  kicker?: string;
  /** Task key shown on the right. */
  ref?: string;
  /** Set on a posted update: the row can be edited or deleted. */
  update?: ProjectUpdate;
}

export interface UpdatesContext {
  project: Pick<Project, 'id' | 'startDate' | 'createdAt'>;
  /** In the order of the project. */
  milestones: readonly Milestone[];
  /** The tasks of the project. */
  issues: readonly Issue[];
  /** Workspace events, any order. */
  events: readonly DomainEvent[];
  artifactById: ReadonlyMap<string, Pick<Artifact, 'kind' | 'issueId'>>;
  updates: readonly ProjectUpdate[];
  /** Progress is counted in points (else in tasks). */
  points: boolean;
  /** The milestone project-level items fall into once the dates run out. */
  currentMilestoneId: string | null;
  actorName: (actor: ActorRef) => string;
  statusName: (status: string) => string;
  isDoneStatus: (status: string) => boolean;
  healthName: (health: string) => string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const sameActor = (a: ActorRef, b: ActorRef): boolean => a.type === b.type && a.id === b.id;

/** Events about the project: its tasks, their pull requests, its milestones and the project itself. */
export function relatedEvents(ctx: UpdatesContext): DomainEvent[] {
  const issueIds = new Set(ctx.issues.map((i) => i.id));
  const milestoneIds = new Set(ctx.milestones.map((m) => m.id));
  return ctx.events.filter((e) => {
    switch (e.subject.type) {
      case 'issue':
        return issueIds.has(e.subject.id);
      case 'milestone':
        return milestoneIds.has(e.subject.id);
      case 'project':
        return e.subject.id === ctx.project.id;
      case 'artifact': {
        const issueId = str(e.data?.['issueId']);
        return !!issueId && issueIds.has(issueId);
      }
      default:
        return false;
    }
  });
}

/** The day work first started in a milestone; tasks added after it are a change of scope. */
function startedDayOf(issues: readonly Issue[]): number | null {
  let first: number | null = null;
  for (const i of issues) {
    if (!i.startedAt) continue;
    const day = dayOf(i.startedAt);
    first = first === null ? day : Math.min(first, day);
  }
  return first;
}

/**
 * The key events of a project: one row per status change, task added once the work had started (a change of
 * scope), pull request, milestone opened, health change and posted update. Newest first.
 */
export function deriveKeyEvents(ctx: UpdatesContext): KeyEvent[] {
  const issueById = new Map(ctx.issues.map((i) => [i.id, i]));
  const windows = milestoneWindows(ctx.project, ctx.milestones);
  const started = new Map<string, number | null>();
  for (const m of ctx.milestones)
    started.set(m.id, startedDayOf(ctx.issues.filter((i) => i.milestoneIds?.includes(m.id))));
  const milestoneOfIssue = (issue: Issue): string | null =>
    issue.milestoneIds?.find((id) => started.has(id)) ?? null;
  const rows: KeyEvent[] = [];

  const scopeRow = (e: DomainEvent, issue: Issue): KeyEvent | null => {
    const milestoneId = milestoneOfIssue(issue);
    const since = milestoneId ? started.get(milestoneId) : null;
    if (!milestoneId || since === null || since === undefined || dayOf(e.at) <= since) return null;
    const n = unitsOf(issue, ctx.points);
    return {
      id: e.id,
      at: e.at,
      actor: e.actor,
      milestoneId,
      kicker: 'SCOPE CHANGE',
      ref: issue.key,
      text: `Scope grew by ${fmtNum(n)} ${unitWord(n, ctx.points)} when “${issue.title}” was added to the milestone.`,
    };
  };

  for (const e of relatedEvents(ctx)) {
    const d = e.data ?? {};
    const who = ctx.actorName(e.actor);
    switch (e.type) {
      case 'issue.status_changed': {
        const issue = issueById.get(e.subject.id);
        const to = str(d['to']);
        if (!issue || !to) break;
        rows.push({
          id: e.id,
          at: e.at,
          actor: e.actor,
          milestoneId: milestoneOfIssue(issue),
          ref: issue.key,
          text: ctx.isDoneStatus(to)
            ? `${who} completed “${issue.title}”.`
            : `${who} moved “${issue.title}” to ${ctx.statusName(to)}.`,
        });
        break;
      }
      case 'issue.created': {
        const issue = issueById.get(e.subject.id);
        if (!issue) break;
        rows.push(
          scopeRow(e, issue) ?? {
            id: e.id,
            at: e.at,
            actor: e.actor,
            milestoneId: milestoneOfIssue(issue),
            ref: issue.key,
            text: `${who} opened “${issue.title}”.`,
          },
        );
        break;
      }
      case 'issue.updated': {
        const issue = issueById.get(e.subject.id);
        if (!issue || !strs(d['fields']).includes('milestoneIds')) break;
        const row = scopeRow(e, issue);
        if (row) rows.push(row);
        break;
      }
      case 'artifact.attached':
      case 'artifact.updated': {
        const issueId = str(d['issueId']);
        const issue = issueId ? issueById.get(issueId) : undefined;
        const kind = str(d['kind']) ?? ctx.artifactById.get(e.subject.id)?.kind;
        if (!issue || (kind !== 'pull_request' && kind !== 'merge_request')) break;
        const changes = (d['changes'] ?? {}) as Record<string, unknown[]>;
        const merged = e.type === 'artifact.updated' && changes['state']?.[1] === 'merged';
        if (e.type === 'artifact.updated' && !merged) break;
        const abbr = kind === 'pull_request' ? 'PR' : 'MR';
        const id = str(d['externalId']);
        const label = id ? (id.startsWith('#') ? `${abbr} ${id}` : id) : `a ${abbr}`;
        const title = str(d['title']);
        rows.push({
          id: e.id,
          at: e.at,
          actor: e.actor,
          milestoneId: milestoneOfIssue(issue),
          ref: issue.key,
          text: `${who} ${merged ? 'merged' : 'opened'} ${label}${title ? `, “${title}”` : ''}, on ${issue.key}.`,
        });
        break;
      }
      case 'milestone.created': {
        const m = ctx.milestones.find((x) => x.id === e.subject.id);
        if (!m) break;
        rows.push({
          id: e.id,
          at: e.at,
          actor: e.actor,
          milestoneId: m.id,
          text: `${who} opened the milestone${m.targetDate ? `, targeting ${shortDate(m.targetDate)}` : ''}.`,
        });
        break;
      }
      case 'project.update_posted': {
        // A posted update that still exists is its own row below (with its menu); this keeps one that was deleted.
        const updateId = str(d['updateId']);
        if (updateId && ctx.updates.some((u) => u.id === updateId)) break;
        const excerpt = plainText(str(d['excerpt']) ?? '');
        const health = str(d['health']);
        rows.push({
          id: e.id,
          at: e.at,
          actor: e.actor,
          milestoneId: milestoneOfDay(windows, dayOf(e.at), ctx.currentMilestoneId),
          text: `${who} posted an update${health ? ` (${ctx.healthName(health)})` : ''}${excerpt ? `: ${excerpt}` : '.'}`,
        });
        break;
      }
      case 'project.health_changed': {
        const to = str(d['to']);
        const posted = ctx.updates.some(
          (u) => u.health === to && sameActor(u.author, e.actor) && Math.abs(Date.parse(u.createdAt) - Date.parse(e.at)) < 15_000,
        );
        if (posted) break;
        rows.push({
          id: e.id,
          at: e.at,
          actor: e.actor,
          milestoneId: milestoneOfDay(windows, dayOf(e.at), ctx.currentMilestoneId),
          text: to ? `${who} set the project health to ${ctx.healthName(to)}.` : `${who} cleared the project health.`,
        });
        break;
      }
    }
  }

  for (const u of ctx.updates) {
    const head = firstParagraph(u.body);
    rows.push({
      id: `update:${u.id}`,
      at: u.createdAt,
      actor: u.author,
      milestoneId: milestoneOfDay(windows, dayOf(u.createdAt), ctx.currentMilestoneId),
      text: `${ctx.actorName(u.author)} posted an update${u.health ? ` (${ctx.healthName(u.health)})` : ''}${head ? `: ${head}` : '.'}`,
      update: u,
    });
  }

  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// ───────────────────────── people & agents ─────────────────────────

export interface CastMember {
  actor: ActorRef;
  events: number;
  /** Pull requests this actor opened on the project's tasks. */
  prs: number;
}

/** Who is active on the project (events and posted updates), the busiest first. */
export function castOf(ctx: UpdatesContext, leadId?: string): CastMember[] {
  const map = new Map<string, CastMember>();
  const touch = (actor: ActorRef): CastMember => {
    const key = `${actor.type}:${actor.id ?? ''}`;
    let m = map.get(key);
    if (!m) map.set(key, (m = { actor, events: 0, prs: 0 }));
    return m;
  };
  for (const e of relatedEvents(ctx)) {
    if (e.actor.type === 'system') continue;
    // a posted update is counted once, from the list below
    if (e.type === 'project.update_posted' && ctx.updates.some((u) => u.id === str(e.data?.['updateId']))) continue;
    const m = touch(e.actor);
    m.events++;
    const kind = str(e.data?.['kind']);
    if (e.type === 'artifact.attached' && (kind === 'pull_request' || kind === 'merge_request')) m.prs++;
  }
  for (const u of ctx.updates) touch(u.author).events++;
  if (leadId) touch({ type: 'user', id: leadId });
  return [...map.values()].sort(
    (a, b) =>
      Number(b.actor.id === leadId) - Number(a.actor.id === leadId) ||
      b.events - a.events ||
      (a.actor.id ?? '').localeCompare(b.actor.id ?? ''),
  );
}

// ───────────────────────── milestones ─────────────────────────

/** Latest day a done task of the milestone was closed, else its target day. */
export function closedDayOf(issues: readonly Issue[], milestone: Pick<Milestone, 'targetDate'>): number | null {
  let last: number | null = null;
  for (const i of issues) {
    if (i.status !== 'done' || !i.completedAt) continue;
    const day = dayOf(i.completedAt);
    last = last === null ? day : Math.max(last, day);
  }
  return last ?? (milestone.targetDate ? dayOf(milestone.targetDate) : null);
}

/** The italic line under a closed milestone: its latest update, else "Shipped 24 tasks, 3 days late." */
export function recapOf(
  milestone: Pick<Milestone, 'targetDate'>,
  issues: readonly Issue[],
  updates: readonly ProjectUpdate[],
): string {
  const latest = updates[0];
  if (latest) {
    const head = firstParagraph(latest.body);
    if (head) return head;
  }
  const done = issues.filter((i) => i.status === 'done').length;
  if (!done) return 'Closed without shipping a task.';
  const closed = closedDayOf(issues, milestone);
  const slack = closed !== null && milestone.targetDate ? closed - dayOf(milestone.targetDate) : null;
  return `Shipped ${done} ${done === 1 ? 'task' : 'tasks'}${slack === null ? '' : `, ${slackText(slack)}`}.`;
}

// ───────────────────────── "N new" ─────────────────────────

/** Updates by other people posted since `lastSeen` (never opened: all of them). */
export function newUpdatesCount(
  updates: readonly ProjectUpdate[],
  lastSeen: string | null,
  meId?: string,
): number {
  const since = lastSeen ? Date.parse(lastSeen) : Number.NEGATIVE_INFINITY;
  return updates.filter(
    (u) => !(u.author.type === 'user' && u.author.id === meId) && Date.parse(u.createdAt) > since,
  ).length;
}

/** The newest `createdAt` among the updates, else `fallback`: what "seen" is set to when the tab is open. */
export function latestUpdateAt(updates: readonly ProjectUpdate[], fallback: string): string {
  return updates.reduce((a, u) => (u.createdAt > a ? u.createdAt : a), fallback);
}

// ───────────────────────── changelog ─────────────────────────

export interface ChangelogInput {
  project: Pick<Project, 'name'>;
  /** Newest first. */
  updates: readonly ProjectUpdate[];
  milestones: readonly Milestone[];
  issues: readonly Issue[];
  authorName: (actor: ActorRef) => string;
  healthName: (health: string) => string;
  now: Date;
}

/** The changelog of a project as Markdown: the updates newest first, then the closed tasks per milestone. */
export function changelogMarkdown(input: ChangelogInput): string {
  const out: string[] = [`# ${input.project.name} changelog`, '', `Exported ${format(input.now, 'MMM d, yyyy')}.`, ''];

  out.push('## Updates', '');
  if (!input.updates.length) out.push('No updates posted yet.', '');
  for (const u of input.updates) {
    const bits = [shortDate(u.createdAt), input.authorName(u.author)];
    if (u.health) bits.push(input.healthName(u.health));
    out.push(`### ${bits.join(' · ')}`, '', u.body.trim(), '');
  }

  out.push('## Closed tasks', '');
  const closed = (i: Issue): boolean => i.status === 'done';
  const line = (i: Issue): string =>
    `- ${i.key} ${i.title}${i.completedAt ? ` (${shortDate(i.completedAt)})` : ''}`;
  const byClose = (a: Issue, b: Issue): number => (a.completedAt ?? '').localeCompare(b.completedAt ?? '');
  let any = false;
  const inMilestone = new Set<string>();
  for (const m of input.milestones) {
    const list = input.issues.filter((i) => closed(i) && i.milestoneIds?.includes(m.id)).sort(byClose);
    list.forEach((i) => inMilestone.add(i.id));
    if (!list.length) continue;
    any = true;
    out.push(`### ${m.name}${m.targetDate ? ` (target ${shortDate(m.targetDate)})` : ''}`, '', ...list.map(line), '');
  }
  const loose = input.issues.filter((i) => closed(i) && !inMilestone.has(i.id)).sort(byClose);
  if (loose.length) {
    any = true;
    out.push(input.milestones.length ? '### Without a milestone' : '### Tasks', '', ...loose.map(line), '');
  }
  if (!any) out.push('No task has been closed yet.', '');

  return `${out.join('\n').trimEnd()}\n`;
}
