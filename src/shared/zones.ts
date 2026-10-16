import { floorDiv } from "./coords.ts";
import { hashString, rand01 } from "./rng.ts";

/**
 * Contested zones: small areas where PvP is always on (when the server has combat enabled).
 *
 * Zones are a pure function of the world seed, like terrain, but use their own hash so
 * they never change terrain or resources. The map is divided into ZONE_REGION-sized
 * square regions; each region holds at most one zone, placed well inside it, so a tile can
 * only ever be in the zone of its own region. The regions around the world centre (where
 * players start) never have zones, and new settlements are never founded near one.
 */
export const ZONE_REGION = 256;
/** Regions with index in [-SAFE, SAFE - 1] on both axes have no zones (512x512 tiles around 0,0). */
export const ZONE_SAFE_REGIONS = 1;
export const ZONE_MIN_RADIUS = 14;
export const ZONE_MAX_RADIUS = 36;
/** Share of regions that contain a zone. */
export const ZONE_CHANCE = 0.5;
/** Minimum distance between a new settlement and the edge of any zone. */
export const ZONE_SPAWN_CLEARANCE = 48;

export interface ContestedZone {
  /** Stable id, e.g. "z:3:-2" (region coordinates). */
  id: string;
  x: number;
  y: number;
  /** Radius in tiles. */
  r: number;
}

export class ContestedZones {
  private readonly seed: number;
  private readonly preferLand: (x: number, y: number) => boolean;
  private cache = new Map<string, ContestedZone | null>();

  /** `preferLand` lets a zone centre avoid water and rock when possible (deterministic). */
  constructor(worldSeed: string, preferLand: (x: number, y: number) => boolean) {
    this.seed = hashString(`${worldSeed}|zones`);
    this.preferLand = preferLand;
  }

  /** The zone of region (rx, ry), or null. */
  inRegion(rx: number, ry: number): ContestedZone | null {
    const key = `${rx},${ry}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let zone: ContestedZone | null = null;
    const safe = rx >= -ZONE_SAFE_REGIONS && rx < ZONE_SAFE_REGIONS && ry >= -ZONE_SAFE_REGIONS && ry < ZONE_SAFE_REGIONS;
    if (!safe && rand01(this.seed, rx, ry, 1) < ZONE_CHANCE) {
      // Mostly small zones, occasionally a larger one.
      const t = rand01(this.seed, rx, ry, 2);
      const r = ZONE_MIN_RADIUS + Math.floor(t * t * (ZONE_MAX_RADIUS - ZONE_MIN_RADIUS + 1));
      const margin = ZONE_MAX_RADIUS + 20;
      const span = ZONE_REGION - 2 * margin;
      let x = 0;
      let y = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        x = rx * ZONE_REGION + margin + Math.floor(rand01(this.seed, rx, ry, 10 + attempt * 2) * span);
        y = ry * ZONE_REGION + margin + Math.floor(rand01(this.seed, rx, ry, 11 + attempt * 2) * span);
        if (this.preferLand(x, y)) break;
      }
      zone = { id: `z:${rx}:${ry}`, x, y, r };
    }
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(key, zone);
    return zone;
  }

  /** The zone containing tile (x, y), or null. */
  at(x: number, y: number): ContestedZone | null {
    const z = this.inRegion(floorDiv(x, ZONE_REGION), floorDiv(y, ZONE_REGION));
    return z && inCircle(z, x, y) ? z : null;
  }

  /** A zone that overlaps the rectangle (any of its tiles), or null. */
  touchingRect(r: { x: number; y: number; w: number; h: number }): ContestedZone | null {
    for (const z of this.near(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h))) {
      const nx = Math.max(r.x, Math.min(z.x, r.x + r.w - 1));
      const ny = Math.max(r.y, Math.min(z.y, r.y + r.h - 1));
      if (inCircle(z, nx, ny)) return z;
    }
    return null;
  }

  /** Zones whose edge is within `margin` tiles of (x, y). */
  near(x: number, y: number, margin: number): ContestedZone[] {
    const out: ContestedZone[] = [];
    const reach = margin + ZONE_MAX_RADIUS;
    for (let ry = floorDiv(y - reach, ZONE_REGION); ry <= floorDiv(y + reach, ZONE_REGION); ry++) {
      for (let rx = floorDiv(x - reach, ZONE_REGION); rx <= floorDiv(x + reach, ZONE_REGION); rx++) {
        const z = this.inRegion(rx, ry);
        if (z && Math.hypot(z.x - x, z.y - y) <= z.r + margin) out.push(z);
      }
    }
    return out;
  }

  /** Zones overlapping a rectangle of tiles (for chunk messages and the minimap). */
  inRect(x0: number, y0: number, x1: number, y1: number): ContestedZone[] {
    const out: ContestedZone[] = [];
    for (let ry = floorDiv(y0 - ZONE_MAX_RADIUS, ZONE_REGION); ry <= floorDiv(y1 + ZONE_MAX_RADIUS, ZONE_REGION); ry++) {
      for (let rx = floorDiv(x0 - ZONE_MAX_RADIUS, ZONE_REGION); rx <= floorDiv(x1 + ZONE_MAX_RADIUS, ZONE_REGION); rx++) {
        const z = this.inRegion(rx, ry);
        if (!z) continue;
        const nx = Math.max(x0, Math.min(z.x, x1));
        const ny = Math.max(y0, Math.min(z.y, y1));
        if (inCircle(z, nx, ny)) out.push(z);
      }
    }
    return out;
  }
}

/** Tile (x, y) is inside the zone's circle. Shared by server and client so both agree on the edge. */
export function inCircle(z: { x: number; y: number; r: number }, x: number, y: number): boolean {
  const dx = x - z.x;
  const dy = y - z.y;
  return dx * dx + dy * dy <= z.r * z.r;
}
