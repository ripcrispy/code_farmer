/** Coordinate helpers shared by client and server. Tiles and chunks use integer coordinates. */

export interface TilePos {
  x: number;
  y: number;
}

/** Floor division that is correct for negative numbers. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Positive modulo. */
export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export function tileToChunk(x: number, y: number, chunkSize: number): { cx: number; cy: number } {
  return { cx: floorDiv(x, chunkSize), cy: floorDiv(y, chunkSize) };
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseKey(key: string): { a: number; b: number } {
  const i = key.indexOf(",");
  return { a: Number(key.slice(0, i)), b: Number(key.slice(i + 1)) };
}

/** Index of a tile within its chunk's tile array. */
export function localIndex(x: number, y: number, chunkSize: number): number {
  return mod(y, chunkSize) * chunkSize + mod(x, chunkSize);
}

/** Chebyshev (king-move) distance. */
export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Chebyshev distance from a point to a rectangle (0 when inside). */
export function distToRect(px: number, py: number, rx: number, ry: number, w: number, h: number): number {
  const dx = px < rx ? rx - px : px >= rx + w ? px - (rx + w - 1) : 0;
  const dy = py < ry ? ry - py : py >= ry + h ? py - (ry + h - 1) : 0;
  return Math.max(dx, dy);
}

/** 8-way facing, 0 = east, increasing clockwise in screen space (y down). */
export function facingFromDelta(dx: number, dy: number): number {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const table: Record<string, number> = {
    "1,0": 0, "1,1": 1, "0,1": 2, "-1,1": 3, "-1,0": 4, "-1,-1": 5, "0,-1": 6, "1,-1": 7,
  };
  return table[`${sx},${sy}`] ?? 0;
}

export function isSafeCoord(n: number, max: number): boolean {
  return Number.isInteger(n) && Math.abs(n) <= max;
}
