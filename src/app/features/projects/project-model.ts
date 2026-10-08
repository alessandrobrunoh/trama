import { PROJECT_STATUSES, type Project, type ProjectStatus } from '../../core/contracts/domain';
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

export const isClosed = (p: Pick<Project, 'status'>): boolean => p.status === 'completed' || p.status === 'canceled';

/** Past its target date and not closed. */
export const isOverdue = (p: Pick<Project, 'status' | 'targetDate'>, now = Date.now()): boolean =>
  !!p.targetDate && !isClosed(p) && new Date(p.targetDate).getTime() < now;
