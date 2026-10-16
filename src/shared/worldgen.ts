import { fbm, hashString, rand01 } from "./rng.ts";
import { Tile, type TileCode } from "./defs/terrain.ts";
import { NODE_DEFS, type NodeKind } from "./defs/resources.ts";

/**
 * Deterministic procedural world generation.
 *
 * A tile's terrain and initial resource node are a pure function of
 * (seed, generationVersion, params, x, y). Chunks are just rectangular windows
 * over that function, so generation is independent of request order and there
 * are no seams at chunk boundaries or around negative coordinates.
 *
 * Bump GENERATION_VERSION whenever the output of this file changes. Existing
 * worlds store the version they were created with and the server refuses to
 * load a world whose version differs from the code (see server/worldMeta.ts).
 */
export const GENERATION_VERSION = 3;

/**
 * Supported versions. Version 2 = version 1 terrain and resource nodes (bit-identical)
 * plus ruins and wildlife spawns, so a v1 world can be upgraded explicitly
 * (npm run world:upgrade) without changing any existing terrain.
 * Version 3 = version 2 unchanged (terrain, nodes, ruins and v2 wildlife bit-identical)
 * plus more wildlife species (sheep, goats, horses, aurochs, bears) in newly populated
 * chunks and PvE monster lairs (placed by shared/lairs.ts).
 */
export const SUPPORTED_GENERATION_VERSIONS: readonly number[] = [1, 2, 3];

export interface WorldGenParams {
  seed: string;
  generationVersion: number;
  chunkSize: number;
  /** Multiplier on resource node probability (0.25 - 4). */
  resourceDensity: number;
}

export interface GeneratedNode {
  kind: NodeKind;
  x: number;
  y: number;
  amount: number;
}

export interface GeneratedRuin {
  x: number;
  y: number;
  tier: "common" | "ancient";
}

export interface GeneratedCreature {
  type: string;
  x: number;
  y: number;
}

export interface GeneratedChunk {
  cx: number;
  cy: number;
  size: number;
  /** size*size terrain codes, row-major (index = ly*size + lx). */
  tiles: Uint8Array;
  nodes: GeneratedNode[];
  /** Points of interest (generation v2+). */
  ruins: GeneratedRuin[];
  /** Wildlife spawned when the chunk is first populated (generation v2+). */
  creatures: GeneratedCreature[];
}

/** Salts keep independent noise fields uncorrelated. */
const SALT = {
  elevation: 11,
  moisture: 23,
  river: 37,
  detail: 41,
  treePick: 53,
  stonePick: 59,
  goldCluster: 61,
  goldPick: 67,
  berryCluster: 71,
  berryPick: 73,
  amount: 79,
} as const;

export class WorldGenerator {
  readonly params: WorldGenParams;
  private readonly seedHash: number;
  private readonly featureHash: number;

  constructor(params: WorldGenParams) {
    validateGenParams(params);
    this.params = params;
    // Terrain and nodes are identical in v1 and v2; features use an independent hash.
    this.seedHash = hashString(`${params.seed}|v1`);
    this.featureHash = hashString(`${params.seed}|features`);
  }

  /** Terrain at a world tile. */
  terrainAt(x: number, y: number): TileCode {
    const s = this.seedHash;
    const e = fbm(s, x, y, 96, 4, SALT.elevation);
    const m = fbm(s, x, y, 128, 3, SALT.moisture);
    const r = fbm(s, x, y, 180, 3, SALT.river);
    const detail = fbm(s, x, y, 8, 2, SALT.detail);

    // Value-noise fBm clusters around 0.5, so thresholds are tuned to that distribution.
    const elev = e + (detail - 0.5) * 0.06;
    if (elev < 0.345) return Tile.Water;
    if (elev > 0.69) return Tile.Rock;
    // Rivers: thin bands along a noise contour, absent in high terrain.
    if (Math.abs(r - 0.5) < 0.0105 && elev < 0.6) return Tile.Water;
    if (elev < 0.37) return Tile.Sand;
    if (elev > 0.635) return Tile.Hills;
    if (m > 0.555) return Tile.Forest;
    if (m > 0.47 && m < 0.53 && elev < 0.5) return Tile.Fertile;
    return Tile.Grass;
  }

  /** The resource node initially generated at a tile, if any. Terrain must be passable. */
  nodeAt(x: number, y: number, terrain: TileCode): GeneratedNode | null {
    const s = this.seedHash;
    const dens = this.params.resourceDensity;
    let kind: NodeKind | null = null;

    if (terrain === Tile.Forest) {
      if (rand01(s, x, y, SALT.treePick) < 0.42 * dens) kind = "tree";
    } else if (terrain === Tile.Hills) {
      const gc = fbm(s, x, y, 40, 2, SALT.goldCluster);
      if (gc > 0.66 && rand01(s, x, y, SALT.goldPick) < 0.35 * dens) kind = "gold";
      else if (rand01(s, x, y, SALT.stonePick) < 0.12 * dens) kind = "stone";
    } else if (terrain === Tile.Grass || terrain === Tile.Fertile) {
      const bc = fbm(s, x, y, 24, 2, SALT.berryCluster);
      if (bc > 0.64 && rand01(s, x, y, SALT.berryPick) < 0.3 * dens) kind = "berries";
      else if (rand01(s, x, y, SALT.treePick) < 0.025 * dens) kind = "tree";
      else if (rand01(s, x, y, SALT.stonePick) < 0.004 * dens) kind = "stone";
    }
    if (!kind) return null;
    const def = NODE_DEFS[kind];
    const amount = def.minAmount + Math.floor(rand01(s, x, y, SALT.amount) * (def.maxAmount - def.minAmount + 1));
    return { kind, x, y, amount };
  }

  generateChunk(cx: number, cy: number): GeneratedChunk {
    const size = this.params.chunkSize;
    const tiles = new Uint8Array(size * size);
    const nodes: GeneratedNode[] = [];
    const x0 = cx * size;
    const y0 = cy * size;
    for (let ly = 0; ly < size; ly++) {
      for (let lx = 0; lx < size; lx++) {
        const x = x0 + lx;
        const y = y0 + ly;
        const t = this.terrainAt(x, y);
        tiles[ly * size + lx] = t;
        if (t !== Tile.Water && t !== Tile.Rock) {
          const n = this.nodeAt(x, y, t);
          if (n) nodes.push(n);
        }
      }
    }
    const ruins: GeneratedRuin[] = [];
    const creatures: GeneratedCreature[] = [];
    if (this.params.generationVersion >= 2) this.generateFeatures(cx, cy, tiles, nodes, ruins, creatures);
    return { cx, cy, size, tiles, nodes, ruins, creatures };
  }

  /** Deterministic ruins and creature spawns for a chunk (independent of request order). */
  private generateFeatures(cx: number, cy: number, tiles: Uint8Array, nodes: GeneratedNode[], ruins: GeneratedRuin[], creatures: GeneratedCreature[]): void {
    const size = this.params.chunkSize;
    const fh = this.featureHash;
    const occupied = new Set(nodes.map((n) => `${n.x},${n.y}`));
    const counts = new Array(8).fill(0) as number[];
    for (const t of tiles) counts[t] = (counts[t] ?? 0) + 1;
    const frac = (...codes: number[]): number => codes.reduce((a, c) => a + (counts[c] ?? 0), 0) / tiles.length;
    let k = 0;
    const pickTile = (salt: number, allowed: (t: number) => boolean): { x: number; y: number } | null => {
      for (let attempt = 0; attempt < 24; attempt++) {
        const lx = Math.floor(rand01(fh, cx, cy, salt + attempt * 7 + k * 131) * size);
        const ly = Math.floor(rand01(fh, cx, cy, salt + attempt * 7 + 3 + k * 131) * size);
        const t = tiles[ly * size + lx] as number;
        const x = cx * size + lx;
        const y = cy * size + ly;
        if (!allowed(t) || occupied.has(`${x},${y}`)) continue;
        occupied.add(`${x},${y}`);
        k++;
        return { x, y };
      }
      return null;
    };
    const land = (t: number): boolean => t !== Tile.Water && t !== Tile.Rock;
    if (rand01(fh, cx, cy, 1001) < 0.33) {
      const p = pickTile(2000, (t) => land(t) && t !== Tile.Sand);
      if (p) ruins.push({ ...p, tier: rand01(fh, cx, cy, 1002) < 0.15 ? "ancient" : "common" });
    }
    const open = frac(Tile.Grass, Tile.Fertile);
    const forest = frac(Tile.Forest);
    const hills = frac(Tile.Hills);
    const spawn = (type: string, chance: number, max: number, salt: number, allowed: (t: number) => boolean): void => {
      for (let i = 0; i < max; i++) {
        if (rand01(fh, cx, cy, salt + i) >= chance) return;
        const p = pickTile(salt * 10 + i * 50, allowed);
        if (p) creatures.push({ type, ...p });
      }
    };
    if (open > 0.3) spawn("deer", 0.6 * this.params.resourceDensity, 2, 3000, (t) => t === Tile.Grass || t === Tile.Fertile);
    if (forest > 0.25) spawn("boar", 0.5 * this.params.resourceDensity, 1, 4000, (t) => t === Tile.Forest || t === Tile.Grass);
    if (forest + hills > 0.3) spawn("wolf", 0.25 * this.params.resourceDensity, 1, 5000, (t) => t === Tile.Forest || t === Tile.Hills);
    // Version 3 species. Appended after the v2 spawns so v2 output is unchanged.
    if (this.params.generationVersion >= 3) {
      const d = this.params.resourceDensity;
      if (open > 0.3) spawn("sheep", 0.45 * d, 3, 6000, (t) => t === Tile.Grass || t === Tile.Fertile);
      if (hills > 0.2) spawn("goat", 0.5 * d, 2, 7000, (t) => t === Tile.Hills);
      if (open > 0.45) spawn("horse", 0.3 * d, 2, 8000, (t) => t === Tile.Grass);
      if (open + forest > 0.4) spawn("aurochs", 0.25 * d, 1, 9000, (t) => t === Tile.Grass || t === Tile.Forest);
      if (forest + hills > 0.35) spawn("bear", 0.15 * d, 1, 9500, (t) => t === Tile.Forest || t === Tile.Hills);
    }
  }
}

export function validateGenParams(p: WorldGenParams): void {
  if (typeof p.seed !== "string" || p.seed.length < 1 || p.seed.length > 128) {
    throw new Error("world.seed must be a non-empty string of at most 128 characters");
  }
  if (!Number.isInteger(p.generationVersion) || p.generationVersion < 1) {
    throw new Error("world.generationVersion must be a positive integer");
  }
  if (!SUPPORTED_GENERATION_VERSIONS.includes(p.generationVersion)) {
    throw new Error(
      `world.generationVersion ${p.generationVersion} is not supported by this build (supports ${SUPPORTED_GENERATION_VERSIONS.join(", ")})`,
    );
  }
  if (!Number.isInteger(p.chunkSize) || p.chunkSize < 16 || p.chunkSize > 128) {
    throw new Error("world.chunkSize must be an integer between 16 and 128");
  }
  if (typeof p.resourceDensity !== "number" || !(p.resourceDensity >= 0.25 && p.resourceDensity <= 4)) {
    throw new Error("world.resourceDensity must be a number between 0.25 and 4");
  }
}
