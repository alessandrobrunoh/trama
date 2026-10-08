// Date formatting — ported from the React app's src/lib/format.ts (date-fns).
import {
  format,
  formatDistanceToNowStrict,
  isToday,
  isTomorrow,
  isYesterday,
  parseISO,
} from 'date-fns';

let displayZone: string | undefined;
/** Workspace time zone (Settings → General). `undefined` follows the browser. */
export function setDisplayTimeZone(zone: string | undefined): void {
  displayZone = zone;
}

/** "just now", "3 hours ago", "in 2 days". */
export function relativeTime(iso: string): string {
  const date = parseISO(iso);
  const diff = Date.now() - date.getTime();
  if (diff < 45_000 && diff >= 0) return 'just now';
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** "Today" / "Yesterday" / "Tomorrow" / "Sep 8". */
export function shortDate(iso?: string): string {
  if (!iso) return '';
  const date = parseISO(iso);
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  if (isTomorrow(date)) return 'Tomorrow';
  return format(date, 'MMM d');
}

/** "Sep 8 – 21" or "Sep 28 – Oct 11". */
export function rangeDate(start: string, end: string): string {
  const a = parseISO(start);
  const b = parseISO(end);
  if (a.getMonth() === b.getMonth()) return `${format(a, 'MMM d')} – ${format(b, 'd')}`;
  return `${format(a, 'MMM d')} – ${format(b, 'MMM d')}`;
}

/** "Sep 8, 2026". */
export function fullDate(iso: string): string {
  if (displayZone) {
    try {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: displayZone }).format(parseISO(iso));
    } catch {
      /* invalid zone: fall through to the local format */
    }
  }
  return format(parseISO(iso), 'MMM d, yyyy');
}

/** "Sep 8, 2026, 14:32" in the workspace time zone (browser's when none). */
export function fullDateTime(iso: string): string {
  if (displayZone) {
    try {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: displayZone }).format(parseISO(iso));
    } catch {
      /* invalid zone: fall through to the local format */
    }
  }
  return format(parseISO(iso), 'MMM d, yyyy, HH:mm');
}

/** "2d 4h", "5h 20m", "12d", "<1m": a span in milliseconds for cycle times. */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '<1m';
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 10) return `${d}d`;
  if (d >= 1) return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  if (h >= 1) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  return `${min}m`;
}

/** True when an ISO due date is before today (and not today). */
export function isOverdue(iso?: string): boolean {
  if (!iso) return false;
  const date = parseISO(iso);
  if (isToday(date)) return false;
  return date.getTime() < Date.now();
}
