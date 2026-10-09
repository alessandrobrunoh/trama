// Pure helpers for Settings → Import: select values for mapping targets, the mapping the form edited, job progress.
import { ISSUE_STATUSES } from '../../../core/meta';
import type {
  ID,
  ImportJob,
  ImportMapping,
  ImportPreview,
  ImportTarget,
  IssueStatus,
} from '../../../core/contracts/domain';

/** A mapping target as the value of a `<select>`: `create`, `skip` or `map:<trama id>`. */
export function encodeTarget(t: ImportTarget): string {
  return t.action === 'map' ? `map:${t.id}` : t.action;
}

export function decodeTarget(value: string): ImportTarget {
  if (value.startsWith('map:') && value.length > 4) return { action: 'map', id: value.slice(4) };
  return value === 'create' ? { action: 'create' } : { action: 'skip' };
}

/** What the form edits: select values keyed by the preview's ids. */
export interface MappingDraft {
  teams: Record<string, string>;
  projects: Record<string, string>;
  labels: Record<string, string>;
  /** Trama user id, or `''` for unassigned. */
  users: Record<string, string>;
  statuses: Record<string, IssueStatus>;
}

export function draftFromPreview(p: ImportPreview): MappingDraft {
  return {
    teams: Object.fromEntries(p.teams.map((t) => [t.id, encodeTarget(t.suggested)])),
    projects: Object.fromEntries(p.projects.map((x) => [x.id, encodeTarget(x.suggested)])),
    labels: Object.fromEntries(p.labels.map((l) => [l.id, encodeTarget(l.suggested)])),
    users: Object.fromEntries(p.users.map((u) => [u.id, u.suggestedUserId ?? ''])),
    statuses: Object.fromEntries(p.statuses.map((s) => [s.id, s.suggested])),
  };
}

const isStatus = (v: string): v is IssueStatus => (ISSUE_STATUSES as readonly string[]).includes(v);

export function mappingFromDraft(d: MappingDraft): ImportMapping {
  const targets = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, decodeTarget(v)]));
  return {
    teams: targets(d.teams),
    projects: targets(d.projects),
    labels: targets(d.labels),
    users: Object.fromEntries(Object.entries(d.users).map(([k, v]) => [k, (v || null) as ID | null])),
    statuses: Object.fromEntries(Object.entries(d.statuses).filter(([, v]) => isStatus(v))),
  };
}

export const emptyDraft = (): MappingDraft => ({ teams: {}, projects: {}, labels: {}, users: {}, statuses: {} });

export const PHASE_LABEL: Record<string, string> = {
  setup: 'Reading the source',
  issues: 'Importing issues',
  comments: 'Importing comments',
  done: 'Done',
};

/** 0-100, or `null` when the tracker did not say how many issues there are. */
export function importPercent(job: Pick<ImportJob, 'status' | 'progress'>): number | null {
  if (job.status === 'completed') return 100;
  const { total, processed, phase } = job.progress;
  if (!total) return null;
  const done = phase === 'comments' || phase === 'done' ? total : Math.min(processed, total);
  return Math.min(100, Math.round((done / total) * 100));
}

export function isActiveImport(job: Pick<ImportJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export const STATUS_TEXT: Record<ImportJob['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
};
