// Line diff and three-way merge for document text. Pure (no Angular, no DOM), tested from the server suite.

export type DiffOp = { t: 'eq' | 'del' | 'add'; line: string };

/** LCS tables above this many cells are not worth building: the changed middle is shown as one replacement. */
const MAX_CELLS = 4_000_000;

/** Lines of `a` → lines of `b` as equal / removed / added lines, in order. */
export function lineDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffOp[] = [];
  for (let i = 0; i < start; i++) out.push({ t: 'eq', line: a[i] });
  const n = endA - start;
  const m = endB - start;
  if (n && m && n * m <= MAX_CELLS) {
    // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * w + j + 1] + 1
            : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ t: 'eq', line: a[start + i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        out.push({ t: 'del', line: a[start + i++] });
      } else {
        out.push({ t: 'add', line: b[start + j++] });
      }
    }
    while (i < n) out.push({ t: 'del', line: a[start + i++] });
    while (j < m) out.push({ t: 'add', line: b[start + j++] });
  } else {
    for (let i = start; i < endA; i++) out.push({ t: 'del', line: a[i] });
    for (let j = start; j < endB; j++) out.push({ t: 'add', line: b[j] });
  }
  for (let i = endA; i < a.length; i++) out.push({ t: 'eq', line: a[i] });
  return out;
}

export function diffStats(ops: readonly DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === 'add') added++;
    else if (o.t === 'del') removed++;
  }
  return { added, removed };
}

/** The base lines [s, e) were replaced by `repl`. */
interface Hunk {
  s: number;
  e: number;
  repl: string[];
}

function hunksOf(base: readonly string[], other: readonly string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let pos = 0;
  let open: Hunk | null = null;
  for (const op of lineDiff(base, other)) {
    if (op.t === 'eq') {
      open = null;
      pos++;
    } else {
      open ??= { s: pos, e: pos, repl: [] };
      if (!hunks.includes(open)) hunks.push(open);
      if (op.t === 'del') {
        pos++;
        open.e = pos;
      } else open.repl.push(op.line);
    }
  }
  return hunks;
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((l, i) => l === b[i]);

function overlaps(a: Hunk, b: Hunk): boolean {
  if (a.s === a.e && b.s === b.e) return a.s === b.s;
  return a.s < b.e && b.s < a.e;
}

export interface MergeResult {
  /** The merged text. With conflicts, both sides are kept between `<<<<<<<` / `=======` / `>>>>>>>` markers. */
  text: string;
  conflicts: number;
}

/**
 * Three-way merge by lines: `base` is what both sides started from, `mine` the local text and `theirs`
 * the other side's. Changes in different places combine; the same change on both sides counts once;
 * overlapping different changes are conflicts.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { text: mine, conflicts: 0 };
  if (base === mine) return { text: theirs, conflicts: 0 };
  if (base === theirs) return { text: mine, conflicts: 0 };
  const b = base.split('\n');
  const a = mine.split('\n');
  const t = theirs.split('\n');
  const ha = hunksOf(b, a);
  const ht = hunksOf(b, t);
  const out: string[] = [];
  let conflicts = 0;
  let pos = 0;
  let i = 0;
  let j = 0;
  const copyTo = (to: number) => {
    out.push(...b.slice(pos, to));
    pos = to;
  };
  while (i < ha.length || j < ht.length) {
    const x = ha[i];
    const y = ht[j];
    if (x && (!y || (!overlaps(x, y) && x.s <= y.s))) {
      copyTo(x.s);
      out.push(...x.repl);
      pos = x.e;
      i++;
    } else if (y && (!x || !overlaps(x, y))) {
      copyTo(y.s);
      out.push(...y.repl);
      pos = y.e;
      j++;
    } else {
      // overlapping hunks: grow the region while more hunks of either side touch it
      let start = Math.min(x.s, y.s);
      let end = Math.max(x.e, y.e);
      const mineHunks = [x];
      const theirHunks = [y];
      i++;
      j++;
      for (let grew = true; grew;) {
        grew = false;
        const region: Hunk = { s: start, e: end, repl: [] };
        while (i < ha.length && (overlaps(ha[i], region) || ha[i].s === end)) {
          mineHunks.push(ha[i]);
          end = Math.max(end, ha[i].e);
          i++;
          grew = true;
        }
        while (j < ht.length && (overlaps(ht[j], region) || ht[j].s === end)) {
          theirHunks.push(ht[j]);
          end = Math.max(end, ht[j].e);
          j++;
          grew = true;
        }
      }
      start = Math.min(start, ...mineHunks.map((h) => h.s), ...theirHunks.map((h) => h.s));
      const side = (hunks: Hunk[]) => {
        const lines: string[] = [];
        let p = start;
        for (const h of hunks) {
          lines.push(...b.slice(p, h.s), ...h.repl);
          p = h.e;
        }
        lines.push(...b.slice(p, end));
        return lines;
      };
      const mineLines = side(mineHunks);
      const theirLines = side(theirHunks);
      copyTo(start);
      if (sameLines(mineLines, theirLines)) out.push(...mineLines);
      else {
        conflicts++;
        out.push('<<<<<<< yours', ...mineLines, '=======', ...theirLines, '>>>>>>> theirs');
      }
      pos = end;
    }
  }
  copyTo(b.length);
  return { text: out.join('\n'), conflicts };
}
