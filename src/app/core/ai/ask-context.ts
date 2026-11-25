import type { ActivityStep, ChatContext } from './ai-api';

/** What a context chip stands for in the "Ask Trama" panel. */
export type AskChipKind = 'task' | 'project' | 'view' | 'page';

/** One removable entry of the panel's CONTEXT row. */
export interface AskContextChip {
  /** Stable per record (`task:TRM-128`), so a chip removed by the person stays removed. */
  id: string;
  kind: AskChipKind;
  label: string;
  /** Longer label for the tooltip (task title, project name). */
  hint?: string;
  /** What the assistant is told when the chip is on. */
  context: ChatContext;
}

/** The records a route can point at; the store provides them. */
export interface AskContextLookup {
  issue(ref: string): { key: string; title: string; projectId?: string } | undefined;
  project(id: string): { id: string; name: string } | undefined;
  view(id: string): { id: string; name: string } | undefined;
}

const PAGE_LABELS: Record<string, string> = {
  overview: 'Home',
  timer: 'Time',
  inbox: 'Inbox',
  tasks: 'Tasks',
  issues: 'Tasks',
  board: 'Board',
  timeline: 'Timeline',
  projects: 'Projects',
  views: 'Views',
  assistant: 'Assistant',
};

function titleCase(segment: string): string {
  const text = segment.replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function taskChip(issue: { key: string; title: string }): AskContextChip {
  return {
    id: `task:${issue.key}`,
    kind: 'task',
    label: issue.key,
    hint: `${issue.key} · ${issue.title}`,
    context: { kind: 'issue', id: issue.key, label: issue.key },
  };
}

export function projectChip(project: { id: string; name: string }): AskContextChip {
  return {
    id: `project:${project.id}`,
    kind: 'project',
    label: project.name,
    hint: project.name,
    context: { kind: 'project', id: project.id, label: project.name },
  };
}

function viewChip(view: { id: string; name: string }): AskContextChip {
  return {
    id: `view:${view.id}`,
    kind: 'view',
    label: view.name,
    hint: `View · ${view.name}`,
    context: { kind: 'page', label: view.name },
  };
}

function pageChip(area: string): AskContextChip {
  const label = PAGE_LABELS[area] ?? titleCase(area);
  return { id: `page:${area}`, kind: 'page', label, context: { kind: 'page', label } };
}

/**
 * The CONTEXT chips a route fills in by itself: the task being read (and the project it belongs to),
 * the project, the saved view, or else the page. `url` is the router URL (`/:workspace/<area>/<id>`).
 */
export function askChipsFromUrl(url: string, lookup: AskContextLookup): AskContextChip[] {
  const [, , area, rawId] = url.split(/[?#]/)[0].split('/');
  if (!area) return [];
  const id = rawId ? decode(rawId) : undefined;
  if (id && (area === 'tasks' || area === 'issues')) {
    const issue = lookup.issue(id);
    const chips = [taskChip(issue ?? { key: id, title: id })];
    const project = issue?.projectId ? lookup.project(issue.projectId) : undefined;
    if (project) chips.push(projectChip(project));
    return chips;
  }
  if (id && area === 'projects') {
    const project = lookup.project(id);
    return [projectChip(project ?? { id, name: id })];
  }
  if (id && area === 'views') {
    const view = lookup.view(id);
    return [viewChip(view ?? { id, name: id })];
  }
  return [pageChip(area)];
}

/**
 * The chips shown: the route's own, minus the ones the person removed, plus the ones they added
 * (the same record is never listed twice).
 */
export function visibleAskChips(
  route: readonly AskContextChip[],
  dismissed: ReadonlySet<string>,
  added: readonly AskContextChip[],
): AskContextChip[] {
  const out = route.filter((c) => !dismissed.has(c.id));
  for (const chip of added) if (!out.some((c) => c.id === chip.id)) out.push(chip);
  return out;
}

const PRIORITY: Record<AskChipKind, number> = { task: 0, project: 1, view: 2, page: 3 };

/**
 * What the backend is told. It takes one subject: the most specific chip on (task, then project,
 * then view / page); nothing when every chip was removed.
 */
export function primaryAskContext(chips: readonly AskContextChip[]): ChatContext | undefined {
  let best: AskContextChip | undefined;
  for (const chip of chips) if (!best || PRIORITY[chip.kind] < PRIORITY[best.kind]) best = chip;
  return best?.context;
}

/** Placeholder of the input: "Ask about this task…". */
export function askPlaceholder(kind: ChatContext['kind'] | undefined): string {
  if (kind === 'issue') return 'Ask about this task…';
  if (kind === 'project') return 'Ask about this project…';
  if (kind === 'page') return 'Ask about this page…';
  return 'Ask about your records…';
}

/** Starter questions for the empty panel. */
export function askStarters(kind: ChatContext['kind'] | undefined): readonly string[] {
  if (kind === 'issue')
    return ['What is blocking this task?', 'What changed since I last looked?', 'What is left to do?'];
  if (kind === 'project')
    return ['What is at risk in this project?', 'What is blocked right now?', 'What shipped this week?'];
  return ['What is blocked right now?', 'Which tasks have no linked thread?', 'What changed in the last week?'];
}

export type AskSourceIcon = 'pr' | 'thread' | 'task' | 'record';

export interface AskSource {
  label: string;
  icon: AskSourceIcon;
}

/** Which icon a source chip gets, from what its label names. */
export function askSourceIcon(label: string): AskSourceIcon {
  if (/\bPR\s*#\d+|pull request/i.test(label)) return 'pr';
  if (/\bthread\b/i.test(label)) return 'thread';
  if (/\b[A-Z][A-Z0-9]*-\d+\b/.test(label)) return 'task';
  return 'record';
}

export interface AskAnswerMeta {
  /** "FROM N RECORDS": what the assistant read or changed to answer. */
  records: number;
  sources: AskSource[];
}

/** The records an answer was built from: the read / write steps, not the assistant's own notes. */
export function askAnswerMeta(steps: readonly ActivityStep[] | undefined): AskAnswerMeta {
  const used = (steps ?? []).filter((s) => s.kind !== 'note');
  return {
    records: used.reduce((n, s) => n + (s.count && s.count > 1 ? s.count : 1), 0),
    sources: used.map((s) => ({ label: s.label, icon: askSourceIcon(s.label) })),
  };
}
