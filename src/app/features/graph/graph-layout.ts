/**
 * Small layered (Sugiyama-style) DAG layout, left to right. No dependencies.
 *
 *  1. break cycles (DFS back edges are laid out reversed, drawn in their real direction)
 *  2. rank = longest path from a source (every edge points right)
 *  3. long edges get dummy nodes in the ranks they cross, so they route through free space
 *  4. order each rank with barycenter sweeps (keeping the ordering with the fewest crossings)
 *  5. vertical placement: each node wants to sit at the mean y of its neighbours; per rank the
 *     closest non-overlapping arrangement (order preserved) is found with a pool-adjacent-violators pass
 */

export interface LayoutNodeIn {
  id: string;
  w: number;
  h: number;
}
export interface LayoutEdgeIn {
  id: string;
  source: string;
  target: string;
}
export interface Point {
  x: number;
  y: number;
}
export interface PlacedNode {
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
}
export interface LayoutResult {
  nodes: Map<string, PlacedNode>;
  /** Polyline anchors per edge, from the source's right-middle to the target's left-middle. */
  routes: Map<string, Point[]>;
  width: number;
  height: number;
}
export interface LayoutConfig {
  gapX: number;
  gapY: number;
  padding: number;
  sweeps: number;
}
const DEFAULTS: LayoutConfig = { gapX: 72, gapY: 14, padding: 32, sweeps: 8 };

interface Item {
  id: string;
  w: number;
  h: number;
  dummy: boolean;
  rank: number;
  /** initial DFS order */
  seq: number;
  y: number;
  preds: Item[];
  succs: Item[];
}

export function layoutGraph(
  nodesIn: readonly LayoutNodeIn[],
  edgesIn: readonly LayoutEdgeIn[],
  config: Partial<LayoutConfig> = {},
): LayoutResult {
  const cfg = { ...DEFAULTS, ...config };
  const items = new Map<string, Item>();
  for (const n of nodesIn) {
    items.set(n.id, { id: n.id, w: n.w, h: n.h, dummy: false, rank: 0, seq: 0, y: 0, preds: [], succs: [] });
  }
  if (!items.size) return { nodes: new Map(), routes: new Map(), width: 0, height: 0 };

  // ── 1. cycle breaking ───────────────────────────────────────────────
  interface LEdge {
    id: string;
    from: string;
    to: string;
    reversed: boolean;
  }
  const valid = edgesIn.filter((e) => items.has(e.source) && items.has(e.target) && e.source !== e.target);
  const out = new Map<string, string[]>();
  for (const n of nodesIn) out.set(n.id, []);
  for (const e of valid) out.get(e.source)!.push(e.target);
  const color = new Map<string, 0 | 1 | 2>();
  const backEdges = new Set<string>(); // "u>v"
  for (const n of nodesIn) {
    if (color.get(n.id)) continue;
    // iterative DFS
    const stack: { id: string; i: number }[] = [{ id: n.id, i: 0 }];
    color.set(n.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = out.get(top.id)![top.i++];
      if (next === undefined) {
        color.set(top.id, 2);
        stack.pop();
        continue;
      }
      const c = color.get(next) ?? 0;
      if (c === 1) backEdges.add(`${top.id}>${next}`);
      else if (c === 0) {
        color.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }
  const ledges: LEdge[] = valid.map((e) =>
    backEdges.has(`${e.source}>${e.target}`)
      ? { id: e.id, from: e.target, to: e.source, reversed: true }
      : { id: e.id, from: e.source, to: e.target, reversed: false },
  );

  // ── 2. ranking (longest path) ───────────────────────────────────────
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodesIn) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of ledges) {
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const queue: string[] = nodesIn.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const rank = new Map<string, number>(nodesIn.map((n) => [n.id, 0]));
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of adj.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  for (const [id, r] of rank) items.get(id)!.rank = r;

  // initial order: DFS pre-order from the sources, in input order (keeps subtrees together)
  let seq = 0;
  const seen = new Set<string>();
  const dfsOrder = (rootId: string): void => {
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      items.get(id)!.seq = seq++;
      const children = adj.get(id)!;
      for (let i = children.length - 1; i >= 0; i--) if (!seen.has(children[i])) stack.push(children[i]);
    }
  };
  for (const n of nodesIn) if (rank.get(n.id) === 0) dfsOrder(n.id);
  for (const n of nodesIn) dfsOrder(n.id);

  // ── 3. dummies for long edges ───────────────────────────────────────
  const chains = new Map<string, { chain: Item[]; reversed: boolean }>();
  let dummyN = 0;
  for (const e of ledges) {
    const a = items.get(e.from)!;
    const b = items.get(e.to)!;
    const chain: Item[] = [a];
    for (let r = a.rank + 1; r < b.rank; r++) {
      const d: Item = {
        id: `__d${dummyN++}`,
        w: 0,
        h: 2,
        dummy: true,
        rank: r,
        seq: a.seq + (r - a.rank) * 0.001,
        y: 0,
        preds: [],
        succs: [],
      };
      chain.push(d);
    }
    chain.push(b);
    for (let i = 0; i < chain.length - 1; i++) {
      chain[i].succs.push(chain[i + 1]);
      chain[i + 1].preds.push(chain[i]);
    }
    chains.set(e.id, { chain, reversed: e.reversed });
  }

  const maxRank = Math.max(...[...items.values()].map((i) => i.rank));
  const layers: Item[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const i of items.values()) layers[i.rank].push(i);
  for (const { chain } of chains.values()) for (const d of chain) if (d.dummy) layers[d.rank].push(d);
  for (const l of layers) l.sort((a, b) => a.seq - b.seq);

  // ── 4. crossing reduction ───────────────────────────────────────────
  const pos = new Map<Item, number>();
  const repos = (): void => layers.forEach((l) => l.forEach((n, i) => pos.set(n, i)));
  repos();
  const crossings = (): number => {
    let total = 0;
    for (let r = 0; r < layers.length - 1; r++) {
      const es: [number, number][] = [];
      for (const u of layers[r]) for (const v of u.succs) es.push([pos.get(u)!, pos.get(v)!]);
      for (let i = 0; i < es.length; i++)
        for (let j = i + 1; j < es.length; j++)
          if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) total++;
    }
    return total;
  };
  const sortByBary = (layer: Item[], neighbours: (n: Item) => Item[]): void => {
    const key = new Map<Item, number>();
    for (const n of layer) {
      const nb = neighbours(n);
      key.set(n, nb.length ? nb.reduce((s, x) => s + pos.get(x)!, 0) / nb.length : pos.get(n)!);
    }
    layer.sort((a, b) => key.get(a)! - key.get(b)! || pos.get(a)! - pos.get(b)!);
    layer.forEach((n, i) => pos.set(n, i));
  };
  let best = layers.map((l) => [...l]);
  let bestCross = crossings();
  for (let it = 0; it < cfg.sweeps && bestCross > 0; it++) {
    if (it % 2 === 0) for (let r = 1; r < layers.length; r++) sortByBary(layers[r], (n) => n.preds);
    else for (let r = layers.length - 2; r >= 0; r--) sortByBary(layers[r], (n) => n.succs);
    const c = crossings();
    if (c < bestCross) {
      bestCross = c;
      best = layers.map((l) => [...l]);
    }
  }
  best.forEach((l, r) => (layers[r] = l));
  repos();

  // ── 5. coordinates ──────────────────────────────────────────────────
  const gap = (a: Item, b: Item): number => (a.dummy || b.dummy ? 8 : cfg.gapY);
  for (const l of layers) {
    let y = 0;
    l.forEach((n, i) => {
      n.y = y;
      y += n.h + (i < l.length - 1 ? gap(n, l[i + 1]) : 0);
    });
  }
  const placeLayer = (l: Item[], want: (n: Item) => number | undefined): void => {
    if (!l.length) return;
    // z_i = y_i - offset_i must be non-decreasing; minimise sum (z_i - (d_i - offset_i))^2 with PAVA
    const offsets: number[] = [];
    let acc = 0;
    l.forEach((n, i) => {
      offsets.push(acc);
      acc += n.h + (i < l.length - 1 ? gap(n, l[i + 1]) : 0);
    });
    const blocks: { sum: number; count: number }[] = [];
    l.forEach((n, i) => {
      const w = want(n);
      const d = (w === undefined ? n.y : w - n.h / 2) - offsets[i];
      blocks.push({ sum: d, count: 1 });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1];
        const a = blocks[blocks.length - 2];
        if (a.sum / a.count > b.sum / b.count) {
          a.sum += b.sum;
          a.count += b.count;
          blocks.pop();
        } else break;
      }
    });
    let i = 0;
    for (const b of blocks) {
      const z = b.sum / b.count;
      for (let k = 0; k < b.count; k++, i++) l[i].y = z + offsets[i];
    }
  };
  const center = (n: Item): number => n.y + n.h / 2;
  const mean = (xs: Item[]): number | undefined => (xs.length ? xs.reduce((s, x) => s + center(x), 0) / xs.length : undefined);
  for (let it = 0; it < 12; it++) {
    if (it % 2 === 0) for (let r = 1; r < layers.length; r++) placeLayer(layers[r], (n) => mean(n.preds));
    else for (let r = layers.length - 2; r >= 0; r--) placeLayer(layers[r], (n) => mean(n.succs));
  }
  // final balanced pass (both sides) so parents sit between their parents and children
  for (let it = 0; it < 4; it++) {
    for (let r = 0; r < layers.length; r++) {
      placeLayer(layers[r], (n) => mean([...n.preds, ...n.succs]));
    }
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const l of layers) {
    for (const n of l) {
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y + n.h);
    }
  }
  const dy = cfg.padding - minY;
  for (const l of layers) for (const n of l) n.y += dy;

  const rankW = layers.map((l) => Math.max(0, ...l.filter((n) => !n.dummy).map((n) => n.w)));
  const rankX: number[] = [];
  let x = cfg.padding;
  layers.forEach((l, r) => {
    rankX.push(x);
    const w = rankW[r] || 16;
    x += w + (rankW[r] ? cfg.gapX : cfg.gapX / 2);
  });
  const width = x - cfg.gapX + cfg.padding;
  const height = maxY + dy + cfg.padding;

  const nodes = new Map<string, PlacedNode>();
  for (const n of items.values()) nodes.set(n.id, { x: rankX[n.rank], y: n.y, w: n.w, h: n.h, rank: n.rank });

  const routes = new Map<string, Point[]>();
  for (const [edgeId, { chain, reversed }] of chains) {
    const pts: Point[] = [];
    chain.forEach((n, i) => {
      const cy = n.y + n.h / 2;
      if (n.dummy) {
        pts.push({ x: rankX[n.rank], y: cy }, { x: rankX[n.rank] + (rankW[n.rank] || 16), y: cy });
      } else if (i === 0) pts.push({ x: rankX[n.rank] + n.w, y: cy });
      else pts.push({ x: rankX[n.rank], y: cy });
    });
    routes.set(edgeId, reversed ? pts.reverse() : pts);
  }
  return { nodes, routes, width, height };
}

/** SVG path through the anchors with horizontal tangents at every anchor (smooth S-curves). */
export function routePath(pts: readonly Point[]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.y === b.y) {
      d += ` L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
      continue;
    }
    const mx = (a.x + b.x) / 2;
    d += ` C${mx.toFixed(1)},${a.y.toFixed(1)} ${mx.toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  return d;
}
