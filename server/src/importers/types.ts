import type {
  ExternalProvider,
  ExternalStateType,
  ImportOptions,
  Priority,
} from '../contracts/domain.js';

/** A person in the external tracker. GitHub gives a login only; Linear gives an email. */
export interface ExternalUser {
  id: string;
  login?: string;
  name?: string;
  email?: string;
}

export interface ExternalState {
  id: string;
  name: string;
  /** The tracker's own category: GitHub `open` / `closed` / `not_planned`, Linear `triage` … `canceled`. */
  type: string;
}

export interface ExternalLabel {
  id: string;
  name: string;
  /** `#rrggbb` when the tracker has one. */
  color?: string;
}

export interface ExternalMilestone {
  id: string;
  name: string;
  /** The external project it belongs to (GitHub: the repository pseudo-project). */
  projectId?: string;
  description?: string;
  dueOn?: string;
}

export interface ExternalIssue {
  /** Stable id (see ExternalRef.id). */
  id: string;
  /** `#12` / `ENG-123`. */
  key: string;
  url: string;
  title: string;
  body: string | null;
  state: ExternalState;
  priority?: Priority;
  estimate?: number;
  labels: ExternalLabel[];
  assignee?: ExternalUser;
  creator?: ExternalUser;
  teamId?: string;
  projectId?: string;
  milestone?: ExternalMilestone;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  closedAt?: string;
}

export interface ExternalComment {
  id: string;
  /** Id of the external issue it belongs to. */
  issueId: string;
  author?: ExternalUser;
  body: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, `null` at the end. */
  next: string | null;
}

export interface DiscoveredEntity {
  id: string;
  name: string;
  key?: string;
  color?: string;
  count?: number;
}

/** What a source offers, before any mapping. */
export interface Discovery {
  provider: ExternalProvider;
  account: string;
  sourceLabel: string;
  sourceUrl?: string;
  counts: { issues: number | null; open: number | null; closed: number | null };
  teams: DiscoveredEntity[];
  projects: DiscoveredEntity[];
  labels: DiscoveredEntity[];
  milestones: ExternalMilestone[];
  users: ExternalUser[];
  statuses: (ExternalState & { count?: number })[];
  sample: { key: string; title: string; state: string }[];
  warnings: string[];
}

/** One tracker, read-only. Implementations only talk through HttpClient (and so through safe-fetch). */
export interface ImportSourceAdapter {
  readonly provider: ExternalProvider;
  discover(): Promise<Discovery>;
  issues(cursor: string | null, opts: Pick<ImportOptions, 'includeClosed'>): Promise<Page<ExternalIssue>>;
  comments(cursor: string | null): Promise<Page<ExternalComment>>;
  getIssue(id: string): Promise<ExternalIssue>;
}

export interface ParsedExternalUrl {
  provider: ExternalProvider;
  host: string;
  /** GitHub `owner/name`. */
  repository?: string;
  number?: number;
  /** Linear `ENG-123`. */
  identifier?: string;
  url: string;
}

export const STATE_TYPES: Record<string, ExternalStateType> = {
  open: 'open',
  triage: 'open',
  backlog: 'open',
  unstarted: 'open',
  started: 'in_progress',
  closed: 'done',
  completed: 'done',
  not_planned: 'canceled',
  canceled: 'canceled',
};
