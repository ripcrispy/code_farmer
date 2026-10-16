import { chunkKey, floorDiv, localIndex } from "../shared/coords.ts";
import { NODE_DEFS, type NodeKind } from "../shared/defs/resources.ts";
import { Tile, terrainDef, type TileCode } from "../shared/defs/terrain.ts";
import { WorldGenerator, type GeneratedChunk, type GeneratedRuin } from "../shared/worldgen.ts";

export interface NodeState {
  kind: NodeKind;
  /** Amount at tick `stamp` (regrowing nodes gain more over time; see ChunkStore.amountOf). */
  amount: number;
  max: number;
  stamp: number;
}

/** Persisted modification: remaining amount (finite nodes) or [amount, tick] (regrowing nodes). */
export type NodeMod = number | [number, number];

export interface ChunkData {
  cx: number;
  cy: number;
  tiles: Uint8Array;
  /** Live resource nodes keyed by local tile index (generated nodes with modifications applied). */
  nodes: Map<number, NodeState>;
  /** Ruins (points of interest) in this chunk. */
  ruins: GeneratedRuin[];
}

export interface NodeChange {
  x: number;
  y: number;
  kind: NodeKind;
  /** 0 = node removed. */
  amount: number;
}

/**
 * Chunk cache over the deterministic generator plus the persistent modification layer.
 *
 * Only modifications are durable: `mods` maps chunk -> (local tile index -> remaining amount).
 * Evicted chunks are regenerated from the seed and the modifications are re-applied,
 * so eviction never loses state.
 */
export class ChunkStore {
  readonly gen: WorldGenerator;
  readonly size: number;
  private readonly maxCached: number;
  private cache = new Map<string, ChunkData>();
  private mods = new Map<string, Map<number, NodeMod>>();
  /** Current simulation tick (for lazy regrowth). */
  private readonly now: () => number;
  private readonly ticksPerMinute: number;
  /** Min-heap of [tick, x, y] when an emptied regrowing node becomes harvestable again (for client updates). */
  private regrowHeap: [number, number, number][] = [];
  /** Chunks whose modifications changed since the last persistence flush. */
  readonly dirtyMods = new Set<string>();
  /** Node changes since the last network broadcast. */
  nodeChanges: NodeChange[] = [];
  generatedCount = 0;
  private last: ChunkData | null = null;

  constructor(gen: WorldGenerator, maxCached = 512, now: () => number = () => 0, tickRate = 10) {
    this.gen = gen;
    this.size = gen.params.chunkSize;
    this.maxCached = maxCached;
    this.now = now;
    this.ticksPerMinute = tickRate * 60;
  }

  /** Current amount of a node, including regrowth since it was last harvested. */
  amountOf(n: NodeState): number {
    const rate = NODE_DEFS[n.kind].regrowPerMinute;
    if (rate <= 0 || n.amount >= n.max) return n.amount;
    const grown = Math.floor(((this.now() - n.stamp) * rate) / this.ticksPerMinute);
    return Math.min(n.max, n.amount + Math.max(0, grown));
  }

  amountAt(x: number, y: number): number {
    const n = this.nodeAt(x, y);
    return n ? this.amountOf(n) : 0;
  }

  private scheduleRegrow(n: NodeState, x: number, y: number): void {
    const rate = NODE_DEFS[n.kind].regrowPerMinute;
    if (rate <= 0 || this.amountOf(n) > 0) return;
    const due = n.stamp + Math.ceil(this.ticksPerMinute / rate);
    const h = this.regrowHeap;
    h.push([due, x, y]);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((h[p] as [number, number, number])[0] <= due) break;
      [h[p], h[i]] = [h[i] as [number, number, number], h[p] as [number, number, number]];
      i = p;
    }
  }

  /** Emit node updates for emptied bushes that have started regrowing (bounded work per call). */
  processRegrowth(limit = 64): void {
    const h = this.regrowHeap;
    const now = this.now();
    for (let k = 0; k < limit && h.length > 0 && (h[0] as [number, number, number])[0] <= now; k++) {
      const [, x, y] = h[0] as [number, number, number];
      const last = h.pop() as [number, number, number];
      if (h.length > 0) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < h.length && (h[l] as [number, number, number])[0] < (h[m] as [number, number, number])[0]) m = l;
          if (r < h.length && (h[r] as [number, number, number])[0] < (h[m] as [number, number, number])[0]) m = r;
          if (m === i) break;
          [h[m], h[i]] = [h[i] as [number, number, number], h[m] as [number, number, number]];
          i = m;
        }
      }
      const c = this.cache.get(chunkKey(floorDiv(x, this.size), floorDiv(y, this.size)));
      const n = c?.nodes.get(localIndex(x, y, this.size));
      if (n && this.amountOf(n) > 0) this.nodeChanges.push({ x, y, kind: n.kind, amount: this.amountOf(n) });
    }
  }

  get cachedCount(): number {
    return this.cache.size;
  }

  /** Load persisted modifications (call before any chunk is generated). */
  loadMods(cx: number, cy: number, entries: Record<string, NodeMod>): void {
    const m = new Map<number, NodeMod>();
    for (const [k, v] of Object.entries(entries)) m.set(Number(k), v);
    this.mods.set(chunkKey(cx, cy), m);
    this.cache.delete(chunkKey(cx, cy));
    this.last = null;
  }

  /** Serialisable modifications for one chunk. */
  exportMods(key: string): Record<string, NodeMod> {
    const m = this.mods.get(key);
    const out: Record<string, NodeMod> = {};
    if (m) for (const [k, v] of m) out[String(k)] = v;
    return out;
  }

  getChunk(cx: number, cy: number): ChunkData {
    const l = this.last;
    if (l && l.cx === cx && l.cy === cy) return l;
    const key = chunkKey(cx, cy);
    let c = this.cache.get(key);
    if (c) {
      // refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, c);
    } else {
      c = this.build(this.gen.generateChunk(cx, cy));
      this.generatedCount++;
      this.cache.set(key, c);
      this.evict();
    }
    this.last = c;
    return c;
  }

  private build(g: GeneratedChunk): ChunkData {
    const nodes = new Map<number, NodeState>();
    const m = this.mods.get(chunkKey(g.cx, g.cy));
    for (const n of g.nodes) {
      const li = localIndex(n.x, n.y, this.size);
      const mod = m?.get(li);
      const amount = mod === undefined ? n.amount : Array.isArray(mod) ? mod[0] : mod;
      const stamp = Array.isArray(mod) ? mod[1] : 0;
      const regrows = NODE_DEFS[n.kind].regrowPerMinute > 0;
      if (amount > 0 || regrows) {
        const node: NodeState = { kind: n.kind, amount, max: n.amount, stamp };
        nodes.set(li, node);
        if (regrows && amount <= 0) this.scheduleRegrow(node, n.x, n.y);
      }
    }
    this.onGenerated?.(g);
    return { cx: g.cx, cy: g.cy, tiles: g.tiles, nodes, ruins: g.ruins };
  }

  /** Called when a chunk with creature spawns is (re)generated; the world decides whether to populate it. */
  onGenerated: ((g: GeneratedChunk) => void) | null = null;

  /** Ruins within a Chebyshev radius of a tile (only scans the chunks it overlaps). */
  ruinsNear(x: number, y: number, radius: number): GeneratedRuin[] {
    const out: GeneratedRuin[] = [];
    const s = this.size;
    for (let cy = floorDiv(y - radius, s); cy <= floorDiv(y + radius, s); cy++) {
      for (let cx = floorDiv(x - radius, s); cx <= floorDiv(x + radius, s); cx++) {
        for (const r of this.getChunk(cx, cy).ruins) if (Math.max(Math.abs(r.x - x), Math.abs(r.y - y)) <= radius) out.push(r);
      }
    }
    return out;
  }

  ruinAt(x: number, y: number): GeneratedRuin | undefined {
    return this.chunkOf(x, y).ruins.find((r) => r.x === x && r.y === y);
  }

  private evict(): void {
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
      this.last = null;
    }
  }

  chunkOf(x: number, y: number): ChunkData {
    return this.getChunk(floorDiv(x, this.size), floorDiv(y, this.size));
  }

  terrainAt(x: number, y: number): TileCode {
    const c = this.chunkOf(x, y);
    return c.tiles[localIndex(x, y, this.size)] as TileCode;
  }

  nodeAt(x: number, y: number): NodeState | undefined {
    return this.chunkOf(x, y).nodes.get(localIndex(x, y, this.size));
  }

  /** Terrain passable and no resource node. (Buildings are checked by the world.) */
  /**
   * Passability for long-range planning without generating chunks: exact for cached chunks,
   * otherwise straight from the deterministic generator (ignores harvested resources, so a
   * cleared tile may still count as blocked; good enough for a coarse corridor).
   */
  approxPassable(x: number, y: number): boolean {
    const cx = floorDiv(x, this.size);
    const cy = floorDiv(y, this.size);
    const l = this.last;
    if ((l && l.cx === cx && l.cy === cy) || this.cache.has(chunkKey(cx, cy))) return this.naturallyPassable(x, y);
    const t = this.gen.terrainAt(x, y);
    if (!terrainDef(t).passable) return false;
    // Only forests are dense enough with resources to matter at coarse scale (and their check is cheap);
    // scattered stones and bushes elsewhere are skipped to keep first-time planning fast.
    return t !== Tile.Forest || this.gen.nodeAt(x, y, t) === null;
  }

  naturallyPassable(x: number, y: number): boolean {
    const c = this.chunkOf(x, y);
    const li = localIndex(x, y, this.size);
    return terrainDef(c.tiles[li] as number).passable && !c.nodes.has(li);
  }

  /** Remove up to `n` units from a node. Returns the amount actually taken (atomic). */
  takeFromNode(x: number, y: number, n: number): number {
    const c = this.chunkOf(x, y);
    const li = localIndex(x, y, this.size);
    const node = c.nodes.get(li);
    if (!node || n <= 0) return 0;
    const current = this.amountOf(node);
    if (current <= 0) return 0;
    const taken = Math.min(n, current);
    node.amount = current - taken;
    node.stamp = this.now();
    const regrows = NODE_DEFS[node.kind].regrowPerMinute > 0;
    this.setMod(c, li, regrows ? [node.amount, node.stamp] : node.amount);
    if (node.amount <= 0) {
      if (regrows) this.scheduleRegrow(node, x, y);
      else c.nodes.delete(li);
    }
    this.nodeChanges.push({ x, y, kind: node.kind, amount: node.amount });
    return taken;
  }

  /** Remove a node entirely (e.g. clearing a spawn site). */
  clearNode(x: number, y: number): void {
    const c = this.chunkOf(x, y);
    const li = localIndex(x, y, this.size);
    const node = c.nodes.get(li);
    if (!node) return;
    c.nodes.delete(li);
    this.setMod(c, li, 0);
    this.nodeChanges.push({ x, y, kind: node.kind, amount: 0 });
  }

  private setMod(c: ChunkData, li: number, amount: NodeMod): void {
    const key = chunkKey(c.cx, c.cy);
    let m = this.mods.get(key);
    if (!m) {
      m = new Map();
      this.mods.set(key, m);
    }
    m.set(li, amount);
    this.dirtyMods.add(key);
  }

  nodeLabel(kind: NodeKind): string {
    return NODE_DEFS[kind].label;
  }
}
