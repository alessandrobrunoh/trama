// Pure helpers for the timeline: zoom levels, the column scale (weeks / months / quarters with
// month / year headers) and the status → colour mapping of the bars.
import { addMonths, addQuarters, addWeeks, format, startOfMonth, startOfQuarter, startOfWeek } from 'date-fns';
import type { Project, ProjectHealth, ProjectStatus, WeekStart, WorkstreamStatus } from '../../core';
import { dateOfDay, dayOf } from '../milestones/milestone-model';

export type Zoom = 'week' | 'month' | 'quarter';

export const ZOOMS: { id: Zoom; label: string; pxPerDay: number }[] = [
  { id: 'week', label: 'Week', pxPerDay: 18 },
  { id: 'month', label: 'Month', pxPerDay: 6 },
  { id: 'quarter', label: 'Quarter', pxPerDay: 2.2 },
];

export interface ScaleCol {
  start: number;
  /** Exclusive. */
  end: number;
  label: string;
  alt: boolean;
}

export interface ScaleTop {
  start: number;
  end: number;
  label: string;
}

export interface Scale {
  startDay: number;
  endDay: number;
  cols: ScaleCol[];
  tops: ScaleTop[];
}

const WEEK_ON: Record<WeekStart, 0 | 1 | 6> = { sunday: 0, monday: 1, saturday: 6 };

/** Columns and header groups covering at least [from, to]. */
export function buildScale(zoom: Zoom, from: number, to: number, weekStart: WeekStart): Scale {
  const cols: ScaleCol[] = [];
  const tops: ScaleTop[] = [];
  const a = dateOfDay(from);
  const b = dateOfDay(to);

  if (zoom === 'week') {
    let d = startOfWeek(a, { weekStartsOn: WEEK_ON[weekStart] });
    let i = 0;
    while (d <= b) {
      const next = addWeeks(d, 1);
      cols.push({ start: dayOf(d), end: dayOf(next), label: format(d, 'd'), alt: i++ % 2 === 1 });
      d = next;
    }
  } else if (zoom === 'month') {
    let d = startOfMonth(a);
    let i = 0;
    while (d <= b) {
      const next = addMonths(d, 1);
      cols.push({ start: dayOf(d), end: dayOf(next), label: format(d, 'MMM'), alt: i++ % 2 === 1 });
      d = next;
    }
  } else {
    let d = startOfQuarter(a);
    let i = 0;
    while (d <= b) {
      const next = addQuarters(d, 1);
      cols.push({ start: dayOf(d), end: dayOf(next), label: `Q${Math.floor(d.getMonth() / 3) + 1}`, alt: i++ % 2 === 1 });
      d = next;
    }
  }

  const startDay = cols[0].start;
  const endDay = cols[cols.length - 1].end;
  // header groups: months for week zoom, years otherwise
  if (zoom === 'week') {
    let d = startOfMonth(dateOfDay(startDay));
    while (dayOf(d) < endDay) {
      const next = addMonths(d, 1);
      tops.push({ start: Math.max(startDay, dayOf(d)), end: Math.min(endDay, dayOf(next)), label: format(d, 'MMMM yyyy') });
      d = next;
    }
  } else {
    for (let y = dateOfDay(startDay).getFullYear(); dayOf(new Date(y, 0, 1)) < endDay; y++) {
      tops.push({ start: Math.max(startDay, dayOf(new Date(y, 0, 1))), end: Math.min(endDay, dayOf(new Date(y + 1, 0, 1))), label: String(y) });
    }
  }
  return { startDay, endDay, cols, tops };
}

/** Token colour of a workstream status (the same tones as the status glyphs). */
export const STATUS_TONE: Record<WorkstreamStatus, string> = {
  draft: 'var(--status-draft)',
  planned: 'var(--status-planned)',
  working: 'var(--status-working)',
  needs_input: 'var(--status-needs-input)',
  in_review: 'var(--status-in-review)',
  blocked: 'var(--status-blocked)',
  ready_to_land: 'var(--status-ready-to-land)',
  shipped: 'var(--status-shipped)',
  canceled: 'var(--status-canceled)',
};

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

/** Colour of a project bar: its health while it is open, otherwise its status. */
export function projectTone(p: Pick<Project, 'status' | 'health'>): string {
  const closed = p.status === 'completed' || p.status === 'canceled';
  return p.health && !closed ? PROJECT_HEALTH_TONE[p.health] : PROJECT_STATUS_TONE[p.status];
}

export const mix = (color: string, pct: number): string => `color-mix(in oklab, ${color} ${pct}%, transparent)`;

export const HATCH = 'repeating-linear-gradient(135deg, color-mix(in oklab, var(--status-blocked) 55%, transparent) 0 2px, transparent 2px 6px)';
