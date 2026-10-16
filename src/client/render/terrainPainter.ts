import { hash3 } from "../../shared/rng.ts";

/**
 * Painted ground textures for chunks. Each tile is TEX px square in the texture
 * (the ground container projects it into a diamond). Neighbouring terrain types
 * blend over a ragged, noise-jittered edge, and every terrain has its own painted
 * detail (grass blades, leaf litter, sand ripples, hill contours, rock cracks,
 * furrows, waves, shoreline foam), in the warm, saturated palette of classic
 * fantasy strategy games. Resource nodes leave marks on the ground (tree shadows,
 * rubble) under their upright sprites.
 */
export const TEX = 8;

/** Alpha of painted water pixels: the water shader animates exactly these (see waterFilter.ts). */
/**
 * Pixels that are partly or wholly water carry how much water they hold in their alpha:
 * 254 (a trace, at the shoreline) down to 241 (open water); dry ground is 255. The order
 * runs one way so texture filtering between neighbours still gives a sensible amount. The
 * water shader reads this to draw the water surface and the shoreline itself; without the
 * shader the painted water shows, at most about 5% translucent.
 */
export const WATER_ALPHA_OPEN = 241;
export const WATER_ALPHA_TRACE = 254;

type RGB = [number, number, number];

const WATER = 0;
const SAND = 1;
const GRASS = 2;
const FOREST = 3;
const HILLS = 4;
const ROCK = 5;
const FERTILE = 6;

function rgb(c: number): RGB {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

const C = {
  waterDeep: rgb(0x1d4a74),
  waterShallow: rgb(0x2f78a0),
  waterLight: rgb(0x7fc0d8),
  foam: rgb(0xd8ecf0),
  sand: rgb(0xd9c48c),
  sandDark: rgb(0xbfa66c),
  grass: rgb(0x5f9637),
  grass2: rgb(0x77a83f),
  grassDark: rgb(0x4a7d2c),
  grassLight: rgb(0x9cc45a),
  forest: rgb(0x3d6627),
  forest2: rgb(0x2f5520),
  litter: rgb(0x7a5a2a),
  hills: rgb(0x9c8a58),
  hills2: rgb(0x857546),
  hillsLight: rgb(0xb8a774),
  rock: rgb(0x6f6a64),
  rock2: rgb(0x58544f),
  rockLight: rgb(0x9a958c),
  crack: rgb(0x34312d),
  fertile: rgb(0x5d7d2c),
  soil: rgb(0x6a4d28),
  shadow: rgb(0x1a2410),
  rubble: rgb(0x8f8a82),
};

/** Random values on a 256x256 grid (deterministic), used for fast value noise. */
const N = 256;
const TABLE = (() => {
  const t = new Float32Array(N * N);
  for (let i = 0; i < t.length; i++) t[i] = hash3(1234, i % N, Math.floor(i / N), 7) / 4294967296;
  return t;
})();

function cell(x: number, y: number): number {
  return TABLE[((y & (N - 1)) << 8) | (x & (N - 1))] as number;
}

/** Smooth value noise in [0, 1). */
function vnoise(x: number, y: number, seed: number): number {
  const xs = x + seed * 37.1;
  const ys = y + seed * 71.3;
  const xi = Math.floor(xs);
  const yi = Math.floor(ys);
  const xf = xs - xi;
  const yf = ys - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = cell(xi, yi);
  const b = cell(xi + 1, yi);
  const c = cell(xi, yi + 1);
  const d = cell(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Painted colour of one terrain type at tile-space point (x, y); `px` is a per-pixel hash in [0,1). */
function typeColor(t: number, x: number, y: number, px: number): RGB {
  switch (t) {
    case WATER: {
      const n = vnoise(x * 0.35, y * 0.35, 11);
      let c = mix(C.waterDeep, C.waterShallow, n * 0.8);
      const wave = Math.sin(x * 3.1 + y * 1.3 + vnoise(x * 1.5, y * 1.5, 12) * 6);
      if (wave > 0.94) c = mix(c, C.waterLight, 0.55);
      return c;
    }
    case SAND: {
      const n = vnoise(x * 0.8, y * 0.8, 21);
      let c = mix(C.sand, C.sandDark, n * 0.45);
      if (Math.sin((x + y) * 5 + n * 4) > 0.85) c = mix(c, C.sandDark, 0.35);
      if (px > 0.97) c = mix(c, C.sandDark, 0.6);
      return c;
    }
    case GRASS: {
      const n = vnoise(x * 0.45, y * 0.45, 31);
      let c = mix(C.grass, C.grass2, n);
      const m = vnoise(x * 2.2, y * 2.2, 32);
      c = mix(c, C.grassDark, Math.max(0, 0.35 - m) * 0.9);
      if (px > 0.94) c = mix(c, C.grassLight, 0.6);
      else if (px < 0.05) c = mix(c, C.grassDark, 0.7);
      return c;
    }
    case FOREST: {
      const n = vnoise(x * 0.6, y * 0.6, 41);
      let c = mix(C.forest, C.forest2, n);
      if (px > 0.93) c = mix(c, C.litter, 0.55);
      else if (px < 0.06) c = mix(c, C.forest2, 0.8);
      return c;
    }
    case HILLS: {
      const n = vnoise(x * 0.25, y * 0.25, 51);
      let c = mix(C.hills, C.hills2, vnoise(x * 0.9, y * 0.9, 52));
      const contour = Math.sin(n * 26);
      if (contour > 0.82) c = mix(c, C.hills2, 0.65);
      else if (contour < -0.9) c = mix(c, C.hillsLight, 0.45);
      if (px > 0.97) c = mix(c, C.hillsLight, 0.6);
      return c;
    }
    case ROCK: {
      // Weathered stone: broad light/dark mottling, soft strata, few speckles.
      const n = vnoise(x * 0.5, y * 0.5, 61);
      let c = mix(C.rock, C.rock2, n);
      const k = vnoise(x * 1.3, y * 1.3, 62);
      c = mix(c, C.rockLight, Math.max(0, k - 0.6) * 0.9);
      const strata = Math.sin((x - y) * 1.7 + vnoise(x * 0.4, y * 0.4, 63) * 5);
      if (strata > 0.9) c = mix(c, C.crack, (strata - 0.9) * 2.5);
      if (px > 0.985) c = mix(c, C.rockLight, 0.35);
      return c;
    }
    case FERTILE: {
      const n = vnoise(x * 0.5, y * 0.5, 71);
      let c = mix(C.fertile, C.grass, n * 0.5);
      if (Math.sin(y * Math.PI * 3 + n * 2) > 0.55) c = mix(c, C.soil, 0.45);
      if (px > 0.95) c = mix(c, C.grassLight, 0.4);
      return c;
    }
    default:
      return [255, 0, 255];
  }
}

export interface PaintSource {
  /** Terrain code at a tile (may look into neighbouring chunks); undefined if unknown. */
  terrain(x: number, y: number): number | undefined;
  /** Resource node at a tile, if any (kind and remaining amount). */
  node(x: number, y: number): { kind: string; amount: number } | undefined;
}

/**
 * Paint tiles [tx0, tx1) x [ty0, ty1) (world tile coordinates) into `img`, whose
 * pixel (0, 0) is tile (ox, oy).
 */
export function paintGround(img: { data: Uint8ClampedArray; width: number }, ox: number, oy: number, tx0: number, ty0: number, tx1: number, ty1: number, src: PaintSource): void {
  const data = img.data;
  const stride = img.width;
  const near = new Int16Array(9);
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      const self = src.terrain(tx, ty) ?? GRASS;
      let uniform = true;
      for (let k = 0; k < 9; k++) {
        const t = src.terrain(tx + (k % 3) - 1, ty + Math.floor(k / 3) - 1);
        near[k] = t === undefined ? self : t;
        if (near[k] !== self) uniform = false;
      }
      const node = src.node(tx, ty);
      for (let py = 0; py < TEX; py++) {
        for (let pxl = 0; pxl < TEX; pxl++) {
          const fx = (pxl + 0.5) / TEX;
          const fy = (py + 0.5) / TEX;
          const x = tx + fx;
          const y = ty + fy;
          const ph = cell(tx * TEX + pxl + 101, ty * TEX + py + 57 + ((tx >> 5) * 13 + (ty >> 5) * 7));
          let c: RGB;
          // How much of this pixel is water (0..1), passed to the water shader in the alpha channel.
          let wet = self === WATER ? 1 : 0;
          if (uniform) {
            c = typeColor(self, x, y, ph);
          } else {
            // Blend the 3x3 neighbourhood over a ragged edge.
            let r = 0;
            let g = 0;
            let b = 0;
            let wsum = 0;
            let water = 0;
            const jitter = (vnoise(x * 2.3, y * 2.3, 91) - 0.5) * 0.45;
            for (let k = 0; k < 9; k++) {
              const dx = (k % 3) - 1;
              const dy = Math.floor(k / 3) - 1;
              const d = Math.hypot(fx - 0.5 - dx, fy - 0.5 - dy) + (k === 4 ? 0 : jitter);
              let w = 1.05 - d;
              if (w <= 0) continue;
              w = w * w * w;
              const t = near[k] as number;
              const tc = typeColor(t, x, y, ph);
              r += tc[0] * w;
              g += tc[1] * w;
              b += tc[2] * w;
              wsum += w;
              if (t === WATER) water += w;
            }
            c = [r / wsum, g / wsum, b / wsum];
            // Foam where water meets land.
            const wf = water / wsum;
            wet = wf;
            if (self === WATER && wf < 0.75 && wf > 0.25) c = mix(c, C.foam, 0.5 * (1 - Math.abs(wf - 0.5) * 4));
          }
          // Large-scale light variation.
          const light = 0.92 + vnoise(x * 0.12, y * 0.12, 99) * 0.16;
          c = [c[0] * light, c[1] * light, c[2] * light];
          // Ground marks under resource nodes (their upright art is drawn separately).
          if (node) {
            if (node.kind === "tree") {
              // Soft shadow cast toward the lower right.
              const d = Math.hypot(fx - 0.62, fy - 0.55);
              if (d < 0.5) c = mix(c, C.shadow, (0.5 - d) * 0.9);
            } else if (node.kind === "stone" || node.kind === "gold") {
              const d = Math.hypot(fx - 0.5, fy - 0.5);
              if (d < 0.48 && ph > 0.55) c = mix(c, C.rubble, 0.5);
              if (d < 0.45) c = mix(c, C.shadow, 0.15);
            } else if (node.kind === "berries") {
              const d = Math.hypot(fx - 0.55, fy - 0.55);
              if (d < 0.4) c = mix(c, C.shadow, (0.4 - d) * 0.6);
            }
          }
          const i = ((ty - oy) * TEX + py) * stride * 4 + ((tx - ox) * TEX + pxl) * 4;
          data[i] = Math.max(0, Math.min(255, c[0]));
          data[i + 1] = Math.max(0, Math.min(255, c[1]));
          data[i + 2] = Math.max(0, Math.min(255, c[2]));
          data[i + 3] = wet > 0.02 ? WATER_ALPHA_TRACE - Math.round((WATER_ALPHA_TRACE - WATER_ALPHA_OPEN) * wet) : 255;
        }
      }
    }
  }
}
