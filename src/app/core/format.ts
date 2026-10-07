// Date formatting — ported from the React app's src/lib/format.ts (date-fns).
import {
  format,
  formatDistanceToNowStrict,
  isToday,
  isTomorrow,
  isYesterday,
  parseISO,
} from 'date-fns';

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
  return format(parseISO(iso), 'MMM d, yyyy');
}

/** True when an ISO due date is before today (and not today). */
export function isOverdue(iso?: string): boolean {
  if (!iso) return false;
  const date = parseISO(iso);
  if (isToday(date)) return false;
  return date.getTime() < Date.now();
}
