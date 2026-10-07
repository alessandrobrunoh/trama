/** Workstream keys such as AUTH-42 (team key + number). */
const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const KEY_RE_CI = /\b[A-Za-z][A-Za-z0-9]{1,9}-\d+\b/g;

/**
 * Candidate workstream keys found in free text (title, body, commit message).
 * `ignoreCase` is for branch names (`auth-42/replay-detection`). Results are
 * upper-cased, de-duplicated, and — when `known` is given — validated against it.
 */
export function extractKeys(
  texts: ReadonlyArray<string | null | undefined>,
  opts: { ignoreCase?: boolean; known?: ReadonlySet<string> | ReadonlyMap<string, unknown> } = {},
): string[] {
  const re = opts.ignoreCase ? KEY_RE_CI : KEY_RE;
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(re)) {
      const key = m[0].toUpperCase();
      if (!opts.known || opts.known.has(key)) out.add(key);
    }
  }
  return [...out];
}
