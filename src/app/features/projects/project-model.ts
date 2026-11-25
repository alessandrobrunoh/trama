import {
  PROJECT_STATUSES,
  defaultStatusCatalog,
  resolveStatusEntry,
  statusTypeOf,
  type Project,
  type ProjectStatus,
  type StatusEntry,
} from '../../core/contracts/domain';
import type { PickOption } from '../../shared/picker';

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

/** Status choices for a picker: the workspace catalog, each with its status glyph. */
export const projectStatusOptions = (entries = defaultStatusCatalog().project): PickOption[] =>
  entries.map((s) => ({
    value: s.id,
    label: s.name,
    kind: 'status' as const,
    statusEntity: 'project' as const,
  }));

export const isClosed = (p: Pick<Project, 'status'>, entries?: readonly StatusEntry<ProjectStatus>[]): boolean => {
  const type = statusTypeOf(entries ?? defaultStatusCatalog().project, p.status);
  return type === 'completed' || type === 'canceled';
};

export const projectStatusView = (
  status: string,
  entries = defaultStatusCatalog().project,
): { label: string; color: string } => {
  const entry = resolveStatusEntry(entries, status);
  return { label: entry?.name ?? status, color: entry?.color ?? '#8c9096' };
};

/** Past its target date and not closed. */
export const isOverdue = (p: Pick<Project, 'status' | 'targetDate'>, now = Date.now()): boolean =>
  !!p.targetDate && !isClosed(p) && new Date(p.targetDate).getTime() < now;
