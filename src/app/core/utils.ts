// Small helpers — ported from the React app's src/lib/utils.ts (minus `cn`, which
// Angular replaces with [class.x] bindings).

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[parts.length - 1][0] ?? ''}`.toUpperCase();
}

export function uid(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** True when a keyboard event target is an editable field (skip global shortcuts). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("[role='textbox']"));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Lexicographic rank strictly between two ranks (for drag-and-drop ordering). */
export function lexorankBetween(before: string | undefined, after: string | undefined): string {
  const a = before ?? '0';
  const b = after ?? 'z';
  if (a === b) return `${a}m`;
  let prefix = '';
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a.charCodeAt(i) || 48;
    const right = b.charCodeAt(i) || 123;
    if (right - left > 1) {
      const mid = Math.floor((left + right) / 2);
      return prefix + String.fromCharCode(mid);
    }
    prefix += String.fromCharCode(left);
  }
  return `${a}n`;
}

/** Avatar background for a user hue (same formula as the React app). */
export function avatarColor(hue: number): string {
  return `hsl(${hue} 32% 38%)`;
}

/** Label/tag tint: the label color mixed into transparent at `pct`%. */
export function tint(color: string, pct = 18): string {
  return `color-mix(in oklab, ${color} ${pct}%, transparent)`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
