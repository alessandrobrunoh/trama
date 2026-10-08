// Keyword-overlap ranking used to find similar finished issues and likely workstreams.
// Pure and bounded: no Angular, at most `SCAN_LIMIT` items are looked at, each reduced to at most
// `TOKEN_LIMIT` distinct words. Score = IDF-weighted shared words, normalised (cosine on sets).

const SCAN_LIMIT = 3000;
const TOKEN_LIMIT = 80;

const STOP = new Set(
  (
    'the and for with that this from have has had not but are was were will can could should would into onto over under about ' +
    'when what which where while then than them they their there here your our you its via per use used using add fix make ' +
    'new get set issue issues bug task work item ' +
    'che per con una uno non del della delle dei degli nel nella sono come anche questo questa quando fare ' +
    'der die das und ist nicht mit les des une pour dans pas'
  ).split(' '),
);

/** Very light stemming so "login", "logins" and "logging" land near each other. */
function stem(w: string): string {
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Distinct, lower-cased, stemmed words of at least 3 characters (accents removed, stop words dropped). */
export function tokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u);
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(stem(w));
    if (out.size >= TOKEN_LIMIT) break;
  }
  return [...out];
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Items whose text overlaps the query, best first. `minScore` filters weak matches (default 0.08).
 * Ties keep the input order, so pass items newest first to prefer recent ones.
 */
export function rankByOverlap<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
  limit: number,
  minScore = 0.08,
): Ranked<T>[] {
  const q = tokens(query);
  if (!q.length || limit <= 0) return [];
  const docs = items.slice(0, SCAN_LIMIT).map((item) => ({ item, words: tokens(textOf(item)) }));

  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.words) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length + 1;
  const weight = (w: string) => Math.log(1 + n / (1 + (df.get(w) ?? 0)));

  const qSet = new Set(q);
  const qMass = q.reduce((a, w) => a + weight(w), 0);
  const ranked: (Ranked<T> & { at: number })[] = [];
  docs.forEach((d, at) => {
    if (!d.words.length) return;
    let shared = 0;
    let mass = 0;
    for (const w of d.words) {
      const x = weight(w);
      mass += x;
      if (qSet.has(w)) shared += x;
    }
    if (!shared) return;
    const score = shared / Math.sqrt(qMass * mass);
    if (score >= minScore) ranked.push({ item: d.item, score, at });
  });
  ranked.sort((a, b) => b.score - a.score || a.at - b.at);
  return ranked.slice(0, limit).map(({ item, score }) => ({ item, score }));
}
