// The Inbox, as data. Everything that concerns the current user becomes one `InboxEntry`: a plain sentence that says
// why it is there, the thing it is about, and the next action. Pure functions, no store, so the rules are testable.
//
//   Needs your action   reviews, failing checks, conflicts and triage waiting on a human (the attention queue)
//   Your tasks in progress   what you are working on and that is moving
//   Stale               started, but nothing has happened for a while
//   Updates             assignments and comments that concern you
//   Snoozed and dismissed   what you set aside (shown collapsed, one click from coming back)
import {
  LucideCircleDot,
  LucideCircleX,
  LucideGitMerge,
  LucideGitPullRequest,
  LucideInbox,
  LucideMessageCircle,
  LucideTriangleAlert,
  LucideUser,
  type LucideIcon,
} from '@lucide/angular';
import {
  SEVERITY_ORDER,
  shortDate,
  type ActorRef,
  type Artifact,
  type AttentionItem,
  type Issue,
  type Notification,
} from '../../core';
import { DAY } from '../stats/flow-stats';
import { groupOf } from './my-tasks';

export type InboxSectionId = 'action' | 'progress' | 'stale' | 'updates' | 'later';

/**
 * The Inbox tabs (v3): All, then one tab per origin.
 *   Mentions  assignments and comments that concern you
 *   Records   your tasks in progress, and the ones gone stale
 *   Sync      what the providers report: reviews, failing checks, conflicts, triage
 *   Later     what you snoozed or dismissed (only shown when there is some)
 */
export type InboxTab = 'all' | 'mentions' | 'records' | 'sync' | 'later';

export const INBOX_TABS: readonly { id: InboxTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'records', label: 'Records' },
  { id: 'sync', label: 'Sync' },
  { id: 'later', label: 'Later' },
];

/** The tab an entry belongs to (besides All, which holds everything but Later). */
export function tabOf(e: Pick<InboxEntry, 'section'>): Exclude<InboxTab, 'all'> {
  switch (e.section) {
    case 'action':
      return 'sync';
    case 'progress':
    case 'stale':
      return 'records';
    case 'updates':
      return 'mentions';
    case 'later':
      return 'later';
  }
}

export const isInboxTab = (v: unknown): v is InboxTab => INBOX_TABS.some((t) => t.id === v);

/** The `?tab=` values older links use (and the current ones), and the tab each opens. */
export const LEGACY_TABS: Readonly<Record<string, InboxTab>> = {
  'needs-you': 'sync',
  tasks: 'records',
  updates: 'mentions',
  later: 'later',
  ...Object.fromEntries(INBOX_TABS.map((t) => [t.id, t.id])),
};

export type RowAction =
  /** Open the task (or the list the item points at). */
  | { type: 'open'; label: string }
  /** Open a pull request or build at its provider. */
  | { type: 'external'; label: string; url: string }
  /** Move the task to Done. */
  | { type: 'done'; label: string }
  /** Bring a snoozed or dismissed item back. */
  | { type: 'restore'; label: string };

export interface InboxEntry {
  /** `data-row-id` of the row: the attention id, `task:<id>` or the notification id. */
  id: string;
  source: 'attention' | 'task' | 'update';
  section: InboxSectionId;
  /** One plain sentence: why this is here. */
  sentence: string;
  /** What kind of event it is, in a few words ("Review requested", "Stale"): the preview's kicker. */
  kicker: string;
  /** What it is about: the task key and a short text (the title, or the comment). */
  key?: string;
  text?: string;
  /** Path under the workspace the row opens, and its query. */
  route: readonly string[];
  query?: Record<string, string>;
  /** Key of the task this row is about. */
  issueKey?: string;
  at: string;
  unread: boolean;
  icon: LucideIcon;
  /** Tailwind text colour class of the icon. */
  iconColor: string;
  /** Show this task status glyph instead of the icon. */
  status?: string;
  primary: RowAction;
  canSnooze: boolean;
  canDismiss: boolean;
  canMarkDone: boolean;
  canMarkRead: boolean;
  attention?: AttentionItem;
  issue?: Issue;
  notification?: Notification;
}

export interface InboxSection {
  id: InboxSectionId;
  title: string;
  hint: string;
  entries: InboxEntry[];
}

export interface InboxContext {
  now: number;
  issueById: ReadonlyMap<string, Issue>;
  artifactById: ReadonlyMap<string, Artifact>;
  actorName: (ref: ActorRef) => string;
  /** When something last happened on a task. */
  activityAt: (issue: Issue) => number;
  idleDays: number;
}

const SECTION_META: Record<InboxSectionId, Pick<InboxSection, 'title' | 'hint'>> = {
  action: { title: 'Needs your action', hint: 'Reviews, failing checks, conflicts and triage' },
  progress: { title: 'Your tasks in progress', hint: 'Assigned to you and moving' },
  stale: { title: 'Stale', hint: 'Started, but quiet for a while' },
  updates: { title: 'Updates', hint: 'Assignments and comments' },
  later: { title: 'Snoozed and dismissed', hint: 'Set aside, one click from coming back' },
};

export const sectionMeta = (id: InboxSectionId) => SECTION_META[id];

/** Notification kinds the attention queue already shows as an action, so Updates leaves them out. */
const ACTION_KINDS: ReadonlySet<string> = new Set(['review_requested', 'ci_failed']);

/** Task key of a notification link (`tasks/AUTH-42`), when it points at a task. */
export const taskKeyOf = (link: string): string | undefined =>
  /^\/?(?:tasks|issues)\/([^/?#]+)/.exec(link)?.[1];

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How an artifact reads in a sentence: "PR #12", "MR #4", or its title in quotes. */
export function artifactRef(a: Artifact | undefined, fallback: string): string {
  if (!a) return fallback;
  const num = a.externalId ? (a.externalId.startsWith('#') ? a.externalId : `#${a.externalId}`) : '';
  if (a.kind === 'pull_request') return num ? `PR ${num}` : 'a pull request';
  if (a.kind === 'merge_request') return num ? `MR ${num}` : 'a merge request';
  return `“${a.title}”`;
}

const isRequest = (a: Artifact | undefined): boolean =>
  a?.kind === 'pull_request' || a?.kind === 'merge_request';

// v3 Inbox icon colours: blue for review and links, red for what is broken, yellow for status and staleness,
// muted for the rest.
const ATTENTION_ICON: Record<AttentionItem['kind'], { icon: LucideIcon; color: string; kicker: string }> = {
  review_requested: { icon: LucideGitPullRequest, color: 'text-delta-line', kicker: 'Review requested' },
  ci_failed: { icon: LucideCircleX, color: 'text-red', kicker: 'Checks failing' },
  conflict: { icon: LucideGitMerge, color: 'text-red', kicker: 'Merge conflict' },
  triage: { icon: LucideInbox, color: 'text-muted-foreground', kicker: 'Needs triage' },
};

/** The sentence for an attention item: what is wrong or asked, where, and for which task. */
export function attentionSentence(item: AttentionItem, ctx: Pick<InboxContext, 'issueById' | 'artifactById'>): string {
  const issue = item.issueId ? ctx.issueById.get(item.issueId) : undefined;
  const artifact = item.artifactId ? ctx.artifactById.get(item.artifactId) : undefined;
  const ref = artifactRef(artifact, `“${item.title}”`);
  const forTask = issue ? ` for ${issue.key}` : '';
  switch (item.kind) {
    case 'review_requested':
      return `Review requested on ${ref}${forTask}`;
    case 'ci_failed':
      return isRequest(artifact) || !artifact
        ? `Checks are failing on ${ref}${forTask}`
        : `${ref} is failing${forTask}`;
    case 'conflict':
      return `${ref}${forTask} has merge conflicts`;
    case 'triage':
      return issue ? `${issue.key} is new in the backlog and needs triage` : 'A new task needs triage';
  }
}

export function attentionEntry(item: AttentionItem, ctx: InboxContext): InboxEntry {
  const issue = item.issueId ? ctx.issueById.get(item.issueId) : undefined;
  const artifact = item.artifactId ? ctx.artifactById.get(item.artifactId) : undefined;
  const view = ATTENTION_ICON[item.kind];
  const open = item.state === 'open';
  const base = {
    id: item.id,
    source: 'attention' as const,
    key: issue?.key,
    text: issue?.title ?? item.title,
    route: issue ? ['tasks', issue.key] : ['tasks'],
    query: issue ? undefined : { status: 'backlog' },
    issueKey: issue?.key,
    at: item.since,
    unread: false,
    icon: view.icon,
    iconColor: view.color,
    canMarkDone: false,
    canMarkRead: false,
    attention: item,
    issue,
  };
  if (!open) {
    return {
      ...base,
      section: 'later',
      kicker: item.state === 'snoozed' ? 'Snoozed' : 'Dismissed',
      sentence: attentionSentence(item, ctx),
      primary: { type: 'restore', label: 'Restore' },
      canSnooze: false,
      canDismiss: false,
    };
  }
  const primary: RowAction =
    item.kind === 'triage'
      ? { type: 'open', label: 'Triage' }
      : artifact?.url
        ? {
            type: 'external',
            label: item.kind === 'review_requested' ? 'Review' : isRequest(artifact) ? 'Open PR' : 'Open',
            url: artifact.url,
          }
        : { type: 'open', label: item.kind === 'review_requested' ? 'Review' : 'Open' };
  return {
    ...base,
    section: 'action',
    kicker: view.kicker,
    sentence: attentionSentence(item, ctx),
    primary,
    canSnooze: true,
    canDismiss: true,
  };
}

/** "Snoozed until Mon" / "Dismissed", for the Snoozed and dismissed section. */
export function laterLabel(item: AttentionItem): string {
  if (item.state === 'snoozed') return item.snoozedUntil ? `Snoozed until ${shortDate(item.snoozedUntil)}` : 'Snoozed';
  return 'Dismissed';
}

export function taskEntry(issue: Issue, ctx: InboxContext): InboxEntry {
  const at = ctx.activityAt(issue);
  const idle = groupOf(issue, ctx) === 'idle';
  const days = Math.max(1, Math.floor((ctx.now - at) / DAY));
  const state = issue.status === 'in_review' ? 'In review' : 'In progress';
  // The task is the subject here, so its title leads; the reason sits next to the key.
  return {
    id: `task:${issue.id}`,
    source: 'task',
    section: idle ? 'stale' : 'progress',
    kicker: idle ? 'Stale' : state,
    sentence: issue.title,
    key: issue.key,
    text: idle ? `No activity for ${plural(days, 'day')}` : state,
    route: ['tasks', issue.key],
    issueKey: issue.key,
    at: new Date(at).toISOString(),
    unread: false,
    icon: idle ? LucideTriangleAlert : LucideCircleDot,
    iconColor: idle || issue.status !== 'in_review' ? 'text-yellow' : 'text-delta-line',
    status: issue.status,
    primary: idle ? { type: 'open', label: 'Open' } : { type: 'done', label: 'Mark done' },
    canSnooze: false,
    canDismiss: false,
    canMarkDone: idle,
    canMarkRead: false,
    issue,
  };
}

const UPDATE_ICON: Record<string, { icon: LucideIcon; color: string; kicker: string }> = {
  assigned: { icon: LucideUser, color: 'text-muted-foreground', kicker: 'Assigned to you' },
  comment: { icon: LucideMessageCircle, color: 'text-muted-foreground', kicker: 'New comment' },
};

export function updateEntry(n: Notification, ctx: InboxContext): InboxEntry {
  const key = taskKeyOf(n.link);
  const issue = key ? [...ctx.issueById.values()].find((i) => i.key === key || i.aliases.includes(key)) : undefined;
  const who = ctx.actorName(n.actor);
  let sentence = n.title;
  if (key) {
    if (n.kind === 'assigned') sentence = `${who} assigned you ${key}`;
    else if (n.kind === 'comment') sentence = `${who} commented on ${key}`;
  }
  const view = UPDATE_ICON[n.kind] ?? UPDATE_ICON['comment'];
  return {
    id: n.id,
    source: 'update',
    section: 'updates',
    kicker: UPDATE_ICON[n.kind]?.kicker ?? 'Update',
    sentence,
    key: issue?.key ?? key,
    text: n.kind === 'comment' && n.body ? `“${n.body}”` : (issue?.title ?? n.body),
    route: n.link.split('/').filter(Boolean),
    issueKey: issue?.key ?? key,
    at: n.createdAt,
    unread: !n.readAt,
    icon: view.icon,
    iconColor: view.color,
    primary: { type: 'open', label: n.kind === 'comment' ? 'Reply' : 'Open' },
    canSnooze: false,
    canDismiss: false,
    canMarkDone: false,
    canMarkRead: !n.readAt,
    notification: n,
    issue,
  };
}

const newest = (a: InboxEntry, b: InboxEntry): number => b.at.localeCompare(a.at);

export interface InboxInput {
  /** Attention items of any state. */
  attention: readonly AttentionItem[];
  /** Tasks assigned to the current user. */
  mine: readonly Issue[];
  notifications: readonly Notification[];
}

/**
 * The sections of the Inbox, in display order, newest first inside each. Empty sections other than "Needs your
 * action" are left out. A task that already needs you (a failing check, a review) is not repeated under
 * "in progress" or "Stale".
 */
export function buildInbox(input: InboxInput, ctx: InboxContext): InboxSection[] {
  const action: InboxEntry[] = [];
  const later: InboxEntry[] = [];
  for (const item of input.attention) {
    const e = attentionEntry(item, ctx);
    (item.state === 'open' ? action : later).push(e);
  }
  action.sort(
    (a, b) =>
      SEVERITY_ORDER[a.attention!.severity] - SEVERITY_ORDER[b.attention!.severity] || newest(a, b),
  );
  later.sort(newest);

  const needing = new Set(action.map((e) => e.attention?.issueId).filter((x): x is string => !!x));
  const progress: InboxEntry[] = [];
  const stale: InboxEntry[] = [];
  for (const issue of input.mine) {
    if (issue.status !== 'in_progress' && issue.status !== 'in_review') continue;
    if (needing.has(issue.id)) continue;
    const e = taskEntry(issue, ctx);
    (e.section === 'stale' ? stale : progress).push(e);
  }
  progress.sort(newest);
  stale.sort(newest);

  const updates = input.notifications
    .filter((n) => !ACTION_KINDS.has(n.kind))
    .map((n) => updateEntry(n, ctx))
    .sort(newest);

  const sections: [InboxSectionId, InboxEntry[]][] = [
    ['action', action],
    ['progress', progress],
    ['stale', stale],
    ['updates', updates],
    ['later', later],
  ];
  return sections
    .filter(([id, entries]) => entries.length > 0 || id === 'action')
    .map(([id, entries]) => ({ id, ...SECTION_META[id], entries }));
}
