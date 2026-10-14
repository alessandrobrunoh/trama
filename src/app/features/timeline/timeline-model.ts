import type { Project, ProjectHealth, ProjectStatus } from '../../core';

const PROJECT_STATUS_TONE: Record<ProjectStatus, string> = {
  backlog: 'var(--status-draft)',
  planned: 'var(--status-planned)',
  in_progress: 'var(--status-working)',
  paused: 'var(--status-needs-input)',
  completed: 'var(--status-shipped)',
  canceled: 'var(--status-canceled)',
};

const PROJECT_HEALTH_TONE: Record<ProjectHealth, string> = {
  on_track: 'var(--status-shipped)',
  at_risk: 'var(--status-needs-input)',
  off_track: 'var(--status-blocked)',
};

/** Colour of a project: its health while it is open, otherwise its status. */
export function projectTone(p: Pick<Project, 'status' | 'health'>): string {
  const closed = p.status === 'completed' || p.status === 'canceled';
  return p.health && !closed ? PROJECT_HEALTH_TONE[p.health] : PROJECT_STATUS_TONE[p.status];
}
