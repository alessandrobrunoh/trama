import type { IssueKind } from '../contracts/domain.js';

/** Matches `CreateIssueDto` / `UpdateIssueDto`. */
const TITLE_MAX = 300;
const BODY_MAX = 20_000;
const REPORTER_MAX = 200;
const URL_MAX = 500;

const KINDS: readonly IssueKind[] = ['bug', 'feature', 'incident', 'tech_debt', 'feedback', 'idea', 'security'];

/** Words the model uses that are not the stored enum. */
const KIND_ALIASES: Record<string, IssueKind> = {
  bug: 'bug',
  bugs: 'bug',
  defect: 'bug',
  feature: 'feature',
  feat: 'feature',
  story: 'feature',
  incident: 'incident',
  inc: 'incident',
  outage: 'incident',
  tech_debt: 'tech_debt',
  techdebt: 'tech_debt',
  'tech-debt': 'tech_debt',
  debt: 'tech_debt',
  feedback: 'feedback',
  fb: 'feedback',
  idea: 'idea',
  security: 'security',
  sec: 'security',
};

const KIND_LIST = KINDS.join(', ');

export type IssueToolArgs =
  | { args: Record<string, unknown> }
  | { error: string };

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trimEnd();
}

function kindOf(value: unknown): IssueKind | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return KIND_ALIASES[key] ?? null;
}

/**
 * Fit `create_issue` / `update_issue` arguments to the API before they are sent.
 * A title over 300 characters or a kind outside the enum is a 400 from the issues
 * API; other tools are returned unchanged.
 */
export function normalizeIssueToolArgs(name: string, args: Record<string, unknown>): IssueToolArgs {
  if (name !== 'create_issue' && name !== 'update_issue') return { args };
  const next = { ...args };
  const creating = name === 'create_issue';

  if ('title' in next) {
    const title = next.title;
    if (title === undefined || (title === null && !creating)) {
      delete next.title;
    } else if (typeof title === 'string' || typeof title === 'number') {
      const clipped = clip(String(title), TITLE_MAX);
      if (!clipped) return { error: 'title must be a string of 1 to 300 characters.' };
      next.title = clipped;
    } else {
      return { error: 'title must be a string of 1 to 300 characters.' };
    }
  } else if (creating) {
    return { error: 'title must be a string of 1 to 300 characters.' };
  }

  if ('kind' in next) {
    const kind = next.kind;
    if (kind === undefined || (kind === null && !creating)) {
      delete next.kind;
    } else {
      const mapped = kindOf(kind);
      if (!mapped) return { error: `kind must be one of: ${KIND_LIST}.` };
      next.kind = mapped;
    }
  } else if (creating) {
    return { error: `kind must be one of: ${KIND_LIST}.` };
  }

  for (const [field, max] of [
    ['body', BODY_MAX],
    ['reporterName', REPORTER_MAX],
    ['externalUrl', URL_MAX],
  ] as const) {
    const value = next[field];
    if (typeof value === 'string') next[field] = clip(value, max);
  }

  if (typeof next.estimate === 'number' && Number.isFinite(next.estimate)) {
    next.estimate = Math.min(1000, Math.max(0, Math.round(next.estimate)));
  }

  return { args: next };
}
