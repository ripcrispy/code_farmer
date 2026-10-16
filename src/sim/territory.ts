import { chunkKey, floorDiv, localIndex, mod } from "../shared/coords.ts";

export interface Claim {
  playerId: number;
  buildingId: number;
  tick: number;
  tiles: number;
}

/**
 * Tile ownership. A tile belongs to the first player whose completed building's
 * influence circle covers it; claims never take tiles another player already owns
 * (contested land stays with its first owner). Ownership is stored per chunk only
 * where something is owned, and per-player tile counts are maintained incrementally.
 *
 * Territory is not persisted directly: it is a deterministic function of completed
 * buildings in completion order, and is rebuilt from them on load.
 */
export class Territory {
  readonly size: number;
  private chunks = new Map<string, Int32Array>();
  readonly counts = new Map<number, number>();
  /** Chunks whose ownership changed since the last broadcast. */
  readonly dirty = new Set<string>();
  /** Claims since the last persistence flush (expansion history). */
  claims: Claim[] = [];

  constructor(chunkSize: number) {
    this.size = chunkSize;
  }

  ownerAt(x: number, y: number): number {
    const c = this.chunks.get(chunkKey(floorDiv(x, this.size), floorDiv(y, this.size)));
    return c ? (c[localIndex(x, y, this.size)] as number) : 0;
  }

  countOf(playerId: number): number {
    return this.counts.get(playerId) ?? 0;
  }

  /** Claim unowned tiles within `radius` of the rectangle's centre. Returns tiles newly claimed. */
  claim(playerId: number, buildingId: number, rect: { x: number; y: number; w: number; h: number }, radius: number, tick: number): number {
    const cx = rect.x + (rect.w - 1) / 2;
    const cy = rect.y + (rect.h - 1) / 2;
    const r = radius + Math.max(rect.w, rect.h) / 2;
    const r2 = r * r + r * 0.5;
    let claimed = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        const key = chunkKey(floorDiv(x, this.size), floorDiv(y, this.size));
        let c = this.chunks.get(key);
        if (!c) {
          c = new Int32Array(this.size * this.size);
          this.chunks.set(key, c);
        }
        const li = mod(y, this.size) * this.size + mod(x, this.size);
        if (c[li] !== 0) continue;
        c[li] = playerId;
        claimed++;
        this.dirty.add(key);
      }
    }
    if (claimed > 0) {
      this.counts.set(playerId, this.countOf(playerId) + claimed);
      this.claims.push({ playerId, buildingId, tick, tiles: claimed });
    }
    return claimed;
  }

  /** Forget all ownership (before re-deriving it). Returns the chunk keys that had owners. */
  reset(): string[] {
    const keys = [...this.chunks.keys()];
    this.chunks.clear();
    this.counts.clear();
    return keys;
  }

  ownedChunkKeys(): string[] {
    return [...this.chunks.keys()];
  }

  /** Run-length encoding of a chunk's owners: [owner, count, owner, count, ...]. Empty chunk -> []. */
  encodeChunk(key: string): number[] {
    const c = this.chunks.get(key);
    if (!c) return [];
    const out: number[] = [];
    let cur = c[0] as number;
    let n = 0;
    for (const v of c) {
      if (v === cur) n++;
      else {
        out.push(cur, n);
        cur = v;
        n = 1;
      }
    }
    out.push(cur, n);
    return out.length === 2 && out[0] === 0 ? [] : out;
  }

  /** Distinct owners present in a chunk. */
  ownersIn(key: string): number[] {
    const c = this.chunks.get(key);
    if (!c) return [];
    const s = new Set<number>();
    for (const v of c) if (v !== 0) s.add(v);
    return [...s];
  }
}
