import { distToRect } from "../shared/coords.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PathRequest {
  sx: number;
  sy: number;
  /** Goal rectangle; a tile satisfies the goal when its Chebyshev distance to the rect is <= range. */
  goal: Rect;
  range: number;
  /** Max search radius around the start (bounds memory and CPU). */
  radius: number;
  passable: (x: number, y: number) => boolean;
  /** Stop after this many node expansions (bounds the cost of failing searches). */
  maxExpansions?: number;
}

export type PathResult = { ok: true; path: { x: number; y: number }[] } | { ok: false; reason: string };

const DIRS = [
  [1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10],
  [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14],
] as const;

/**
 * Bounded A* on the tile grid with 8-way movement and no corner cutting.
 * The start tile may be blocked (a unit standing where a building was just placed can walk out).
 * Returns the path excluding the start tile.
 */
export function findPath(req: PathRequest): PathResult {
  const { sx, sy, goal, range, radius, passable } = req;
  if (distToRect(sx, sy, goal.x, goal.y, goal.w, goal.h) <= range && (range > 0 || passable(sx, sy) || (sx === goal.x && sy === goal.y))) {
    return { ok: true, path: [] };
  }
  if (distToRect(sx, sy, goal.x, goal.y, goal.w, goal.h) > radius) {
    return { ok: false, reason: `Destination is too far away (more than ${radius} tiles); move in shorter steps` };
  }
  const side = radius * 2 + 1;
  const n = side * side;
  const g = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const blockedCache = new Int8Array(n); // 0 unknown, 1 passable, 2 blocked
  const ox = sx - radius;
  const oy = sy - radius;
  const idx = (x: number, y: number): number => (y - oy) * side + (x - ox);
  const inBox = (x: number, y: number): boolean => x >= ox && y >= oy && x < ox + side && y < oy + side;
  const isPassable = (x: number, y: number): boolean => {
    const i = idx(x, y);
    const c = blockedCache[i];
    if (c === 1) return true;
    if (c === 2) return false;
    const p = passable(x, y);
    blockedCache[i] = p ? 1 : 2;
    return p;
  };
  const h = (x: number, y: number): number => {
    const d = distToRect(x, y, goal.x, goal.y, goal.w, goal.h) - range;
    return d > 0 ? d * 10 : 0;
  };

  // Binary heap of [f, index]
  const heapF: number[] = [];
  const heapI: number[] = [];
  const push = (f: number, i: number): void => {
    heapF.push(f);
    heapI.push(i);
    let c = heapF.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if ((heapF[p] as number) <= f) break;
      heapF[c] = heapF[p] as number;
      heapI[c] = heapI[p] as number;
      c = p;
    }
    heapF[c] = f;
    heapI[c] = i;
  };
  const pop = (): number => {
    const top = heapI[0] as number;
    const lf = heapF.pop() as number;
    const li = heapI.pop() as number;
    if (heapF.length > 0) {
      let c = 0;
      const len = heapF.length;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        let mf = lf;
        if (l < len && (heapF[l] as number) < mf) {
          m = l;
          mf = heapF[l] as number;
        }
        if (r < len && (heapF[r] as number) < mf) m = r;
        if (m === c) break;
        heapF[c] = heapF[m] as number;
        heapI[c] = heapI[m] as number;
        c = m;
      }
      heapF[c] = lf;
      heapI[c] = li;
    }
    return top;
  };

  const s = idx(sx, sy);
  g[s] = 0;
  push(h(sx, sy), s);
  let expansions = 0;
  const maxExpansions = Math.min(n, req.maxExpansions ?? n);
  while (heapF.length > 0) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expansions++;
    if (expansions > maxExpansions) return { ok: false, reason: "No route found within the search limit (the way may be blocked)" };
    const cx = (cur % side) + ox;
    const cy = Math.floor(cur / side) + oy;
    if (cur !== s && distToRect(cx, cy, goal.x, goal.y, goal.w, goal.h) <= range) {
      const path: { x: number; y: number }[] = [];
      let p = cur;
      while (p !== s && p !== -1) {
        path.push({ x: (p % side) + ox, y: Math.floor(p / side) + oy });
        p = parent[p] as number;
      }
      path.reverse();
      return { ok: true, path };
    }
    const gc = g[cur] as number;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBox(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      if (!isPassable(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!isPassable(cx + dx, cy) || !isPassable(cx, cy + dy))) continue;
      const ng = gc + cost;
      const old = g[ni] as number;
      if (old !== -1 && old <= ng) continue;
      g[ni] = ng;
      parent[ni] = cur;
      push(ng + h(nx, ny), ni);
    }
  }
  return { ok: false, reason: "Destination is unreachable (blocked by terrain, resources or buildings)" };
}
