import { floorDiv } from "../shared/coords.ts";

/**
 * Coarse (hierarchical) route planning for long journeys.
 *
 * The world is divided into CELL x CELL tile cells. A cell counts as open when at
 * least OPEN_SAMPLES of its 16 sampled tiles are passable. A* over cells finds a
 * corridor around lakes and ridges cheaply; units then walk it in exact legs.
 * Cell openness is cached for a while because terrain rarely changes (trees and
 * buildings do, which is why entries expire).
 */
export const CELL = 8;
const OPEN_SAMPLES = 5;
const CACHE_TTL_TICKS = 3000;
const MAX_CACHE = 200_000;
/** How long a failed corridor search between the same two cells is not repeated. */
const FAILED_TTL_TICKS = 300;
/** Cells explored backwards from the goal to detect an enclosed goal cheaply. */
const ENCLOSED_PROBE = 400;

export class CoarseMap {
  /** Passable samples (0-16) per cell. */
  private cache = new Map<number, { n: number; tick: number }>();
  private readonly passable: (x: number, y: number) => boolean;
  /** Recently failed (start cell -> goal cell) searches; a failure costs the full expansion budget. */
  private failed = new Map<string, number>();
  constructor(passable: (x: number, y: number) => boolean) {
    this.passable = passable;
  }

  private key(cx: number, cy: number): number {
    return (cx + 262_144) * 524_288 + (cy + 262_144);
  }

  /** Number of passable sampled tiles in a cell (0-16). */
  samples(cx: number, cy: number, tick: number): number {
    const k = this.key(cx, cy);
    const c = this.cache.get(k);
    if (c && tick - c.tick < CACHE_TTL_TICKS) return c.n;
    let n = 0;
    for (let sy = 1; sy < CELL; sy += 2) for (let sx = 1; sx < CELL; sx += 2) if (this.passable(cx * CELL + sx, cy * CELL + sy)) n++;
    if (this.cache.size > MAX_CACHE) this.cache.clear();
    this.cache.set(k, { n, tick });
    return n;
  }

  isOpen(cx: number, cy: number, tick: number): boolean {
    return this.samples(cx, cy, tick) >= OPEN_SAMPLES;
  }

  /** Traversal cost of a cell: cluttered cells (dense forest) are avoided when open land exists. */
  private cost(cx: number, cy: number, tick: number): number {
    return 1 + (16 - this.samples(cx, cy, tick)) / 3;
  }

  /**
   * True when the open area around (cx, cy) is fully explored within `limit` cells without
   * reaching (sx, sy): nothing outside that pocket can reach it. Movement rules match route().
   */
  private enclosed(cx: number, cy: number, sx: number, sy: number, tick: number, limit: number): boolean {
    const seen = new Set<number>([this.key(cx, cy)]);
    const queue: [number, number][] = [[cx, cy]];
    const open = (x: number, y: number): boolean => (x === sx && y === sy) || this.isOpen(x, y, tick);
    for (let i = 0; i < queue.length; i++) {
      if (seen.size > limit) return false;
      const [x, y] = queue[i] as [number, number];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!open(nx, ny)) continue;
          if (dx && dy && (!open(x + dx, y) || !open(x, y + dy))) continue;
          if (nx === sx && ny === sy) return false;
          const k = this.key(nx, ny);
          if (seen.has(k)) continue;
          seen.add(k);
          queue.push([nx, ny]);
        }
      }
    }
    return true;
  }

  /**
   * Cell-centre waypoints from (sx, sy) to (gx, gy), excluding the start cell, or null when
   * no corridor exists within `radiusCells`. The start and goal cells always count as open.
   */
  route(sx: number, sy: number, gx: number, gy: number, tick: number, radiusCells = 96, maxExpansions = 6_000): { x: number; y: number }[] | null {
    const scx = floorDiv(sx, CELL);
    const scy = floorDiv(sy, CELL);
    const gcx = floorDiv(gx, CELL);
    const gcy = floorDiv(gy, CELL);
    if (Math.max(Math.abs(gcx - scx), Math.abs(gcy - scy)) > radiusCells) return null;
    const fkey = `${scx},${scy}>${gcx},${gcy}`;
    const until = this.failed.get(fkey);
    if (until !== undefined && until > tick) return null;
    // Cheap early exit for the common unreachable case: the goal sits in a small enclosed area
    // (a lake, an island, a walled-in patch). A full forward search would exhaust its budget.
    if ((gcx !== scx || gcy !== scy) && this.enclosed(gcx, gcy, scx, scy, tick, ENCLOSED_PROBE)) {
      if (this.failed.size > 10_000) this.failed.clear();
      this.failed.set(fkey, tick + FAILED_TTL_TICKS);
      return null;
    }
    const side = radiusCells * 2 + 1;
    const ox = scx - radiusCells;
    const oy = scy - radiusCells;
    const idx = (x: number, y: number): number => (y - oy) * side + (x - ox);
    const n = side * side;
    const g = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open = (x: number, y: number): boolean =>
      x >= ox && y >= oy && x < ox + side && y < oy + side && ((x === gcx && y === gcy) || (x === scx && y === scy) || this.isOpen(x, y, tick));
    const h = (x: number, y: number): number => Math.max(Math.abs(x - gcx), Math.abs(y - gcy));
    const heap: [number, number][] = [];
    const push = (f: number, i: number): void => {
      heap.push([f, i]);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if ((heap[p] as [number, number])[0] <= f) break;
        [heap[p], heap[c]] = [heap[c] as [number, number], heap[p] as [number, number]];
        c = p;
      }
    };
    const pop = (): number => {
      const top = (heap[0] as [number, number])[1];
      const last = heap.pop() as [number, number];
      if (heap.length > 0) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = c * 2 + 1;
          const r = l + 1;
          let m = c;
          if (l < heap.length && (heap[l] as [number, number])[0] < (heap[m] as [number, number])[0]) m = l;
          if (r < heap.length && (heap[r] as [number, number])[0] < (heap[m] as [number, number])[0]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c] as [number, number], heap[m] as [number, number]];
          c = m;
        }
      }
      return top;
    };
    const s = idx(scx, scy);
    g[s] = 0;
    push(h(scx, scy), s);
    let exp = 0;
    while (heap.length > 0 && exp < maxExpansions) {
      const cur = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      exp++;
      const cx = (cur % side) + ox;
      const cy = Math.floor(cur / side) + oy;
      if (cx === gcx && cy === gcy) {
        const out: { x: number; y: number }[] = [];
        let p = cur;
        while (p !== s && p !== -1) {
          out.push({ x: ((p % side) + ox) * CELL + CELL / 2, y: (Math.floor(p / side) + oy) * CELL + CELL / 2 });
          p = parent[p] as number;
        }
        return out.reverse();
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!open(nx, ny)) continue;
          if (dx && dy && (!open(cx + dx, cy) || !open(cx, cy + dy))) continue;
          const ni = idx(nx, ny);
          if (closed[ni]) continue;
          const ng = (g[cur] as number) + (dx && dy ? 1.414 : 1) * this.cost(nx, ny, tick);
          if (ng >= (g[ni] as number)) continue;
          g[ni] = ng;
          parent[ni] = cur;
          push(ng + h(nx, ny), ni);
        }
      }
    }
    if (this.failed.size > 10_000) this.failed.clear();
    this.failed.set(fkey, tick + FAILED_TTL_TICKS);
    return null;
  }
}
