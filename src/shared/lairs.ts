import { floorDiv } from "./coords.ts";
import { LAIR_DEFS } from "./defs/lairs.ts";
import { hashString, rand01 } from "./rng.ts";

/**
 * Where PvE lairs are (world generation v3+): a pure function of the world seed with its
 * own hash, so lairs never change terrain, resources, ruins or the other wildlife.
 *
 * The map is divided into LAIR_REGION-sized squares; each holds at most one lair, placed
 * well inside it. Nothing is placed within LAIR_SAFE_DISTANCE of the world centre (where
 * the first players start), and lairs get harder with distance from the centre.
 * New settlements are never founded near a lair (see World.findSpawn).
 */
export const LAIR_REGION = 112;
export const LAIR_CHANCE = 0.45;
export const LAIR_SAFE_DISTANCE = 120;
/** Largest lair radius (for searches). */
export const LAIR_MAX_RADIUS = Math.max(...Object.values(LAIR_DEFS).map((d) => d.radius));
/** Minimum distance between a new settlement's centre and a lair's edge. */
export const LAIR_SPAWN_CLEARANCE = 36;

export interface Lair {
  /** Stable id, e.g. "l:3:-2" (region coordinates). */
  id: string;
  kind: string;
  x: number;
  y: number;
  r: number;
}

/** Which lair kind a region at distance `d` from the world centre gets, for a roll in [0, 1). */
export function lairKindFor(d: number, roll: number): string {
  const table: [string, number][] =
    d < 350
      ? [["goblin_camp", 0.7], ["spider_nest", 0.3]]
      : d < 800
        ? [["goblin_camp", 0.2], ["spider_nest", 0.35], ["bone_crypt", 0.3], ["ogre_den", 0.15]]
        : [["spider_nest", 0.15], ["bone_crypt", 0.25], ["ogre_den", 0.35], ["drake_roost", 0.25]];
  let acc = 0;
  for (const [kind, w] of table) {
    acc += w;
    if (roll < acc) return kind;
  }
  return (table[table.length - 1] as [string, number])[0];
}

export class Lairs {
  private readonly seed: number;
  private readonly enabled: boolean;
  private readonly suitable: (x: number, y: number) => boolean;
  private cache = new Map<string, Lair | null>();

  /**
   * `enabled`: lairs exist (generation v3+). `suitable` says whether a lair may be centred
   * on a tile (land, not in a contested zone); it must itself be deterministic.
   */
  constructor(worldSeed: string, enabled: boolean, suitable: (x: number, y: number) => boolean) {
    this.seed = hashString(`${worldSeed}|lairs`);
    this.enabled = enabled;
    this.suitable = suitable;
  }

  /** The lair of region (rx, ry), or null. */
  inRegion(rx: number, ry: number): Lair | null {
    if (!this.enabled) return null;
    const key = `${rx},${ry}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let lair: Lair | null = null;
    if (rand01(this.seed, rx, ry, 1) < LAIR_CHANCE) {
      const margin = LAIR_MAX_RADIUS + 10;
      const span = LAIR_REGION - 2 * margin;
      for (let attempt = 0; attempt < 8 && !lair; attempt++) {
        const x = rx * LAIR_REGION + margin + Math.floor(rand01(this.seed, rx, ry, 10 + attempt * 2) * span);
        const y = ry * LAIR_REGION + margin + Math.floor(rand01(this.seed, rx, ry, 11 + attempt * 2) * span);
        const d = Math.hypot(x, y);
        if (d < LAIR_SAFE_DISTANCE || !this.suitable(x, y)) continue;
        const kind = lairKindFor(d, rand01(this.seed, rx, ry, 3));
        const def = LAIR_DEFS[kind];
        if (def) lair = { id: `l:${rx}:${ry}`, kind, x, y, r: def.radius };
      }
    }
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(key, lair);
    return lair;
  }

  byId(id: string): Lair | null {
    const m = /^l:(-?\d+):(-?\d+)$/.exec(id);
    if (!m) return null;
    const l = this.inRegion(Number(m[1]), Number(m[2]));
    return l && l.id === id ? l : null;
  }

  /** The lair whose area contains tile (x, y), or null. */
  at(x: number, y: number, margin = 0): Lair | null {
    for (const l of this.near(x, y, margin)) if (Math.hypot(l.x - x, l.y - y) <= l.r + margin) return l;
    return null;
  }

  /** Lairs whose edge is within `margin` tiles of (x, y). */
  near(x: number, y: number, margin: number): Lair[] {
    const out: Lair[] = [];
    const reach = margin + LAIR_MAX_RADIUS;
    for (let ry = floorDiv(y - reach, LAIR_REGION); ry <= floorDiv(y + reach, LAIR_REGION); ry++) {
      for (let rx = floorDiv(x - reach, LAIR_REGION); rx <= floorDiv(x + reach, LAIR_REGION); rx++) {
        const l = this.inRegion(rx, ry);
        if (l && Math.hypot(l.x - x, l.y - y) <= l.r + margin) out.push(l);
      }
    }
    return out;
  }

  /** Lairs whose centre lies in a rectangle of tiles (inclusive). */
  centredIn(x0: number, y0: number, x1: number, y1: number): Lair[] {
    const out: Lair[] = [];
    for (let ry = floorDiv(y0, LAIR_REGION); ry <= floorDiv(y1, LAIR_REGION); ry++) {
      for (let rx = floorDiv(x0, LAIR_REGION); rx <= floorDiv(x1, LAIR_REGION); rx++) {
        const l = this.inRegion(rx, ry);
        if (l && l.x >= x0 && l.x <= x1 && l.y >= y0 && l.y <= y1) out.push(l);
      }
    }
    return out;
  }

  /** Lairs overlapping a rectangle of tiles. */
  inRect(x0: number, y0: number, x1: number, y1: number): Lair[] {
    const out: Lair[] = [];
    for (let ry = floorDiv(y0 - LAIR_MAX_RADIUS, LAIR_REGION); ry <= floorDiv(y1 + LAIR_MAX_RADIUS, LAIR_REGION); ry++) {
      for (let rx = floorDiv(x0 - LAIR_MAX_RADIUS, LAIR_REGION); rx <= floorDiv(x1 + LAIR_MAX_RADIUS, LAIR_REGION); rx++) {
        const l = this.inRegion(rx, ry);
        if (!l) continue;
        const nx = Math.max(x0, Math.min(l.x, x1));
        const ny = Math.max(y0, Math.min(l.y, y1));
        if (Math.hypot(nx - l.x, ny - l.y) <= l.r) out.push(l);
      }
    }
    return out;
  }
}
