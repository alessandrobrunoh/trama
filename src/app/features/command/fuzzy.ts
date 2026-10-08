/**
 * Tiny cmdk-style scorer: 0 = no match. Prefix > word-start > substring >
 * in-order subsequence. Case-insensitive.
 */
export function fuzzyScore(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    const wordStart = idx === 0 || /[\s\-_/·]/.test(t[idx - 1]);
    return (wordStart ? 800 : 600) - idx;
  }
  // Every query token present somewhere ("go repo" → "Go to repositories").
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => t.includes(tok))) return 400;
  // Subsequence with gap penalty.
  let ti = 0;
  let gaps = 0;
  for (const ch of q.replace(/\s+/g, '')) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    gaps += found - ti;
    ti = found + 1;
  }
  return Math.max(1, 200 - gaps * 4);
}

/** Wrap-around index helper for listbox keyboard navigation. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (!length) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}
