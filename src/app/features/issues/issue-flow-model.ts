// Pure model of the Flow layout: a task as a track through the workspace's statuses.
//
// Each task is one row. The columns are the statuses in catalog order; the row draws one segment per stay
// in a status (read from the `issue.status_changed` events), and the length of a segment says how long the
// task stayed there. Without history the track is rebuilt from createdAt / startedAt / completedAt, so every
// task still renders. No Angular here, so the geometry is cheap to test.
import type { DomainEvent, Issue, IssueStatus, StatusEntry } from '../../core';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** An open task that has sat in one status this long is flagged ("idle 9d"). */
export const IDLE_DAYS = 7;
/** Stays of this length or longer draw at the full segment length (see `flowLength`). */
export const SCALE_CAP_DAYS = 30;

/** Statuses where waiting is the point: never flagged idle. */
const WAITING_TYPES: readonly string[] = ['backlog', 'draft'];

/** What the model needs of a catalog entry. */
export type FlowColumn = Pick<StatusEntry<IssueStatus>, 'id' | 'type'>;

export interface FlowStay {
  /** Index into the columns. */
  column: number;
  enteredAt: number;
  /** When the task left this status; null for the status it is in now. */
  leftAt: number | null;
  /** Time in the status, up to now for the current one. 0 for the final stay of a finished task. */
  durationMs: number;
  /** 0 on the first visit of a column in this row, 1+ when the task came back to it. */
  lane: number;
  /** The last stay of a finished (done / canceled) task: it has no duration, the track just ends. */
  terminal: boolean;
}

export interface FlowTrack {
  stays: FlowStay[];
  /** False when the track was rebuilt from the task's own dates because no status change was recorded. */
  fromHistory: boolean;
  closed: 'done' | 'canceled' | null;
  /** Idle flag: open task, 7d+ in the same status, outside the waiting statuses. */
  idle: boolean;
  /** Time in the current status (0 when there is none). */
  currentMs: number;
}

const ms = (iso: string | undefined | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** Column of a stored status: the entry with that id, else the first entry of that type (legacy enum values). */
export function columnIndex(columns: readonly FlowColumn[], status: unknown): number {
  if (typeof status !== 'string' || !status) return -1;
  const byId = columns.findIndex((c) => c.id === status);
  if (byId >= 0) return byId;
  const ofType = columns.findIndex((c) => c.type === status);
  return ofType;
}

interface Waypoint {
  column: number;
  at: number;
}

/** Waypoints from the status-change events: where the task started, then each move. */
function historyWaypoints(issue: Issue, events: readonly DomainEvent[], columns: readonly FlowColumn[]): Waypoint[] {
  const changes = events
    .filter((e) => e.type === 'issue.status_changed' && Number.isFinite(ms(e.at)))
    .sort((a, b) => ms(a.at) - ms(b.at));
  if (!changes.length) return [];
  const out: Waypoint[] = [];
  const from = columnIndex(columns, changes[0].data['from']);
  const created = ms(issue.createdAt);
  if (from >= 0 && Number.isFinite(created)) out.push({ column: from, at: Math.min(created, ms(changes[0].at)) });
  for (const e of changes) {
    const column = columnIndex(columns, e.data['to']);
    if (column >= 0) out.push({ column, at: ms(e.at) });
  }
  return out;
}

/** Waypoints from the task's own dates, for tasks without recorded status changes. */
function fallbackWaypoints(issue: Issue, columns: readonly FlowColumn[], current: number): Waypoint[] {
  const created = ms(issue.createdAt);
  if (!Number.isFinite(created) || current < 0) return [];
  const currentType = current >= 0 ? columns[current].type : undefined;
  const waiting = currentType === 'backlog' || currentType === 'draft' || currentType === 'todo';
  const out: Waypoint[] = [];
  if (waiting && current >= 0) return [{ column: current, at: created }];
  // Created in the first waiting status of the catalog, then started, then wherever it is now.
  const initial = ['backlog', 'todo', 'draft'].map((t) => columns.findIndex((c) => c.type === t)).find((i) => i >= 0) ?? 0;
  out.push({ column: initial, at: created });
  const started = ms(issue.startedAt);
  const inProgress = columns.findIndex((c) => c.type === 'in_progress');
  if (Number.isFinite(started) && inProgress >= 0) out.push({ column: inProgress, at: started });
  return out;
}

/**
 * The track of one task.
 * @param events the task's events in any order (only `issue.status_changed` is read)
 */
export function buildTrack(
  issue: Issue,
  events: readonly DomainEvent[],
  columns: readonly FlowColumn[],
  now: number = Date.now(),
  idleDays: number = IDLE_DAYS,
): FlowTrack {
  const current = columnIndex(columns, issue.status);
  let waypoints = historyWaypoints(issue, events, columns);
  const fromHistory = waypoints.length > 0;
  if (!fromHistory) waypoints = fallbackWaypoints(issue, columns, current);

  // The history may be cut short (events outside the loaded window): end on the task's real status.
  const last = waypoints[waypoints.length - 1];
  if (current >= 0 && (!last || last.column !== current)) {
    const closedAt = ms(issue.completedAt);
    const at = Math.max(last?.at ?? 0, Number.isFinite(closedAt) ? closedAt : ms(issue.updatedAt) || ms(issue.createdAt) || now);
    waypoints.push({ column: current, at });
  }

  // Time never runs backwards; consecutive waypoints in one column are a single stay.
  const steps: Waypoint[] = [];
  for (const w of waypoints) {
    const at = Math.min(Math.max(w.at, steps[steps.length - 1]?.at ?? w.at), now);
    if (steps[steps.length - 1]?.column === w.column) continue;
    steps.push({ column: w.column, at });
  }

  const type = current >= 0 ? columns[current].type : undefined;
  const closed = type === 'done' ? 'done' : type === 'canceled' ? 'canceled' : null;
  const seen = new Map<number, number>();
  const stays: FlowStay[] = steps.map((step, i) => {
    const next = steps[i + 1];
    const lane = seen.get(step.column) ?? 0;
    seen.set(step.column, lane + 1);
    const terminal = !next && closed !== null;
    const leftAt = next ? next.at : null;
    return {
      column: step.column,
      enteredAt: step.at,
      leftAt,
      durationMs: terminal ? 0 : Math.max(0, (leftAt ?? now) - step.at),
      lane,
      terminal,
    };
  });

  const here = stays[stays.length - 1];
  const currentMs = here && !here.terminal ? here.durationMs : 0;
  const idle = !!here && closed === null && !WAITING_TYPES.includes(type ?? '') && currentMs >= idleDays * DAY_MS;
  return { stays, fromHistory, closed, idle, currentMs };
}

export interface FlowGeometry {
  /** Width of one status column, px. */
  colWidth: number;
  /** Space between the column edge and a segment, px. */
  pad: number;
  /** Shortest segment, px: a stay of a few minutes stays visible. */
  minLen: number;
}

/**
 * Segment length for a time spent. A square-root scale between `minLen` and the column width: the first days
 * count for more than the later ones, so a 2h stay and a 3d stay are both visible and a 6-month stay does not
 * flatten everything else. Stays of `SCALE_CAP_DAYS` or more are drawn at the full length.
 */
export function flowLength(durationMs: number, geo: FlowGeometry, capDays: number = SCALE_CAP_DAYS): number {
  const max = geo.colWidth - geo.pad * 2;
  const ratio = Math.min(1, Math.max(0, durationMs) / (capDays * DAY_MS));
  return Math.round(geo.minLen + (max - geo.minLen) * Math.sqrt(ratio));
}

export interface FlowSegment extends FlowStay {
  /** Left edge of the segment in the row, px. */
  x: number;
  width: number;
}

export function layoutStays(stays: readonly FlowStay[], geo: FlowGeometry): FlowSegment[] {
  return stays.map((s) => ({
    ...s,
    x: s.column * geo.colWidth + geo.pad,
    width: s.terminal ? geo.minLen : flowLength(s.durationMs, geo),
  }));
}

export interface FlowLink {
  from: number;
  to: number;
  fromLane: number;
  toLane: number;
  /** The task went back to an earlier status (or a column to its left). */
  backward: boolean;
}

/** The lines joining one segment to the next. */
export function linkSegments(segments: readonly FlowSegment[]): FlowLink[] {
  const out: FlowLink[] = [];
  for (let i = 1; i < segments.length; i++) {
    const a = segments[i - 1];
    const b = segments[i];
    out.push({ from: a.x + a.width, to: b.x, fromLane: a.lane, toLane: b.lane, backward: b.column < a.column });
  }
  return out;
}

/** "<1h", "5h", "9d", "4mo": a span as the row and tooltip say it. */
export function formatSpan(durationMs: number): string {
  if (durationMs < HOUR_MS) return '<1h';
  if (durationMs < DAY_MS) return `${Math.floor(durationMs / HOUR_MS)}h`;
  const days = Math.floor(durationMs / DAY_MS);
  return days < 90 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}

/** "idle 9d" when the track is flagged, else null. */
export function idleLabel(track: FlowTrack): string | null {
  return track.idle ? `idle ${formatSpan(track.currentMs)}` : null;
}
