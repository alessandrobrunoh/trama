import {
  PROJECT_HEALTHS,
  PROJECT_STATUSES,
  type Project,
  type ProjectHealth,
  type ProjectStatus,
} from '../../core/contracts/domain';
import { PROJECT_HEALTH_META } from '../../core/meta';
import type { TramaStore } from '../../core/stores/trama.store';
import type { PickOption } from '../workstreams/picker';

export interface ProjectStatusMeta {
  label: string;
  /** Tailwind text colour (token-backed). */
  text: string;
  /** Tailwind background for the dot. */
  dot: string;
}

export const PROJECT_STATUS_META: Record<ProjectStatus, ProjectStatusMeta> = {
  backlog: { label: 'Backlog', text: 'text-status-draft', dot: 'bg-status-draft' },
  planned: { label: 'Planned', text: 'text-status-planned', dot: 'bg-status-planned' },
  in_progress: { label: 'In progress', text: 'text-status-working', dot: 'bg-status-working' },
  paused: { label: 'Paused', text: 'text-status-needs-input', dot: 'bg-status-needs-input' },
  completed: { label: 'Completed', text: 'text-status-shipped', dot: 'bg-status-shipped' },
  canceled: { label: 'Canceled', text: 'text-status-draft', dot: 'bg-status-draft' },
};

export const projectStatusOptions = (): PickOption[] =>
  PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_META[s].label }));

export const isClosed = (p: Pick<Project, 'status'>): boolean =>
  p.status === 'completed' || p.status === 'canceled';

/** Past its target date and not closed. */
export const isOverdue = (p: Pick<Project, 'status' | 'targetDate'>, now = Date.now()): boolean =>
  !!p.targetDate && !isClosed(p) && new Date(p.targetDate).getTime() < now;

export interface ProjectHealthStyle {
  label: string;
  /** Tailwind text colour (token-backed). */
  text: string;
  /** Tailwind tinted background. */
  bg: string;
  /** Tailwind border colour. */
  border: string;
  /** Tailwind background for the dot. */
  dot: string;
}

/** Colours of the three health values (statuses tokens: shipped = green, needs-input = amber, blocked = red). */
export const PROJECT_HEALTH_STYLE: Record<ProjectHealth, ProjectHealthStyle> = {
  on_track: {
    label: PROJECT_HEALTH_META.on_track.label,
    text: 'text-status-shipped',
    bg: 'bg-status-shipped/10',
    border: 'border-status-shipped/30',
    dot: 'bg-status-shipped',
  },
  at_risk: {
    label: PROJECT_HEALTH_META.at_risk.label,
    text: 'text-status-needs-input',
    bg: 'bg-status-needs-input/10',
    border: 'border-status-needs-input/30',
    dot: 'bg-status-needs-input',
  },
  off_track: {
    label: PROJECT_HEALTH_META.off_track.label,
    text: 'text-status-blocked',
    bg: 'bg-status-blocked/10',
    border: 'border-status-blocked/30',
    dot: 'bg-status-blocked',
  },
};

/** Health values in picker order (on track, at risk, off track). */
export const HEALTH_ORDER: readonly ProjectHealth[] = [...PROJECT_HEALTHS].sort(
  (a, b) => PROJECT_HEALTH_META[a].order - PROJECT_HEALTH_META[b].order,
);

/** An in-progress project is expected to post an update at least this often. */
export const UPDATE_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

/** In progress and the last update is missing or older than a week. */
export const isUpdateOverdue = (
  p: Pick<Project, 'status' | 'lastUpdateAt'>,
  now = Date.now(),
): boolean =>
  p.status === 'in_progress' &&
  (!p.lastUpdateAt || now - new Date(p.lastUpdateAt).getTime() > UPDATE_STALE_DAYS * DAY_MS);

/** Sort key for the list: worst health first, then no update yet. */
export const healthRank = (h: ProjectHealth | undefined): number =>
  h ? PROJECT_HEALTH_META[h].order + 1 : 0;

/** Who may post an update: the project lead, or anyone allowed to manage projects. */
export const canPostUpdate = (
  store: Pick<TramaStore, 'me' | 'allowed'>,
  p: Pick<Project, 'leadId'>,
): boolean => (!!p.leadId && p.leadId === store.me()?.id) || store.allowed('manageProjects');
