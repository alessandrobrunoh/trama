export interface SnoozePreset {
  id: string;
  label: string;
  /** Short hint shown right-aligned in the menu ("9:00 AM", "Mon"). */
  hint: string;
  until: string;
}

const time = (d: Date) =>
  d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');

/** 9:00 local on the given calendar day. */
export function morningOf(day: Date): Date {
  const d = new Date(day);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** Quick snooze presets, relative to now. */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const hour = new Date(now.getTime() + 60 * 60_000);
  const tomorrow = morningOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  // next Monday (always in the future, 1-7 days ahead)
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = morningOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday));
  return [
    { id: '1h', label: 'In 1 hour', hint: time(hour), until: hour.toISOString() },
    { id: 'tomorrow', label: 'Tomorrow', hint: time(tomorrow), until: tomorrow.toISOString() },
    {
      id: 'week',
      label: 'Next week',
      hint: monday.toLocaleDateString([], { weekday: 'short' }),
      until: monday.toISOString(),
    },
  ];
}
