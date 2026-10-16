/**
 * Isometric (2:1 dimetric) projection used by the renderer, in the style of classic
 * RTS games: a tile is a diamond HW*2 wide and HH*2 tall on screen.
 *
 * Tile space: x grows to the screen's lower right, y to the lower left.
 * "Ground" space: tile * GROUND (pixels), the space flat layers (terrain textures,
 * territory, zones, placement ghosts) are drawn in; the ground container maps it to
 * the screen with GROUND_MATRIX.
 */
export const HW = 32;
export const HH = 16;
/** Ground-space pixels per tile (flat layers). */
export const GROUND = 16;

/** Screen position of tile-space point (x, y). Tile (tx, ty)'s centre is (tx + 0.5, ty + 0.5). */
export function toScreen(x: number, y: number): { x: number; y: number } {
  return { x: (x - y) * HW, y: (x + y) * HH };
}

/** Tile-space point under screen-space point (sx, sy) (not floored). */
export function toTile(sx: number, sy: number): { x: number; y: number } {
  return { x: (sx / HW + sy / HH) / 2, y: (sy / HH - sx / HW) / 2 };
}

/** Affine matrix (a, b, c, d) mapping ground space to screen space. */
export const GROUND_MATRIX = { a: HW / GROUND, b: HH / GROUND, c: -HW / GROUND, d: HH / GROUND };

/** Depth for painter's-algorithm sorting of upright objects standing at tile-space (x, y). */
export function depthOf(x: number, y: number): number {
  return Math.round((x + y) * 64);
}
