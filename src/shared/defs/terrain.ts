/** Terrain tile types. Codes are stored in chunk tile arrays and sent over the network. */

export const Tile = {
  Water: 0,
  Sand: 1,
  Grass: 2,
  Forest: 3,
  Hills: 4,
  Rock: 5,
  Fertile: 6,
} as const;
export type TileCode = (typeof Tile)[keyof typeof Tile];

export interface TerrainDef {
  code: TileCode;
  name: string;
  passable: boolean;
  buildable: boolean;
  color: number;
}

export const TERRAIN: readonly TerrainDef[] = [
  { code: 0, name: "Water", passable: false, buildable: false, color: 0x2b5d8c },
  { code: 1, name: "Sand", passable: true, buildable: true, color: 0xcdb97a },
  { code: 2, name: "Grass", passable: true, buildable: true, color: 0x5b8f3a },
  { code: 3, name: "Forest floor", passable: true, buildable: true, color: 0x3f6e2c },
  { code: 4, name: "Hills", passable: true, buildable: true, color: 0x8a7d5a },
  { code: 5, name: "Rock", passable: false, buildable: false, color: 0x5a5550 },
  { code: 6, name: "Fertile soil", passable: true, buildable: true, color: 0x6f9a3c },
];

export function terrainDef(code: number): TerrainDef {
  const d = TERRAIN[code];
  if (!d) throw new Error(`Unknown terrain code ${code}`);
  return d;
}
