import type { Project, ProjectStatus } from '../../core';

const PROJECT_STATUS_TONE: Record<ProjectStatus, string> = {
  backlog: 'var(--status-draft)',
  planned: 'var(--status-planned)',
  in_progress: 'var(--status-working)',
  paused: 'var(--status-needs-input)',
  completed: 'var(--status-shipped)',
  canceled: 'var(--status-canceled)',
};

/** Colour of a project: its status. */
export function projectTone(p: Pick<Project, 'status'>): string {
  return PROJECT_STATUS_TONE[p.status];
}
