import { CanvasSource, Texture } from "pixi.js";
import { HH, HW } from "./iso.ts";

/**
 * Procedurally painted art for the isometric renderer: trees, rocks, bushes, ruins,
 * buildings, units, creatures and tools, drawn with Canvas2D (gradients, outlines,
 * highlights) in a bold, saturated fantasy-strategy style. Everything is original and
 * generated in code; textures are created on first use and cached.
 *
 * Team colours are never baked in: parts that show the owner's colour are drawn
 * white on a separate "team" texture that the renderer tints.
 */

const RES = 3;

export interface Art {
  texture: Texture;
  /** Anchor (0..1) of the point that stands on the ground. */
  ax: number;
  ay: number;
}

type G = CanvasRenderingContext2D;

function make(w: number, h: number, ax: number, ay: number, draw: (g: G) => void): Art {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * RES);
  c.height = Math.ceil(h * RES);
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas 2D context unavailable");
  g.scale(RES, RES);
  g.lineJoin = "round";
  g.lineCap = "round";
  draw(g);
  const source = new CanvasSource({ resource: c, resolution: RES, autoGenerateMipmaps: true, scaleMode: "linear" });
  return { texture: new Texture({ source }), ax: ax / w, ay: ay / h };
}

/** Alpha channels of art canvases, read once on first use (for pixel-accurate picking). */
const alphaCache = new WeakMap<object, { w: number; h: number; a: Uint8Array }>();

/**
 * Opacity (0-255) of an art texture at logical pixel (lx, ly) from its top-left corner;
 * 0 outside it. Used so clicks select what is actually drawn under the cursor.
 */
export function alphaAt(texture: Texture, lx: number, ly: number): number {
  const src = texture.source;
  const canvas = src.resource as HTMLCanvasElement | undefined;
  if (!canvas || typeof (canvas as { getContext?: unknown }).getContext !== "function") return 255;
  let e = alphaCache.get(src);
  if (!e) {
    const g = canvas.getContext("2d");
    if (!g) return 255;
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const a = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] as number;
    e = { w: canvas.width, h: canvas.height, a };
    alphaCache.set(src, e);
  }
  const x = Math.floor(lx * src.resolution);
  const y = Math.floor(ly * src.resolution);
  if (x < 0 || y < 0 || x >= e.w || y >= e.h) return 0;
  return e.a[y * e.w + x] as number;
}

const cache = new Map<string, Art>();
function cached(key: string, build: () => Art): Art {
  let a = cache.get(key);
  if (!a) {
    a = build();
    cache.set(key, a);
  }
  return a;
}

// ---------------------------------------------------------------- colour helpers

function css(c: number, a = 1): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}
export function shade(c: number, f: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const gg = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (gg << 8) | b;
}
const INK = "rgba(24,16,10,0.9)";

function poly(g: G, pts: number[][], fill: string | CanvasGradient, stroke: string | null = INK, width = 1): void {
  g.beginPath();
  pts.forEach((p, i) => (i === 0 ? g.moveTo(p[0] as number, p[1] as number) : g.lineTo(p[0] as number, p[1] as number)));
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.stroke();
  }
}
function circle(g: G, x: number, y: number, r: number, fill: string | CanvasGradient, stroke: string | null = INK, width = 1): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.stroke();
  }
}
function ellipse(g: G, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient, stroke: string | null = INK, width = 1): void {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.stroke();
  }
}
function line(g: G, x0: number, y0: number, x1: number, y1: number, color: string, width = 1): void {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.stroke();
}
/** Radial "lit from the upper left" gradient. */
function ball(g: G, x: number, y: number, r: number, c: number): CanvasGradient {
  const gr = g.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.1, x, y, r * 1.1);
  gr.addColorStop(0, css(shade(c, 1.35)));
  gr.addColorStop(0.55, css(c));
  gr.addColorStop(1, css(shade(c, 0.62)));
  return gr;
}
function vgrad(g: G, y0: number, y1: number, top: number, bottom: number): CanvasGradient {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, css(top));
  gr.addColorStop(1, css(bottom));
  return gr;
}
function hgrad(g: G, x0: number, x1: number, left: number, right: number): CanvasGradient {
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  gr.addColorStop(0, css(left));
  gr.addColorStop(1, css(right));
  return gr;
}
/** Deterministic pseudo-random in [0,1) from small integers. */
function rnd(a: number, b = 0): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------- nature

/** Six tree variants: 0-1 oak, 2-3 pine, 4 birch, 5 large oak. */
export function treeArt(variant: number): Art {
  return cached(`tree${variant}`, () =>
    make(60, 86, 30, 80, (g) => {
      const kind = variant <= 1 || variant === 5 ? "oak" : variant <= 3 ? "pine" : "birch";
      const s = variant === 5 ? 1.15 : variant % 2 === 0 ? 1 : 0.92;
      g.translate(30, 80);
      g.scale(s, s);
      // trunk
      const trunk = kind === "birch" ? 0xe8e4d8 : 0x6b4424;
      poly(g, [[-3.5, 0], [-2.5, -26], [2.5, -26], [3.5, 0]], hgrad(g, -4, 4, shade(trunk, 1.15), shade(trunk, 0.7)));
      if (kind === "birch") for (let i = 0; i < 4; i++) line(g, -2, -5 - i * 6, 1, -6 - i * 6, "rgba(40,30,30,0.8)", 1.2);
      poly(g, [[-6, 0], [-3, -4], [3, -4], [6, 0]], css(shade(trunk, 0.8)), INK, 0.8);
      if (kind === "pine") {
        const greens = [0x2c5a2a, 0x2f6a30, 0x377a36];
        for (let i = 0; i < 3; i++) {
          const y = -18 - i * 15;
          const w = 21 - i * 5;
          const gr = g.createLinearGradient(-w, 0, w, 0);
          gr.addColorStop(0, css(shade(greens[i] as number, 1.35)));
          gr.addColorStop(0.5, css(greens[i] as number));
          gr.addColorStop(1, css(shade(greens[i] as number, 0.6)));
          poly(g, [[-w, y + 6], [0, y - 22], [w, y + 6], [w * 0.4, y + 3], [0, y + 7], [-w * 0.4, y + 3]], gr);
        }
        return;
      }
      const leaf = kind === "birch" ? 0x8ab84a : variant === 1 ? 0x4f8a2e : 0x467d2a;
      const blobs: [number, number, number][] = [[-11, -34, 12], [11, -36, 12], [0, -48, 14], [-6, -28, 10], [8, -27, 10], [0, -36, 13]];
      for (const [x, y, r] of blobs) circle(g, x, y, r, ball(g, x, y, r, leaf), INK, 1);
      // re-fill interiors without outlines so only the silhouette is inked
      for (const [x, y, r] of blobs) circle(g, x, y, r - 1, ball(g, x, y, r, leaf), null);
      for (let i = 0; i < 9; i++) {
        const a = rnd(variant, i) * Math.PI * 2;
        const d = rnd(i, variant) * 12;
        circle(g, Math.cos(a) * d - 3, -40 + Math.sin(a) * d * 0.8, 2.2, css(shade(leaf, 1.45), 0.75), null);
      }
      if (variant === 0) for (let i = 0; i < 4; i++) circle(g, -10 + i * 6, -30 - (i % 2) * 8, 1.6, css(0xd04030), null);
    }),
  );
}

export function rockArt(gold: boolean, variant: number): Art {
  return cached(`rock${gold ? "g" : "s"}${variant}`, () =>
    make(60, 44, 30, 34, (g) => {
      // Stones are laid out around the ground point (30, 34).
      g.translate(30, 34);
      const base = gold ? 0x8a8478 : 0x9a968e;
      const stones: [number, number, number, number][] =
        variant === 0
          ? [[-10, -6, 13, 10], [9, -4, 11, 9], [0, -14, 10, 9]]
          : [[-6, -8, 15, 12], [12, -2, 8, 7], [-16, 0, 7, 6]];
      for (const [x, y, w, h] of stones) {
        const top = [[x - w, y + 2], [x - w * 0.6, y - h], [x + w * 0.3, y - h * 1.15], [x + w, y - h * 0.2], [x + w * 0.8, y + h * 0.6], [x - w * 0.2, y + h * 0.75]];
        poly(g, top, css(shade(base, 0.72)));
        poly(g, [[x - w, y + 2], [x - w * 0.6, y - h], [x + w * 0.3, y - h * 1.15], [x + w * 0.1, y - h * 0.15]], css(shade(base, 1.18)), null);
        poly(g, [[x + w * 0.1, y - h * 0.15], [x + w * 0.3, y - h * 1.15], [x + w, y - h * 0.2], [x + w * 0.8, y + h * 0.6]], css(shade(base, 0.88)), null);
        line(g, x - w * 0.6, y - h, x + w * 0.1, y - h * 0.15, "rgba(255,255,255,0.35)", 1);
        if (gold) {
          for (let i = 0; i < 3; i++) {
            const sx = x - w * 0.5 + rnd(i, x) * w;
            const sy = y - h * 0.6 + rnd(x, i) * h * 0.9;
            line(g, sx, sy, sx + 4, sy + 2, css(0xf4c430), 2.2);
            circle(g, sx + 4, sy + 2, 1.2, css(0xfff2a0), null);
          }
        }
      }
      if (gold) {
        g.fillStyle = "rgba(255,250,200,0.95)";
        for (const [sx, sy] of [[-14, -16], [6, -20], [16, -8]]) {
          poly(g, [[sx as number, (sy as number) - 3], [(sx as number) + 1, (sy as number) - 1], [(sx as number) + 3, sy as number], [(sx as number) + 1, (sy as number) + 1], [sx as number, (sy as number) + 3], [(sx as number) - 1, (sy as number) + 1], [(sx as number) - 3, sy as number], [(sx as number) - 1, (sy as number) - 1]], "rgba(255,250,200,0.95)", null);
        }
      }
    }),
  );
}

export function bushArt(empty: boolean): Art {
  return cached(`bush${empty}`, () =>
    make(44, 34, 22, 28, (g) => {
      const leaf = empty ? 0x6a7a3e : 0x3f7a2e;
      const blobs: [number, number, number][] = [[-9, -7, 8], [8, -8, 8], [0, -13, 9], [0, -5, 8]];
      for (const [x, y, r] of blobs) circle(g, 22 + x, 28 + y, r, ball(g, 22 + x, 28 + y, r, leaf));
      for (const [x, y, r] of blobs) circle(g, 22 + x, 28 + y, r - 1, ball(g, 22 + x, 28 + y, r, leaf), null);
      if (!empty) {
        for (let i = 0; i < 11; i++) {
          const x = 22 - 12 + rnd(i, 3) * 24;
          const y = 28 - 18 + rnd(3, i) * 14;
          circle(g, x, y, 2.1, ball(g, x, y, 2.1, 0xd0305a), "rgba(60,10,20,0.8)", 0.6);
        }
      } else {
        for (let i = 0; i < 6; i++) line(g, 22 - 8 + i * 3, 26, 22 - 10 + i * 4, 12 + (i % 2) * 3, "rgba(80,60,30,0.7)", 1);
      }
    }),
  );
}

export function ruinArt(ancient: boolean, looted: boolean): Art {
  return cached(`ruin${ancient}${looted}`, () =>
    make(72, 66, 36, 52, (g) => {
      const stone = ancient ? 0xc8c0dc : 0xbab09c;
      const s = looted ? 0.72 : 1;
      g.translate(36, 52);
      ellipse(g, 0, 0, 30, 13, "rgba(40,30,20,0.25)", null);
      // fallen slab
      poly(g, [[-24, 4], [-6, -4], [8, 2], [-10, 10]], css(shade(stone, 0.85 * s)));
      poly(g, [[-24, 4], [-10, 10], [-10, 13], [-24, 7]], css(shade(stone, 0.6 * s)));
      // columns
      const col = (x: number, y: number, h: number): void => {
        poly(g, [[x - 5, y], [x - 5, y - h], [x + 5, y - h - 2], [x + 5, y - 2]], hgrad(g, x - 5, x + 5, shade(stone, 1.15 * s), shade(stone, 0.65 * s)));
        ellipse(g, x, y - h - 1, 5, 2.5, css(shade(stone, 1.2 * s)));
        for (let i = 1; i < 4; i++) line(g, x - 3 + i * 1.6, y - 1, x - 3 + i * 1.6, y - h, "rgba(40,30,20,0.25)", 0.8);
      };
      col(-16, -2, 26);
      col(10, -8, 34);
      col(22, 4, 12);
      if (ancient) {
        poly(g, [[0, 2], [4, -22], [8, 2]], css(looted ? shade(stone, 0.6) : 0x9070d8));
        if (!looted) {
          circle(g, 4, -26, 3, "rgba(255,240,140,0.95)", null);
          circle(g, 4, -26, 6, "rgba(255,240,140,0.25)", null);
        }
      }
      if (looted) ellipse(g, 2, 10, 9, 4, css(0x3a2a18), INK, 0.8);
    }),
  );
}

// ---------------------------------------------------------------- buildings

export interface BuildingArt {
  art: Art;
  /** Flag pole top, in pixels relative to the anchor (footprint's north corner). */
  flag: { x: number; y: number } | null;
}

interface IsoCtx {
  g: G;
  /** Screen point of tile-space (x, y) at height z. */
  P: (x: number, y: number, z?: number) => [number, number];
}

function face(c: IsoCtx, pts: [number, number, number][], fill: string | CanvasGradient, stroke: string | null = INK): void {
  poly(c.g, pts.map(([x, y, z]) => c.P(x, y, z)), fill, stroke);
}

/** A box with its two visible walls (+y face on the left, +x face on the right) and optional top. */
function box(c: IsoCtx, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, wall: number, top: number | null, lines: "planks" | "stone" | "plaster" | "none" = "none"): void {
  face(c, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], css(shade(wall, 1.0)));
  face(c, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], css(shade(wall, 0.72)));
  if (lines !== "none") {
    const g = c.g;
    g.save();
    const step = lines === "planks" ? 5 : lines === "stone" ? 7 : 0;
    if (step > 0) {
      for (let z = z0 + step; z < z1; z += step) {
        const a = c.P(x0, y1, z);
        const b = c.P(x1, y1, z);
        const d = c.P(x1, y0, z);
        line(g, a[0], a[1], b[0], b[1], "rgba(30,20,10,0.35)", 0.8);
        line(g, b[0], b[1], d[0], d[1], "rgba(30,20,10,0.35)", 0.8);
        if (lines === "stone") {
          const k = Math.round((z - z0) / step);
          for (let i = 0; i < 6; i++) {
            const t = (i + (k % 2) * 0.5) / 6;
            const p = c.P(x0 + (x1 - x0) * t, y1, z);
            const q = c.P(x0 + (x1 - x0) * t, y1, Math.min(z1, z + step));
            line(g, p[0], p[1], q[0], q[1], "rgba(30,20,10,0.3)", 0.8);
            const r2 = c.P(x1, y0 + (y1 - y0) * t, z);
            const s2 = c.P(x1, y0 + (y1 - y0) * t, Math.min(z1, z + step));
            line(g, r2[0], r2[1], s2[0], s2[1], "rgba(30,20,10,0.3)", 0.8);
          }
        }
      }
    }
    if (lines === "plaster") {
      // timber framing
      const beams = 4;
      for (let i = 0; i <= beams; i++) {
        const t = i / beams;
        const a = c.P(x0 + (x1 - x0) * t, y1, z0);
        const b = c.P(x0 + (x1 - x0) * t, y1, z1);
        line(g, a[0], a[1], b[0], b[1], "rgba(70,40,20,0.95)", 1.6);
        const d = c.P(x1, y0 + (y1 - y0) * t, z0);
        const e = c.P(x1, y0 + (y1 - y0) * t, z1);
        line(g, d[0], d[1], e[0], e[1], "rgba(50,28,14,0.95)", 1.6);
      }
      const zm = (z0 + z1) / 2;
      for (const z of [z0 + 1, zm, z1 - 1]) {
        const a = c.P(x0, y1, z);
        const b = c.P(x1, y1, z);
        const d = c.P(x1, y0, z);
        line(g, a[0], a[1], b[0], b[1], "rgba(70,40,20,0.95)", 1.6);
        line(g, b[0], b[1], d[0], d[1], "rgba(50,28,14,0.95)", 1.6);
      }
    }
    g.restore();
  }
  if (top !== null) face(c, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], css(top));
}

/** Clip to a polygon and draw stripes parallel to its first edge (roof tiles, thatch). */
function stripes(c: IsoCtx, pts: [number, number, number][], color: string, n: number): void {
  const g = c.g;
  const sp = pts.map(([x, y, z]) => c.P(x, y, z));
  g.save();
  g.beginPath();
  sp.forEach((p, i) => (i === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1])));
  g.closePath();
  g.clip();
  const a = sp[0] as [number, number];
  const b = sp[1] as [number, number];
  const d = sp[2] as [number, number];
  const e = (sp[3] ?? sp[2]) as [number, number];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    line(g, a[0] + (e[0] - a[0]) * t, a[1] + (e[1] - a[1]) * t, b[0] + (d[0] - b[0]) * t, b[1] + (d[1] - b[1]) * t, color, 1);
  }
  g.restore();
}

/** Gable roof with its ridge along x (axis "x") or y, eaves at height z, ridge `rise` higher. */
function gable(c: IsoCtx, x0: number, y0: number, x1: number, y1: number, z: number, rise: number, roof: number, wall: number, axis: "x" | "y", o = 0.12, pattern = "tiles"): void {
  const stripeColor = pattern === "thatch" ? "rgba(90,60,20,0.45)" : "rgba(40,10,10,0.35)";
  if (axis === "x") {
    const ym = (y0 + y1) / 2;
    face(c, [[x0 - o, y0 - o, z], [x1 + o, y0 - o, z], [x1 + o, ym, z + rise], [x0 - o, ym, z + rise]], css(shade(roof, 0.7)));
    face(c, [[x1, y0, z], [x1, y1, z], [x1, ym, z + rise]], css(shade(wall, 0.72)));
    const s: [number, number, number][] = [[x0 - o, y1 + o, z], [x1 + o, y1 + o, z], [x1 + o, ym, z + rise], [x0 - o, ym, z + rise]];
    face(c, s, css(roof));
    stripes(c, s, stripeColor, 6);
  } else {
    const xm = (x0 + x1) / 2;
    face(c, [[x0 - o, y0 - o, z], [x0 - o, y1 + o, z], [xm, y1 + o, z + rise], [xm, y0 - o, z + rise]], css(shade(roof, 0.9)));
    face(c, [[x0, y1, z], [x1, y1, z], [xm, y1, z + rise]], css(wall));
    const s: [number, number, number][] = [[x1 + o, y0 - o, z], [x1 + o, y1 + o, z], [xm, y1 + o, z + rise], [xm, y0 - o, z + rise]];
    face(c, s, css(shade(roof, 0.72)));
    stripes(c, s, stripeColor, 6);
  }
}

/** Pyramid roof. */
function hip(c: IsoCtx, x0: number, y0: number, x1: number, y1: number, z: number, rise: number, roof: number, o = 0.1): void {
  const xm = (x0 + x1) / 2;
  const ym = (y0 + y1) / 2;
  const A: [number, number, number] = [xm, ym, z + rise];
  face(c, [[x0 - o, y0 - o, z], [x1 + o, y0 - o, z], A], css(shade(roof, 0.65)));
  face(c, [[x0 - o, y0 - o, z], [x0 - o, y1 + o, z], A], css(shade(roof, 0.8)));
  face(c, [[x0 - o, y1 + o, z], [x1 + o, y1 + o, z], A], css(roof));
  face(c, [[x1 + o, y0 - o, z], [x1 + o, y1 + o, z], A], css(shade(roof, 0.72)));
}

/** Round tower (approximated in screen space) with a cone roof. */
function tower(c: IsoCtx, cx: number, cy: number, r: number, z0: number, z1: number, wall: number, roof: number, coneH: number): [number, number] {
  const g = c.g;
  const [bx, by] = c.P(cx, cy, z0);
  const [tx, ty] = c.P(cx, cy, z1);
  const rx = r * HW * 1.4;
  const ry = r * HH * 1.4;
  g.beginPath();
  g.ellipse(bx, by, rx, ry, 0, 0, Math.PI);
  g.lineTo(tx - rx, ty);
  g.ellipse(tx, ty, rx, ry, 0, Math.PI, 0, true);
  g.closePath();
  g.fillStyle = hgrad(g, bx - rx, bx + rx, shade(wall, 1.1), shade(wall, 0.6));
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.stroke();
  for (let z = z0 + 7; z < z1; z += 7) {
    g.beginPath();
    g.ellipse(bx, by - (z - z0), rx, ry, 0, 0.15, Math.PI - 0.15);
    g.strokeStyle = "rgba(30,20,10,0.3)";
    g.lineWidth = 0.8;
    g.stroke();
  }
  // cone
  g.beginPath();
  g.ellipse(tx, ty, rx + 3, ry + 1.5, 0, 0, Math.PI);
  g.lineTo(tx, ty - coneH);
  g.closePath();
  g.fillStyle = hgrad(g, tx - rx, tx + rx, shade(roof, 1.2), shade(roof, 0.6));
  g.fill();
  g.strokeStyle = INK;
  g.stroke();
  return [tx, ty - coneH];
}

function door(c: IsoCtx, x: number, y1: number, w: number, h: number, color = 0x3a2412): void {
  face(c, [[x, y1, 0], [x + w, y1, 0], [x + w, y1, h], [x + w / 2, y1, h + w * 6], [x, y1, h]], css(color));
}
function windowL(c: IsoCtx, x: number, y1: number, z: number, w = 0.22, h = 7, lit = true): void {
  face(c, [[x, y1, z], [x + w, y1, z], [x + w, y1, z + h], [x, y1, z + h]], css(lit ? 0xf0d070 : 0x2a2018), "rgba(40,24,12,1)");
}
function windowR(c: IsoCtx, x1: number, y: number, z: number, w = 0.22, h = 7): void {
  face(c, [[x1, y, z], [x1, y + w, z], [x1, y + w, z + h], [x1, y, z + h]], css(0xc8a050), "rgba(40,24,12,1)");
}
function plinth(c: IsoCtx, w: number, h: number, color: number, inset = 0.04, height = 3): void {
  box(c, inset, inset, w - inset, h - inset, 0, height, color, shade(color, 1.1));
}
function fence(c: IsoCtx, w: number, h: number, inset: number): void {
  const g = c.g;
  const pts: [number, number][] = [];
  const n = 6;
  for (let i = 0; i <= n; i++) pts.push([inset + ((w - 2 * inset) * i) / n, h - inset]);
  for (let i = 0; i <= n; i++) pts.push([w - inset, inset + ((h - 2 * inset) * i) / n]);
  for (const [x, y] of pts) {
    const [a, b] = c.P(x, y, 0);
    line(g, a, b, a, b - 9, "rgba(90,60,30,1)", 2);
  }
  for (const z of [3, 7]) {
    const a = c.P(inset, h - inset, z);
    const b = c.P(w - inset, h - inset, z);
    const d = c.P(w - inset, inset, z);
    line(g, a[0], a[1], b[0], b[1], "rgba(120,84,44,1)", 1.4);
    line(g, b[0], b[1], d[0], d[1], "rgba(100,70,36,1)", 1.4);
  }
}
function crate(c: IsoCtx, x: number, y: number, s: number): void {
  box(c, x, y, x + s, y + s, 0, s * 26, 0xb07c40, 0xc89452, "planks");
}
function logs(c: IsoCtx, x: number, y: number, n: number): void {
  const g = c.g;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 3);
    const k = i % 3;
    const [px, py] = c.P(x + k * 0.22, y, 3 + row * 5);
    ellipse(g, px - 8, py, 3.2, 3.2, css(0xd8b07a), INK, 0.8);
    const [qx, qy] = c.P(x + k * 0.22 + 0.9, y - 0.02, 3 + row * 5);
    line(g, px - 8, py - 3, qx - 8, qy - 3, "rgba(110,66,30,1)", 0.8);
    poly(g, [[px - 8, py - 3.2], [qx - 8, qy - 3.2], [qx - 8, qy + 3.2], [px - 8, py + 3.2]], css(0x8a5428), INK, 0.6);
    ellipse(g, px - 8, py, 3.2, 3.2, css(0xd8b07a), INK, 0.8);
  }
}

/** Per-race building materials: roofs, walls, stonework and accent roofs. */
interface Palette {
  roof: number;
  wall: number;
  stone: number;
  accent: number;
  dome: number;
  thatch: number;
}
const PALETTES: Record<string, Palette> = {
  human: { roof: 0xa83a2a, wall: 0xe8dcc0, stone: 0xb8b0a0, accent: 0x3a6aa0, dome: 0x3a6ab0, thatch: 0xc8a050 },
  orc: { roof: 0x7a3a1e, wall: 0x9a7048, stone: 0x6e6050, accent: 0x5a2a1a, dome: 0x8a3a1a, thatch: 0x9a6a3a },
  dwarf: { roof: 0x56606c, wall: 0xc0b098, stone: 0x8a8478, accent: 0x7a5a2a, dome: 0x6a7480, thatch: 0x9a8a60 },
  high_elf: { roof: 0x2a5aa8, wall: 0xf2eef6, stone: 0xdcd4e4, accent: 0xd8a840, dome: 0x2a6ac0, thatch: 0xd8c070 },
  dark_elf: { roof: 0x4a2a6a, wall: 0x5a5468, stone: 0x5e5470, accent: 0x6a3a8a, dome: 0x5a2a8a, thatch: 0x6a5a7a },
  undead: { roof: 0x3a3a48, wall: 0x7a7a6a, stone: 0x5e5e54, accent: 0x3a6a4a, dome: 0x3a5a4a, thatch: 0x6a6a50 },
  troll: { roof: 0x3a7a5a, wall: 0x8a6a3a, stone: 0x7a7060, accent: 0xb84a2a, dome: 0x2a8a8a, thatch: 0xb89a50 },
};

const BUILDING_SIZE: Record<string, [number, number]> = {
  town_hall: [3, 3], outpost: [2, 2], stockpile: [2, 2], farm: [3, 3], lumber_camp: [2, 2], mine: [2, 2], lodge: [3, 3], library: [3, 3], watchtower: [2, 2], barracks: [3, 3], paddock: [4, 4],
};

/**
 * Building art. `stage` 0-3 draws a construction site at that stage; 4 is complete.
 * Origin (anchor) is the footprint's north corner.
 */
export function buildingArt(type: string, w: number, h: number, stage: number, race = "human"): BuildingArt {
  const pal = PALETTES[race] ?? (PALETTES.human as Palette);
  const key = `b:${type}:${w}x${h}:${stage}:${race}`;
  const TOP = 150;
  const W = (w + h) * HW + 8;
  const H = TOP + (w + h) * HH + 8;
  const ox = h * HW + 4;
  const oy = TOP;
  const art = cached(key, () =>
    make(W, H, ox, oy, (g) => {
      const c: IsoCtx = { g, P: (x, y, z = 0) => [ox + (x - y) * HW, oy + (x + y) * HH - z] };
      if (stage < 4) {
        drawConstruction(c, w, h, stage);
        FLAG_CACHE.set(key, null);
        return;
      }
      const f = drawBuilding(c, type, w, h, pal);
      FLAG_CACHE.set(key, f ? { x: f.x - ox, y: f.y - oy } : null);
    }),
  );
  return { art, flag: FLAG_CACHE.get(key) ?? null };
}
const FLAG_CACHE = new Map<string, { x: number; y: number } | null>();

function drawConstruction(c: IsoCtx, w: number, h: number, stage: number): void {
  const g = c.g;
  plinth(c, w, h, 0x8a7a60, 0.08, 2);
  const zTop = 8 + stage * 12;
  if (stage >= 1) box(c, 0.3, 0.3, w - 0.3, h - 0.3, 2, zTop, 0xc8b89a, null, "stone");
  // scaffolding poles and planks
  const poles: [number, number][] = [[0.15, h - 0.15], [w - 0.15, h - 0.15], [w - 0.15, 0.15], [w / 2, h - 0.15], [w - 0.15, h / 2]];
  for (const [x, y] of poles) {
    const [a, b] = c.P(x, y, 0);
    line(g, a, b, a, b - zTop - 14, "rgba(150,110,60,1)", 2);
  }
  for (const z of [zTop * 0.5, zTop + 6]) {
    const a = c.P(0.15, h - 0.15, z);
    const b = c.P(w - 0.15, h - 0.15, z);
    const d = c.P(w - 0.15, 0.15, z);
    line(g, a[0], a[1], b[0], b[1], "rgba(170,130,70,1)", 2.4);
    line(g, b[0], b[1], d[0], d[1], "rgba(150,110,60,1)", 2.4);
  }
  // material piles
  crate(c, 0.2, h - 0.75, 0.4);
  logs(c, w - 1.2, h - 0.35, 3);
}

/** Draw a completed building; returns the flag pole top in canvas coordinates. */
function drawBuilding(c: IsoCtx, type: string, w: number, h: number, pal: Palette): { x: number; y: number } | null {
  const g = c.g;
  const pole = (x: number, y: number, z: number, len: number): { x: number; y: number } => {
    const [a, b] = c.P(x, y, z);
    line(g, a, b, a, b - len, "rgba(50,34,20,1)", 1.6);
    circle(g, a, b - len, 1.6, css(0xe0c050), null);
    return { x: a, y: b - len + 2 };
  };
  switch (type) {
    case "town_hall": {
      plinth(c, w, h, 0x8a8478, 0.05, 4);
      box(c, 0.35, 0.5, 2.65, 2.55, 4, 34, pal.wall, null, "plaster");
      gable(c, 0.35, 0.5, 2.65, 2.55, 34, 30, pal.roof, pal.wall, "x", 0.15);
      // central tower
      box(c, 1.05, 1.15, 1.95, 2.0, 30, 78, pal.stone, null, "stone");
      hip(c, 1.0, 1.1, 2.0, 2.05, 78, 30, shade(pal.roof, 0.82), 0.12);
      windowL(c, 1.35, 2.0, 50, 0.3, 10);
      windowR(c, 1.95, 1.4, 50, 0.3, 10);
      door(c, 1.25, 2.55, 0.5, 14);
      windowL(c, 0.6, 2.55, 16);
      windowL(c, 2.1, 2.55, 16);
      windowR(c, 2.65, 1.0, 16);
      windowR(c, 2.65, 1.9, 16);
      return pole(1.5, 1.6, 108, 16);
    }
    case "outpost": {
      plinth(c, w, h, 0x7a6a50, 0.05, 2);
      const g2 = c.g;
      // palisade of pointed stakes along the two front edges
      const stake = (x: number, y: number): void => {
        const [a, b] = c.P(x, y, 0);
        poly(g2, [[a - 2.5, b], [a - 2.5, b - 16], [a, b - 20], [a + 2.5, b - 16], [a + 2.5, b]], hgrad(g2, a - 3, a + 3, 0x9a7444, 0x5a3e20), INK, 0.7);
      };
      for (let i = 0; i <= 10; i++) stake(0.1 + (1.8 * i) / 10, 0.1);
      for (let i = 0; i <= 10; i++) stake(0.1, 0.1 + (1.8 * i) / 10);
      const [tx, ty] = tower(c, 1.0, 1.0, 0.42, 2, 46, 0x8a6a44, pal.accent, 22);
      for (let i = 0; i <= 10; i++) stake(0.1 + (1.8 * i) / 10, 1.9);
      for (let i = 0; i <= 10; i++) stake(1.9, 0.1 + (1.8 * i) / 10);
      line(g2, tx, ty, tx, ty - 14, "rgba(50,34,20,1)", 1.6);
      return { x: tx, y: ty - 12 };
    }
    case "stockpile": {
      plinth(c, w, h, 0x8a7050, 0.05, 2);
      box(c, 0.15, 0.15, 0.95, 0.95, 2, 22, 0x9a6e3e, null, "planks");
      gable(c, 0.15, 0.15, 0.95, 0.95, 22, 12, pal.roof, 0x9a6e3e, "y", 0.1, "thatch");
      crate(c, 1.1, 0.25, 0.45);
      crate(c, 1.2, 0.9, 0.38);
      crate(c, 0.35, 1.2, 0.42);
      // sacks
      const [sx, sy] = c.P(1.35, 1.55, 2);
      ellipse(g, sx, sy - 5, 7, 6, ball(g, sx, sy - 5, 7, 0xd8c08a));
      ellipse(g, sx + 9, sy - 2, 6, 5, ball(g, sx + 9, sy - 2, 6, 0xc8b07a));
      fence(c, w, h, 0.05);
      return pole(0.1, 1.85, 2, 30);
    }
    case "farm": {
      // crop field on the ground with rows of wheat
      face(c, [[0.05, 0.05, 1], [w - 0.05, 0.05, 1], [w - 0.05, h - 0.05, 1], [0.05, h - 0.05, 1]], css(0x7a5530));
      for (let i = 0; i < 9; i++) {
        const y = 0.2 + i * 0.3;
        const a = c.P(0.15, y, 1);
        const b = c.P(1.9, y, 1);
        for (let k = 0; k < 14; k++) {
          const t = k / 13;
          const px = a[0] + (b[0] - a[0]) * t;
          const py = a[1] + (b[1] - a[1]) * t;
          line(g, px, py, px + 1, py - 6, css(0xe0c050), 1.6);
          circle(g, px + 1, py - 6.5, 1.3, css(0xf0d870), null);
        }
      }
      box(c, 2.1, 0.2, 2.9, 1.1, 1, 20, pal.wall, null, "plaster");
      gable(c, 2.1, 0.2, 2.9, 1.1, 20, 14, pal.thatch, pal.wall, "x", 0.12, "thatch");
      door(c, 2.35, 1.1, 0.3, 10);
      fence(c, w, h, 0.03);
      return pole(2.9, 1.2, 1, 26);
    }
    case "lumber_camp": {
      plinth(c, w, h, 0x7a6448, 0.05, 2);
      // open shed: four posts and a lean-to roof
      for (const [x, y] of [[0.2, 0.2], [1.1, 0.2], [0.2, 1.0], [1.1, 1.0]] as const) {
        const [a, b] = c.P(x, y, 2);
        line(g, a, b, a, b - 24, "rgba(90,60,30,1)", 2.4);
      }
      face(c, [[0.1, 0.1, 30], [1.2, 0.1, 30], [1.2, 1.1, 22], [0.1, 1.1, 22]], css(pal.roof));
      stripes(c, [[0.1, 1.1, 22], [1.2, 1.1, 22], [1.2, 0.1, 30], [0.1, 0.1, 30]], "rgba(30,50,20,0.5)", 5);
      logs(c, 0.4, 1.75, 6);
      // stump with axe
      const [sx, sy] = c.P(1.55, 0.6, 2);
      poly(g, [[sx - 6, sy], [sx - 6, sy - 7], [sx + 6, sy - 7], [sx + 6, sy]], hgrad(g, sx - 6, sx + 6, 0x8a5a2a, 0x5a3a1a));
      ellipse(g, sx, sy - 7, 6, 3, css(0xd8b07a));
      line(g, sx, sy - 7, sx + 4, sy - 18, "rgba(110,70,30,1)", 1.6);
      poly(g, [[sx + 2, sy - 9], [sx - 2, sy - 6], [sx - 1, sy - 11]], css(0xc8ccd4));
      return pole(1.85, 1.85, 2, 28);
    }
    case "mine": {
      // rocky mound with a timber-framed entrance
      const [mx, my] = c.P(1, 1, 0);
      g.beginPath();
      g.moveTo(mx - 62, my + 4);
      g.bezierCurveTo(mx - 50, my - 40, mx - 10, my - 58, mx + 14, my - 50);
      g.bezierCurveTo(mx + 40, my - 44, mx + 60, my - 20, mx + 62, my + 4);
      g.bezierCurveTo(mx + 30, my + 30, mx - 30, my + 30, mx - 62, my + 4);
      g.closePath();
      g.fillStyle = (() => {
        const gr = g.createRadialGradient(mx - 20, my - 40, 4, mx, my - 10, 70);
        gr.addColorStop(0, css(0xa8a094));
        gr.addColorStop(1, css(0x5a5650));
        return gr;
      })();
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 1;
      g.stroke();
      for (let i = 0; i < 8; i++) {
        const x = mx - 40 + rnd(i, 9) * 80;
        const y = my - 40 + rnd(9, i) * 40;
        poly(g, [[x, y], [x + 6, y - 4], [x + 10, y + 1], [x + 3, y + 4]], css(0x8a857c), "rgba(30,25,20,0.6)", 0.6);
      }
      // entrance on the front (+y) side
      face(c, [[0.55, 2, 0], [1.45, 2, 0], [1.45, 2, 20], [0.55, 2, 20]], css(0x161210));
      face(c, [[0.45, 2.02, 0], [0.6, 2.02, 0], [0.6, 2.02, 24], [0.45, 2.02, 24]], css(0x7a5430));
      face(c, [[1.4, 2.02, 0], [1.55, 2.02, 0], [1.55, 2.02, 24], [1.4, 2.02, 24]], css(0x7a5430));
      face(c, [[0.4, 2.02, 21], [1.6, 2.02, 21], [1.6, 2.02, 26], [0.4, 2.02, 26]], css(0x8a6038));
      // ore cart
      const [kx, ky] = c.P(1.75, 1.75, 0);
      poly(g, [[kx - 9, ky - 4], [kx + 9, ky - 4], [kx + 7, ky - 12], [kx - 7, ky - 12]], css(0x5a5a5e));
      circle(g, kx - 5, ky - 2, 2.5, css(0x2a2a2a));
      circle(g, kx + 5, ky - 2, 2.5, css(0x2a2a2a));
      for (let i = 0; i < 4; i++) circle(g, kx - 5 + i * 3.2, ky - 13, 2.2, css(i % 2 ? 0xf2c840 : 0x9a968e), null);
      // lantern
      const [lx, ly] = c.P(1.55, 2.0, 24);
      circle(g, lx + 4, ly + 4, 3, "rgba(255,210,100,0.9)", INK, 0.6);
      return pole(0.15, 0.6, 30, 22);
    }
    case "lodge": {
      plinth(c, w, h, 0x7a6a50, 0.05, 3);
      box(c, 0.25, 0.55, 2.75, 2.45, 3, 26, 0x8a5e34, null, "planks");
      gable(c, 0.25, 0.55, 2.75, 2.45, 26, 34, pal.thatch, 0x8a5e34, "x", 0.2, "thatch");
      door(c, 0.65, 2.45, 0.45, 14, 0x2a1a0e);
      door(c, 1.9, 2.45, 0.45, 14, 0x2a1a0e);
      windowR(c, 2.75, 1.2, 12, 0.3, 8);
      // antlers over the middle
      const [ax, ay] = c.P(1.5, 2.45, 22);
      line(g, ax, ay, ax - 8, ay - 8, "rgba(230,220,190,1)", 1.6);
      line(g, ax, ay, ax + 8, ay - 8, "rgba(230,220,190,1)", 1.6);
      line(g, ax - 5, ay - 5, ax - 9, ay - 3, "rgba(230,220,190,1)", 1.2);
      line(g, ax + 5, ay - 5, ax + 9, ay - 3, "rgba(230,220,190,1)", 1.2);
      // chimney with smoke puff
      box(c, 2.2, 0.8, 2.45, 1.05, 30, 62, 0x8a8478, null, "stone");
      const [sx, sy] = c.P(2.32, 0.92, 66);
      circle(g, sx, sy, 4, "rgba(220,220,220,0.5)", null);
      circle(g, sx + 4, sy - 6, 5, "rgba(220,220,220,0.35)", null);
      return pole(0.3, 0.6, 26, 26);
    }
    case "library": {
      plinth(c, w, h, 0xb8b0a0, 0.05, 5);
      box(c, 0.3, 0.3, 2.7, 2.7, 5, 38, pal.stone, null, "stone");
      // portico with columns on the front (+y) face
      face(c, [[0.4, 2.7, 38], [2.6, 2.7, 38], [2.6, 2.95, 38], [0.4, 2.95, 38]], css(0xe8e2d4));
      for (let i = 0; i < 5; i++) {
        const x = 0.55 + i * 0.47;
        const [a, b] = c.P(x, 2.85, 5);
        poly(g, [[a - 3, b], [a - 3, b - 33], [a + 3, b - 33], [a + 3, b]], hgrad(g, a - 3, a + 3, 0xfaf6ea, 0xb8b0a0), INK, 0.7);
      }
      face(c, [[0.35, 2.95, 38], [2.65, 2.95, 38], [1.5, 2.95, 50]], css(0xe8e2d4));
      door(c, 1.3, 2.7, 0.4, 16, 0x3a2a4a);
      windowR(c, 2.7, 0.8, 18, 0.3, 10);
      windowR(c, 2.7, 1.6, 18, 0.3, 10);
      // blue dome with a golden spire
      const [dx, dy] = c.P(1.5, 1.5, 38);
      g.beginPath();
      g.ellipse(dx, dy, 44, 22, 0, 0, Math.PI);
      g.bezierCurveTo(dx - 44, dy - 50, dx + 44, dy - 50, dx + 44, dy);
      g.closePath();
      g.fillStyle = (() => {
        const gr = g.createRadialGradient(dx - 16, dy - 34, 4, dx, dy - 14, 50);
        gr.addColorStop(0, css(shade(pal.dome, 2.2)));
        gr.addColorStop(0.5, css(pal.dome));
        gr.addColorStop(1, css(shade(pal.dome, 0.5)));
        return gr;
      })();
      g.fill();
      g.strokeStyle = INK;
      g.stroke();
      for (let i = -2; i <= 2; i++) {
        g.beginPath();
        g.moveTo(dx + i * 17, dy + 10 - Math.abs(i) * 3);
        g.quadraticCurveTo(dx + i * 9, dy - 30, dx, dy - 37);
        g.strokeStyle = "rgba(20,30,60,0.45)";
        g.stroke();
      }
      line(g, dx, dy - 37, dx, dy - 56, "rgba(230,190,60,1)", 2);
      circle(g, dx, dy - 57, 3, css(0xf0d060));
      return { x: dx, y: dy - 52 };
    }
    case "watchtower": {
      plinth(c, w, h, 0x8a8478, 0.15, 3);
      box(c, 0.45, 0.45, 1.55, 1.55, 3, 84, pal.stone, null, "stone");
      windowL(c, 0.85, 1.55, 40, 0.3, 10);
      windowR(c, 1.55, 0.85, 60, 0.3, 10);
      door(c, 0.8, 1.55, 0.4, 13);
      // overhanging wooden lookout
      box(c, 0.25, 0.25, 1.75, 1.75, 84, 96, 0x7a5434, null, "planks");
      hip(c, 0.2, 0.2, 1.8, 1.8, 96, 34, pal.accent, 0.1);
      return pole(1.0, 1.0, 130, 18);
    }
    case "barracks": {
      plinth(c, w, h, 0x7a7468, 0.05, 4);
      box(c, 0.3, 0.4, 2.7, 2.6, 4, 40, pal.stone, null, "stone");
      // battlements
      face(c, [[0.3, 0.4, 40], [2.7, 0.4, 40], [2.7, 2.6, 40], [0.3, 2.6, 40]], css(0x6a645a));
      for (let i = 0; i < 6; i++) {
        const x = 0.35 + i * 0.4;
        box(c, x, 2.4, x + 0.22, 2.6, 40, 48, pal.stone, shade(pal.stone, 1.15));
      }
      for (let i = 0; i < 5; i++) {
        const y = 0.45 + i * 0.4;
        box(c, 2.5, y, 2.7, y + 0.22, 40, 48, pal.stone, shade(pal.stone, 1.15));
      }
      door(c, 1.25, 2.6, 0.5, 18, 0x2a1a10);
      // shields on the wall
      for (const x of [0.6, 2.2]) {
        const [a, b] = c.P(x, 2.6, 24);
        circle(g, a, b, 5, ball(g, a, b, 5, 0x8a2a2a));
        line(g, a - 3, b - 3, a + 3, b + 3, "rgba(230,230,230,0.9)", 1);
      }
      // weapon rack on the right
      const [rx, ry] = c.P(2.8, 1.2, 0);
      line(g, rx + 2, ry, rx + 2, ry - 16, "rgba(100,70,40,1)", 1.6);
      line(g, rx + 10, ry - 4, rx + 10, ry - 20, "rgba(100,70,40,1)", 1.6);
      for (let i = 0; i < 3; i++) line(g, rx + 3 + i * 3, ry - 2 - i, rx + 4 + i * 3, ry - 22 - i, "rgba(200,205,215,1)", 1.2);
      return pole(1.5, 1.5, 48, 30);
    }
    case "paddock": {
      // Pasture: trampled grass, a trough and a feed shelter in the back corner, and the
      // two back fences. The two front fences are a separate sprite (paddockFrontArt) drawn
      // in front of the animals inside.
      face(c, [[0.05, 0.05, 0], [w - 0.05, 0.05, 0], [w - 0.05, h - 0.05, 0], [0.05, h - 0.05, 0]], css(0x7a9a46, 0.55), null);
      for (let i = 0; i < 26; i++) {
        const [px, py] = c.P(0.3 + rnd(i, 3) * (w - 0.6), 0.3 + rnd(3, i) * (h - 0.6), 0);
        ellipse(g, px, py, 5 + rnd(i, 7) * 6, 2 + rnd(7, i) * 2, css(0x8a6a3a, 0.35), null);
      }
      paddockRails(c, [[0.08, h - 0.08], [0.08, 0.08], [w - 0.08, 0.08]]);
      // feed shelter: four posts and a thatched lean-to over a hay pile
      for (const [x, y] of [[0.25, 0.25], [1.25, 0.25], [0.25, 1.05], [1.25, 1.05]] as const) {
        const [a, b] = c.P(x, y, 0);
        line(g, a, b, a, b - 22, "rgba(90,60,30,1)", 2);
      }
      const [hx, hy] = c.P(0.75, 0.65, 0);
      ellipse(g, hx, hy - 5, 16, 8, ball(g, hx, hy - 6, 16, 0xd8b850));
      face(c, [[0.15, 0.15, 28], [1.35, 0.15, 28], [1.35, 1.15, 20], [0.15, 1.15, 20]], css(pal.thatch));
      stripes(c, [[0.15, 1.15, 20], [1.35, 1.15, 20], [1.35, 0.15, 28], [0.15, 0.15, 28]], "rgba(90,60,20,0.45)", 5);
      // water trough along the back
      box(c, 2.0, 0.3, 3.2, 0.62, 0, 6, 0x7a5430, null, "planks");
      face(c, [[2.05, 0.35, 6], [3.15, 0.35, 6], [3.15, 0.57, 6], [2.05, 0.57, 6]], css(0x4a8ac0));
      return pole(0.08, 0.08, 10, 26);
    }
    default:
      box(c, 0.2, 0.2, w - 0.2, h - 0.2, 0, 24, 0x888888, 0x999999);
      return null;
  }
}

/** Wooden rails through a list of tile-space corner points (posts at every half tile). */
function paddockRails(c: IsoCtx, pts: [number, number][]): void {
  const g = c.g;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [x0, y0] = pts[k] as [number, number];
    const [x1, y1] = pts[k + 1] as [number, number];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= n; i++) {
      const [a, b] = c.P(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, 0);
      line(g, a, b, a, b - 11, "rgba(80,52,26,1)", 2.2);
    }
    for (const z of [4, 9]) {
      const a = c.P(x0, y0, z);
      const b = c.P(x1, y1, z);
      line(g, a[0], a[1], b[0], b[1], "rgba(130,92,50,1)", 1.6);
    }
  }
}

/** The paddock's two front fences, same canvas geometry as buildingArt (drawn in front of its animals). */
export function paddockFrontArt(w: number, h: number): Art {
  const TOP = 150;
  const W = (w + h) * HW + 8;
  const H = TOP + (w + h) * HH + 8;
  const ox = h * HW + 4;
  const oy = TOP;
  return cached(`pf:${w}x${h}`, () =>
    make(W, H, ox, oy, (g) => {
      const c: IsoCtx = { g, P: (x, y, z = 0) => [ox + (x - y) * HW, oy + (x + y) * HH - z] };
      // a gate gap in the middle of the left-front fence
      paddockRails(c, [[0.08, h - 0.08], [w / 2 - 0.5, h - 0.08]]);
      paddockRails(c, [[w / 2 + 0.5, h - 0.08], [w - 0.08, h - 0.08], [w - 0.08, 0.08]]);
    }),
  );
}

export function buildingSize(type: string): [number, number] {
  return BUILDING_SIZE[type] ?? [2, 2];
}

/** White cloth flag (tinted with the owner's colour by the renderer); anchor at the pole. */
export function flagArt(frame: number): Art {
  return cached(`flag${frame}`, () =>
    make(20, 14, 0, 2, (g) => {
      const wv = [0, 1.5, -1.5][frame % 3] as number;
      g.beginPath();
      g.moveTo(0, 1);
      g.quadraticCurveTo(8, 1 + wv, 18, 3);
      g.lineTo(16, 7);
      g.lineTo(18, 11);
      g.quadraticCurveTo(8, 9 - wv, 0, 10);
      g.closePath();
      g.fillStyle = hgrad(g, 0, 18, 0xffffff, 0xc8c8c8);
      g.fill();
      g.strokeStyle = "rgba(20,20,20,0.8)";
      g.lineWidth = 0.8;
      g.stroke();
    }),
  );
}

// ---------------------------------------------------------------- people

/** Skin tones per race (units and heroes). */
const SKIN: Record<string, number> = {
  human: 0xf0c8a0,
  orc: 0x6f9a48,
  dwarf: 0xe8b08c,
  high_elf: 0xf8e0c8,
  dark_elf: 0x9a8cc8,
  undead: 0xb4c0a8,
  troll: 0x5f9ec8,
};

interface Figure {
  skin: number;
  outfit: number;
  trim: number;
  /** Body proportions: dwarves are short and wide. */
  build: "normal" | "short" | "tall" | "big";
  head: "cap" | "hood" | "helmet" | "horned" | "crown" | "leather" | "bare" | "mask" | "circlet" | "skullhood";
  hair: number;
  beard: boolean;
  ears: boolean;
  tusks: boolean;
  robe: boolean;
  cape: boolean;
  back: "axe" | "pack" | "quiver" | "bundle" | "none";
  shield: boolean;
  armor: boolean;
  glowEyes: boolean;
}

function raceTraits(race: string): Partial<Figure> {
  switch (race) {
    case "dwarf":
      return { build: "short", beard: true, hair: 0xb05a2a };
    case "high_elf":
      return { build: "tall", ears: true, hair: 0xf0d878 };
    case "dark_elf":
      return { build: "tall", ears: true, hair: 0xe8e8f0 };
    case "orc":
      return { build: "big", tusks: true, hair: 0x1a1a1a };
    case "troll":
      return { build: "tall", tusks: true, ears: true, hair: 0xd04a2a };
    case "undead":
      return { glowEyes: true, hair: 0x4a4a40 };
    default:
      return { hair: 0x5a3a1a };
  }
}

function figureFor(type: string, race: string): Figure {
  const base: Figure = {
    skin: SKIN[race] ?? SKIN.human!,
    outfit: 0x6a7a4a,
    trim: 0x4a3420,
    build: "normal",
    head: "bare",
    hair: 0x5a3a1a,
    beard: false,
    ears: false,
    tusks: false,
    robe: false,
    cape: false,
    back: "none",
    shield: false,
    armor: false,
    glowEyes: false,
    ...raceTraits(race),
  };
  switch (type) {
    case "woodcutter":
      return { ...base, outfit: 0x4f7a3a, trim: 0x6a4424, head: "cap", back: "axe" };
    case "builder":
      return { ...base, outfit: 0x9a6a3a, trim: 0x4a3420, head: "leather", beard: base.beard || race === "human" };
    case "scout":
      return { ...base, outfit: 0x3a5a4a, trim: 0x2a3a2a, head: "hood", back: "quiver" };
    case "worker":
      return { ...base, outfit: 0xb09060, trim: 0x6a4a2a, head: "bare", back: "bundle" };
    case "hauler":
      return { ...base, outfit: 0x7a5a3a, trim: 0x4a3420, head: "cap", back: "pack", build: base.build === "short" ? "short" : "big" };
    case "soldier":
      return { ...base, outfit: 0x7a7a84, trim: 0x3a3a44, head: "helmet", shield: true, armor: true };
    case "archer":
      return { ...base, outfit: 0x4a6a3a, trim: 0x3a2a1a, head: "hood", back: "quiver" };
    case "miner":
      return { ...base, outfit: 0x6a6258, trim: 0x3a3028, head: "helmet", back: "pack", beard: base.beard || race === "human" };
    case "ranger":
      return { ...base, outfit: 0x3e5a2e, trim: 0x5a3a1e, head: "hood", back: "quiver", cape: true };
    case "knight":
      return { ...base, outfit: 0xa8aebc, trim: 0x4a4a58, head: "helmet", shield: true, armor: true, cape: true, build: base.build === "short" ? "short" : "big" };
    case "cleric":
      return { ...base, outfit: 0xf0ead8, trim: 0xc8a040, head: "circlet", robe: true };
    // monsters (race "monster": skin and build come from the type)
    case "goblin":
      return { ...base, skin: 0x7aa040, hair: 0x2a2a1a, build: "short", ears: true, tusks: false, outfit: 0x6a4a2a, trim: 0x3a2a1a, head: "leather" };
    case "goblin_chief":
      return { ...base, skin: 0x6a9a38, hair: 0x2a2a1a, build: "short", ears: true, tusks: true, outfit: 0x5a2a1a, trim: 0x9a7a2a, head: "horned", armor: true, cape: true };
    case "skeleton":
      return { ...base, skin: 0xe4e0d0, hair: 0xe4e0d0, outfit: 0x4a4a42, trim: 0x2a2a26, head: "bare", glowEyes: true, shield: true, beard: false, ears: false, tusks: false };
    case "lich":
      return { ...base, skin: 0xd8d8c4, hair: 0xd8d8c4, outfit: 0x2a3a2e, trim: 0x8ad070, head: "crown", robe: true, cape: true, glowEyes: true, beard: false };
    case "ogre":
      return { ...base, skin: 0x8a9a62, hair: 0x2a2a1a, build: "big", tusks: true, outfit: 0x6a4a2a, trim: 0x4a3420, head: "bare", glowEyes: false };
    case "ogre_warlord":
      return { ...base, skin: 0x7a8a52, hair: 0x2a1a10, build: "big", tusks: true, outfit: 0x5a3a24, trim: 0x8a2a1a, head: "horned", armor: true, cape: true };
    // heroes
    case "hero_human":
      return { ...base, outfit: 0xc8ccd8, trim: 0xd8b040, head: "crown", armor: true, shield: true, cape: true, build: "big" };
    case "hero_orc":
      return { ...base, outfit: 0x6a4a2a, trim: 0x9a2a1a, head: "horned", armor: true, cape: true, build: "big" };
    case "hero_dwarf":
      return { ...base, outfit: 0x8a8a94, trim: 0xd8a040, head: "horned", armor: true, shield: true, cape: true, build: "short" };
    case "hero_high_elf":
      return { ...base, outfit: 0xe8e0f0, trim: 0xd8b040, head: "circlet", robe: true, cape: true };
    case "hero_dark_elf":
      return { ...base, outfit: 0x3a2a5a, trim: 0x8a6ad0, head: "hood", cape: true };
    case "hero_undead":
      return { ...base, outfit: 0x2a2a30, trim: 0x6ad070, head: "skullhood", robe: true, cape: true, glowEyes: true };
    case "hero_troll":
      return { ...base, outfit: 0x7a5a2a, trim: 0xd06a2a, head: "mask", cape: true, back: "bundle" };
    default:
      return base;
  }
}

/**
 * A person seen from the front-right in three-quarter view, feet at (20, 48).
 * `team` draws only the parts shown in the owner's colour (white, to be tinted).
 */
function drawFigure(g: G, f: Figure, layer: "back" | "body" | "front"): void {
  const team = layer !== "body";
  const short = f.build === "short";
  const big = f.build === "big";
  const tall = f.build === "tall";
  const sx = short ? 1.18 : big ? 1.12 : tall ? 0.94 : 1;
  const top = short ? 8 : tall ? -3 : 0; // head lower for short folk
  g.save();
  g.translate(20, 48);
  g.scale(sx, 1);
  g.translate(-20, -48);
  const T = (y: number): number => y + top * ((48 - y) / 48);
  const W = 0xffffff;
  // cape: its own layer, behind the body
  if (layer === "back") {
    if (f.cape) poly(g, [[14, T(21)], [27, T(21)], [31, T(44)], [22, T(46.5)], [10, T(43)]], vgrad(g, T(22), T(46), W, 0x9a9a9a), "rgba(0,0,0,0.6)");
    g.restore();
    return;
  }
  if (!team) {
    // back items
    if (f.back === "pack") {
      poly(g, [[7, T(20)], [16, T(19)], [17, T(36)], [8, T(37)]], vgrad(g, T(19), T(37), 0x9a7040, 0x5a3e20));
      line(g, 9, T(24), 15, T(24), "rgba(40,24,10,0.7)", 1);
    } else if (f.back === "bundle") {
      ellipse(g, 12, T(27), 5, 6, ball(g, 12, T(27), 6, 0xc8a870));
    } else if (f.back === "quiver") {
      poly(g, [[10, T(18)], [14, T(17)], [16, T(32)], [12, T(33)]], css(0x7a4a24));
      for (let i = 0; i < 3; i++) line(g, 11 + i, T(18), 10 + i, T(13), "rgba(230,220,200,1)", 0.9);
    } else if (f.back === "axe") {
      line(g, 11, T(34), 17, T(17), "rgba(110,70,30,1)", 2);
      poly(g, [[15, T(17)], [20, T(15)], [19, T(22)]], css(0xc8ccd4));
    }
    // legs / robe
    if (f.robe) {
      poly(g, [[13, T(30)], [27, T(30)], [30, 47], [10, 47]], hgrad(g, 10, 30, shade(f.outfit, 1.15), shade(f.outfit, 0.65)));
      line(g, 20, T(32), 21, 46, css(shade(f.outfit, 0.6)), 1);
    } else {
      poly(g, [[15, T(36)], [19, T(36)], [18.5, 45], [15, 45]], css(shade(f.trim, 0.85)));
      poly(g, [[20.5, T(36)], [25, T(36)], [25, 45], [21, 45]], css(f.trim));
      ellipse(g, 17, 46, 3.4, 2, css(0x2a1a10));
      ellipse(g, 23.5, 46, 3.6, 2, css(0x2a1a10));
    }
    // back arm
    poly(g, [[13, T(23)], [16, T(23)], [15, T(33)], [12, T(33)]], css(shade(f.armor ? f.outfit : f.outfit, 0.7)));
    circle(g, 13.5, T(34), 2, css(shade(f.skin, 0.8)), INK, 0.8);
    // torso
    poly(g, [[14, T(21)], [27, T(21)], [28, T(37)], [13, T(37)]], hgrad(g, 13, 28, shade(f.outfit, 1.2), shade(f.outfit, 0.7)));
    if (f.armor) {
      line(g, 15, T(26), 27, T(26), "rgba(255,255,255,0.35)", 1);
      circle(g, 15, T(22.5), 3.2, ball(g, 15, T(22.5), 3.2, f.outfit));
      circle(g, 26, T(22.5), 3.2, ball(g, 26, T(22.5), 3.2, f.outfit));
    }
    // belt
    line(g, 13.5, T(33), 27.5, T(33), css(f.trim), 2);
    circle(g, 21, T(33), 1.2, css(0xe0c050), null);
  }
  // tabard / sash in team colour
  if (team) {
    poly(g, [[18, T(23)], [24, T(23)], [24.5, T(37)], [17.5, T(37)]], vgrad(g, T(23), T(37), W, 0xc0c0c0), "rgba(0,0,0,0.45)", 0.8);
    if (f.robe) poly(g, [[17.5, T(37)], [24.5, T(37)], [25.5, 46], [16.5, 46]], vgrad(g, T(37), 46, 0xe0e0e0, 0xa0a0a0), "rgba(0,0,0,0.45)", 0.8);
  }
  if (!team) {
    // head
    const hy = T(15);
    if (f.head === "hood" || f.head === "skullhood") {
      circle(g, 21, hy - 0.5, 8, ball(g, 21, hy - 0.5, 8, f.outfit));
    }
    circle(g, 21, hy, 6.4, ball(g, 21, hy, 6.4, f.skin));
    if (f.ears) {
      poly(g, [[15.5, hy - 1], [10.5, hy - 5], [16, hy + 2]], css(shade(f.skin, 0.9)));
    }
    // hair (bare heads)
    if (f.head === "bare" || f.head === "circlet" || f.head === "mask") {
      g.beginPath();
      g.arc(21, hy - 1, 6.6, Math.PI * 1.05, Math.PI * 1.95);
      g.fillStyle = css(f.hair);
      g.fill();
    }
    // face
    if (f.glowEyes) {
      circle(g, 24.2, hy - 0.5, 1.4, "rgba(120,255,140,1)", null);
      circle(g, 24.2, hy - 0.5, 2.6, "rgba(120,255,140,0.3)", null);
    } else {
      circle(g, 24.2, hy - 0.5, 0.9, css(0x1a1010), null);
    }
    line(g, 26.4, hy + 0.5, 27.2, hy + 1.6, css(shade(f.skin, 0.7)), 1);
    if (f.tusks) {
      poly(g, [[24.5, hy + 3.4], [25.5, hy + 0.8], [26.2, hy + 3.4]], css(0xf4f0e0), INK, 0.5);
    }
    if (f.beard) {
      poly(g, [[16.5, hy + 1], [26.5, hy + 1], [26, hy + 9], [21, hy + 13], [16, hy + 8]], vgrad(g, hy, hy + 13, shade(f.hair, 1.2), shade(f.hair, 0.8)));
    }
    switch (f.head) {
      case "cap":
        g.beginPath();
        g.arc(21, hy - 1.5, 6.6, Math.PI, 0);
        g.closePath();
        g.fillStyle = css(f.trim === 0x6a4424 ? 0x4a7a3a : 0x8a5a2a);
        g.fill();
        g.strokeStyle = INK;
        g.stroke();
        line(g, 21, hy - 1.5, 29, hy - 0.5, css(0x6a4424), 1.6);
        break;
      case "leather":
        g.beginPath();
        g.arc(21, hy - 1, 6.8, Math.PI * 1.02, Math.PI * 1.98);
        g.closePath();
        g.fillStyle = css(0x8a5a2a);
        g.fill();
        g.strokeStyle = INK;
        g.stroke();
        break;
      case "helmet":
      case "horned":
        g.beginPath();
        g.arc(21, hy - 0.5, 7, Math.PI, 0);
        g.closePath();
        g.fillStyle = ball(g, 21, hy - 3, 7, 0x9aa0aa);
        g.fill();
        g.strokeStyle = INK;
        g.stroke();
        line(g, 23.6, hy - 1, 23.6, hy + 3.2, "rgba(150,155,165,1)", 1.4);
        if (f.head === "horned") {
          poly(g, [[14.5, hy - 3], [9, hy - 9], [10, hy - 13], [13, hy - 7], [16, hy - 5]], css(0xf0e6c8));
          poly(g, [[27.5, hy - 3], [31, hy - 10], [29, hy - 13], [27, hy - 7], [25.5, hy - 5]], css(0xf0e6c8));
        }
        break;
      case "crown":
        poly(g, [[15, hy - 4], [15, hy - 9], [17.5, hy - 6], [21, hy - 11], [24.5, hy - 6], [27, hy - 9], [27, hy - 4]], vgrad(g, hy - 11, hy - 4, 0xfff0a0, 0xc89a20));
        circle(g, 21, hy - 6, 1.2, css(0xd03040), null);
        break;
      case "circlet":
        line(g, 15, hy - 3, 27, hy - 3.5, "rgba(230,190,60,1)", 1.4);
        circle(g, 24, hy - 3.6, 1.3, "rgba(120,200,255,1)", null);
        break;
      case "mask":
        poly(g, [[19, hy - 6], [28.5, hy - 5], [28, hy + 5], [21, hy + 6]], vgrad(g, hy - 6, hy + 6, 0xe8d8a8, 0xa88a50));
        circle(g, 24.5, hy - 1.5, 1.2, css(0x1a1010), null);
        line(g, 21, hy + 2, 27.5, hy + 2, "rgba(170,40,30,1)", 1.2);
        for (let i = 0; i < 3; i++) poly(g, [[16 + i * 3, hy - 6], [14 + i * 4, hy - 16], [18 + i * 3, hy - 7]], css([0xd04a2a, 0x2a8ac8, 0xe0c040][i] as number), INK, 0.5);
        break;
      case "skullhood":
        circle(g, 21, hy - 5, 2.4, css(0xe8e4d8), INK, 0.6);
        break;
      default:
        break;
    }
    // front arm
    poly(g, [[24, T(23)], [27.5, T(23)], [29, T(32)], [26, T(33)]], css(shade(f.outfit, 0.95)));
    circle(g, 27.8, T(33), 2.2, ball(g, 27.8, T(33), 2.2, f.skin), INK, 0.8);
  }
  // shield (front, team emblem)
  if (f.shield) {
    if (!team) {
      poly(g, [[10, T(24)], [17, T(23)], [17, T(33)], [13.5, T(38)], [10, T(33)]], hgrad(g, 10, 17, 0xd0d4dc, 0x7a808a));
    } else {
      poly(g, [[11.5, T(26)], [15.5, T(25.5)], [15.5, T(32)], [13.5, T(35)], [11.5, T(32)]], css(0xffffff), "rgba(0,0,0,0.5)", 0.6);
    }
  }
  g.restore();
}

/** Unit art (owner-independent): a team-coloured back layer (cape), the body, and a team-coloured front layer. */
export function personArt(type: string, race: string): { back: Art | null; body: Art; team: Art } {
  const f = figureFor(type, race);
  return {
    back: f.cape ? cached(`pb:${type}:${race}`, () => make(40, 52, 20, 48, (g) => drawFigure(g, f, "back"))) : null,
    body: cached(`p:${type}:${race}`, () => make(40, 52, 20, 48, (g) => drawFigure(g, f, "body"))),
    team: cached(`pt:${type}:${race}`, () => make(40, 52, 20, 48, (g) => drawFigure(g, f, "front"))),
  };
}

// ---------------------------------------------------------------- creatures

export function creatureArt(type: string): Art {
  if (type === "giant_spider" || type === "spider_queen") return spiderArt(type === "spider_queen");
  if (type === "drake_whelp" || type === "ancient_drake") return drakeArt(type === "ancient_drake");
  return cached(`c:${type}`, () =>
    make(56, 48, 28, 42, (g) => {
      g.translate(28, 42);
      const look = BEAST[type] ?? (BEAST.wolf as Beast);
      const fur = look.fur;
      const dark = shade(fur, 0.6);
      const legs = look.legs;
      const bodyY = -legs - 6;
      // legs
      for (const [x, d] of [[-12, 0.8], [-6, 1], [8, 0.8], [13, 1]] as const) {
        const lw = look.thick ? 2.6 : 1.6;
        poly(g, [[x - lw, bodyY + 3], [x + lw, bodyY + 3], [x + lw * 0.75, 0], [x - lw * 0.75, 0]], css(shade(look.legColor ?? fur, d * 0.85)), INK, 0.8);
        ellipse(g, x, 0, lw + 0.4, 1.2, css(0x2a1a10), null);
      }
      // body
      const bw = look.bw;
      const bh = look.bh;
      if (look.wool) {
        for (let i = 0; i < 9; i++) circle(g, -bw + 4 + (i % 5) * ((bw * 2 - 8) / 4), bodyY - 2 + (i >= 5 ? 4 : -2), bh * 0.62, ball(g, -bw + 4 + (i % 5) * 6, bodyY - 3, bh, fur), "rgba(60,50,40,0.5)", 0.7);
      }
      ellipse(g, 0, bodyY, bw, bh, ball(g, 0, bodyY, bw, fur));
      if (type === "deer") {
        ellipse(g, 0, bodyY + 3.5, 11, 3, css(0xf0e0c0, 0.8), null);
        for (let i = 0; i < 5; i++) circle(g, -8 + i * 4, bodyY - 3 + (i % 2), 1, "rgba(250,240,220,0.9)", null);
      }
      if (type === "boar") for (let i = 0; i < 7; i++) line(g, -10 + i * 3, bodyY - 7, -9 + i * 3, bodyY - 11, css(shade(fur, 0.5)), 1.2);
      if (type === "horse") for (let i = 0; i < 6; i++) line(g, 8 + i * 1.5, bodyY - 6 - i * 1.6, 5 + i * 1.5, bodyY - 2 - i * 1.6, css(0x2a1a10), 1.6);
      if (type === "bear") ellipse(g, -2, bodyY - 4, bw * 0.7, bh * 0.6, css(shade(fur, 1.2), 0.5), null);
      // tail
      if (type === "wolf") poly(g, [[-15, bodyY - 2], [-26, bodyY + 4], [-24, bodyY + 7], [-14, bodyY + 3]], ball(g, -20, bodyY + 3, 6, fur));
      else if (type === "horse") poly(g, [[-bw + 1, bodyY - 3], [-bw - 7, bodyY + 10], [-bw - 3, bodyY + 12], [-bw + 2, bodyY + 1]], css(0x2a1a10), INK, 0.6);
      else if (type === "aurochs") line(g, -bw + 1, bodyY - 2, -bw - 3, bodyY + 9, css(dark), 1.4);
      else circle(g, -bw, bodyY - 2, 2.2, css(type === "deer" || type === "sheep" ? 0xf0e8d8 : dark));
      // neck and head
      const hx = bw + (look.neck ?? 1);
      const hy = bodyY + (look.headLift ?? 0);
      poly(g, [[bw - 6, bodyY - 4], [hx - 2, hy - 3], [hx + 2, hy + 4], [bw - 4, bodyY + 4]], css(look.head ?? fur), INK, 0.8);
      ellipse(g, hx + 2, hy, look.headW ?? 6, 4.5, ball(g, hx + 2, hy, 6, look.head ?? fur));
      // snout
      if (type === "boar") {
        ellipse(g, hx + 8.5, hy + 1.5, 3, 3, css(0xb87a6a));
        poly(g, [[hx + 6, hy + 3], [hx + 9, hy - 1.5], [hx + 7.5, hy + 3.5]], css(0xf4f0e0), INK, 0.5);
      } else if (type === "bear") {
        ellipse(g, hx + 7.5, hy + 1.5, 3.4, 2.6, css(shade(fur, 1.3)));
        circle(g, hx + 10, hy + 1, 1.2, css(0x1a1010), null);
      } else {
        poly(g, [[hx + 6, hy - 1.5], [hx + 12, hy + 1], [hx + 6, hy + 3]], css(shade(look.head ?? fur, 0.9)), INK, 0.8);
        circle(g, hx + 12, hy + 1, 1.1, css(0x1a1010), null);
      }
      circle(g, hx + 3.5, hy - 1.2, 1, css(0x1a1010), null);
      // ears
      if (type === "bear") {
        circle(g, hx - 1, hy - 4, 2.4, css(dark), INK, 0.6);
      } else {
        poly(g, [[hx - 1, hy - 3], [hx - 2, hy - (type === "wolf" ? 9 : 7)], [hx + 2, hy - 4]], css(dark), INK, 0.6);
      }
      if (type === "deer") {
        const ant = "rgba(230,215,180,1)";
        line(g, hx + 1, hy - 4, hx - 3, hy - 14, ant, 1.4);
        line(g, hx - 1, hy - 9, hx - 6, hy - 11, ant, 1.1);
        line(g, hx - 2, hy - 12, hx + 1, hy - 17, ant, 1.1);
        line(g, hx + 3, hy - 4, hx + 5, hy - 13, ant, 1.4);
        line(g, hx + 4, hy - 9, hx + 9, hy - 11, ant, 1.1);
      }
      if (type === "goat") {
        g.beginPath();
        g.moveTo(hx + 1, hy - 4);
        g.quadraticCurveTo(hx - 6, hy - 12, hx - 7, hy - 4);
        g.strokeStyle = css(0xd8c8a0);
        g.lineWidth = 2;
        g.stroke();
        poly(g, [[hx + 5, hy + 3], [hx + 7, hy + 9], [hx + 8, hy + 3]], css(0xe8e0d0), INK, 0.5);
      }
      if (type === "aurochs") {
        for (const sgn of [-1, 1]) {
          g.beginPath();
          g.moveTo(hx + 1, hy - 3);
          g.quadraticCurveTo(hx + 1 + sgn * 9, hy - 6, hx + 1 + sgn * 7, hy - 13);
          g.strokeStyle = css(0xe8e0c8);
          g.lineWidth = 2.2;
          g.stroke();
        }
      }
    }),
  );
}

interface Beast {
  fur: number;
  legs: number;
  bw: number;
  bh: number;
  head?: number;
  legColor?: number;
  headW?: number;
  neck?: number;
  headLift?: number;
  wool?: boolean;
  thick?: boolean;
}

const BEAST: Record<string, Beast> = {
  deer: { fur: 0xb07a44, legs: 14, bw: 16, bh: 7, headLift: -12 },
  boar: { fur: 0x5a3e2a, legs: 8, bw: 17, bh: 8.5, neck: 1 },
  wolf: { fur: 0x8a8a94, legs: 11, bw: 16, bh: 7, headLift: -6 },
  sheep: { fur: 0xf0ece0, legs: 8, bw: 14, bh: 8, head: 0x3a3430, legColor: 0x3a3430, headW: 5, headLift: -3, wool: true },
  goat: { fur: 0xc8b48a, legs: 11, bw: 13, bh: 6.5, headLift: -8 },
  horse: { fur: 0x8a5a32, legs: 17, bw: 17, bh: 7.5, headLift: -13, headW: 7, neck: 2 },
  aurochs: { fur: 0x3a2a20, legs: 11, bw: 19, bh: 10, headLift: -1, thick: true, headW: 7 },
  bear: { fur: 0x5a3a24, legs: 8, bw: 18, bh: 11, headLift: -4, thick: true, headW: 7 },
};

/** Giant spider (or the much larger, purple-marked queen). */
function spiderArt(queen: boolean): Art {
  return cached(`c:spider:${queen}`, () =>
    make(56, 48, 28, 42, (g) => {
      g.translate(28, 42);
      const body = queen ? 0x3a1a3a : 0x26262c;
      const bodyY = -12;
      for (let i = 0; i < 4; i++) {
        for (const side of [-1, 1]) {
          const kx = side * (8 + i * 3);
          const ky = bodyY - 10 + i * 2;
          const fx = side * (12 + i * 5);
          g.beginPath();
          g.moveTo(side * 3, bodyY);
          g.lineTo(kx, ky);
          g.lineTo(fx, -1 + (i % 2));
          g.strokeStyle = css(shade(body, 0.8));
          g.lineWidth = 2.2;
          g.stroke();
        }
      }
      ellipse(g, -6, bodyY - 2, 11, 8.5, ball(g, -6, bodyY - 2, 11, body));
      if (queen) for (let i = 0; i < 3; i++) circle(g, -9 + i * 3.5, bodyY - 6 + (i % 2) * 2, 1.6, "rgba(200,60,200,0.9)", null);
      else line(g, -12, bodyY - 4, -2, bodyY - 6, "rgba(200,40,40,0.8)", 1.4);
      ellipse(g, 7, bodyY + 1, 6, 5, ball(g, 7, bodyY + 1, 6, shade(body, 1.2)));
      for (const [x, y] of [[9, bodyY - 1], [11, bodyY], [10, bodyY + 2]] as const) circle(g, x, y, 0.9, "rgba(255,60,40,1)", null);
      poly(g, [[11, bodyY + 4], [13, bodyY + 7], [12, bodyY + 3]], css(0xd8d0c0), INK, 0.4);
    }),
  );
}

/** Drake (whelp, or an ancient drake with a crest): wings, long neck and tail. */
function drakeArt(ancient: boolean): Art {
  return cached(`c:drake:${ancient}`, () =>
    make(60, 52, 30, 46, (g) => {
      g.translate(30, 46);
      const scale = ancient ? 0x8a1c14 : 0xb04a28;
      const belly = 0xe0b060;
      const bodyY = -16;
      // far wing
      poly(g, [[-4, bodyY - 6], [-10, bodyY - 28], [4, bodyY - 20], [8, bodyY - 8]], css(shade(scale, 0.6)), INK, 0.8);
      // tail
      poly(g, [[-12, bodyY], [-28, bodyY + 10], [-26, bodyY + 13], [-10, bodyY + 5]], ball(g, -18, bodyY + 6, 8, scale));
      // legs
      for (const [x, d] of [[-8, 0.8], [-3, 1], [7, 0.8], [11, 1]] as const) {
        poly(g, [[x - 2.4, bodyY + 4], [x + 2.4, bodyY + 4], [x + 2, 0], [x - 2, 0]], css(shade(scale, d * 0.8)), INK, 0.8);
      }
      ellipse(g, 0, bodyY, 15, 8, ball(g, 0, bodyY, 15, scale));
      ellipse(g, 1, bodyY + 4, 10, 3, css(belly, 0.85), null);
      // neck and head
      poly(g, [[9, bodyY - 4], [16, bodyY - 18], [20, bodyY - 15], [13, bodyY + 2]], css(scale), INK, 0.8);
      ellipse(g, 20, bodyY - 19, 6, 4, ball(g, 20, bodyY - 19, 6, scale));
      poly(g, [[24, bodyY - 21], [30, bodyY - 18], [24, bodyY - 16]], css(shade(scale, 0.9)), INK, 0.7);
      circle(g, 21, bodyY - 21, 1.2, "rgba(255,220,60,1)", null);
      for (const dx of [-1, 2]) poly(g, [[18 + dx, bodyY - 22], [15 + dx, bodyY - 29], [20 + dx, bodyY - 23]], css(0xe8dcc0), INK, 0.5);
      if (ancient) for (let i = 0; i < 5; i++) poly(g, [[-8 + i * 4, bodyY - 7], [-6 + i * 4, bodyY - 12], [-4 + i * 4, bodyY - 7]], css(0xe0c070), INK, 0.4);
      // near wing
      poly(g, [[0, bodyY - 5], [-14, bodyY - 30], [-2, bodyY - 26], [6, bodyY - 32], [12, bodyY - 8]], css(shade(scale, 1.15), 0.95), INK, 0.9);
      line(g, 0, bodyY - 5, -14, bodyY - 30, "rgba(40,10,10,0.6)", 1);
      line(g, 4, bodyY - 6, 6, bodyY - 32, "rgba(40,10,10,0.6)", 1);
    }),
  );
}

/** A lair's landmark, drawn at its centre: camp, nest, crypt, den or roost. Cleared lairs look abandoned. */
export function lairArt(kind: string, cleared: boolean): Art {
  return cached(`lair:${kind}:${cleared}`, () =>
    make(96, 80, 48, 62, (g) => {
      g.translate(48, 62);
      if (cleared) g.globalAlpha = 0.75;
      switch (kind) {
        case "goblin_camp": {
          // two hide tents, a fire pit and a spiked banner of skulls
          for (const [x, y, c] of [[-22, -2, 0x8a6a3a], [16, 4, 0x7a5a32]] as const) {
            poly(g, [[x - 16, y], [x, y - 26], [x + 16, y]], hgrad(g, x - 16, x + 16, shade(c, 1.2), shade(c, 0.7)));
            poly(g, [[x - 4, y], [x, y - 12], [x + 4, y]], css(0x1a120a));
            line(g, x, y - 26, x - 3, y - 32, "rgba(90,60,30,1)", 1.4);
            line(g, x, y - 26, x + 3, y - 32, "rgba(90,60,30,1)", 1.4);
          }
          ellipse(g, 0, 10, 8, 4, css(0x4a3a2a));
          if (!cleared) {
            poly(g, [[-5, 9], [0, -4], [5, 9]], "rgba(255,150,40,0.9)", null);
            poly(g, [[-2.5, 9], [0, 1], [2.5, 9]], "rgba(255,230,120,0.95)", null);
          }
          line(g, 34, 10, 34, -40, "rgba(70,46,24,1)", 2.2);
          if (!cleared) poly(g, [[34, -40], [48, -36], [34, -30]], css(0x9a2a1a));
          circle(g, 34, -24, 3.4, css(0xe8e4d8), INK, 0.7);
          break;
        }
        case "spider_nest": {
          for (const x of [-30, 28]) line(g, x, 8, x + 4, -46, "rgba(70,50,30,1)", 2.4);
          g.strokeStyle = "rgba(235,235,240,0.75)";
          g.lineWidth = 0.8;
          for (let i = 0; i < 8; i++) {
            g.beginPath();
            g.moveTo(0, -22);
            g.lineTo(Math.cos((i / 8) * Math.PI * 2) * 30, -22 + Math.sin((i / 8) * Math.PI * 2) * 22);
            g.stroke();
          }
          for (let r = 6; r <= 28; r += 7) {
            g.beginPath();
            g.ellipse(0, -22, r, r * 0.75, 0, 0, Math.PI * 2);
            g.stroke();
          }
          for (const [x, y] of [[-14, 6], [-8, 9], [10, 7], [16, 10]] as const) ellipse(g, x, y, 4, 5, ball(g, x, y, 5, 0xe8e0d0), "rgba(80,70,60,0.6)", 0.6);
          break;
        }
        case "bone_crypt": {
          // stone tomb with a dark doorway and tombstones
          poly(g, [[-26, 6], [-26, -22], [0, -36], [26, -22], [26, 6]], hgrad(g, -26, 26, 0x9a9a8e, 0x5a5a52));
          poly(g, [[-8, 6], [-8, -14], [0, -20], [8, -14], [8, 6]], css(cleared ? 0x3a3a34 : 0x0e0e10));
          if (!cleared) for (const x of [-3, 3]) circle(g, x, -8, 1.3, "rgba(120,255,140,0.9)", null);
          for (const [x, y] of [[-38, 12], [36, 10], [-30, 18]] as const) poly(g, [[x - 4, y], [x - 4, y - 10], [x, y - 13], [x + 4, y - 10], [x + 4, y]], css(0x8a8a80), INK, 0.7);
          break;
        }
        case "ogre_den": {
          // a rocky cave mouth with bones scattered in front
          g.beginPath();
          g.moveTo(-42, 8);
          g.bezierCurveTo(-36, -36, 30, -46, 42, 8);
          g.closePath();
          g.fillStyle = hgrad(g, -42, 42, 0x8a8278, 0x4a4640);
          g.fill();
          g.strokeStyle = INK;
          g.stroke();
          g.beginPath();
          g.moveTo(-16, 8);
          g.bezierCurveTo(-14, -20, 14, -22, 16, 8);
          g.closePath();
          g.fillStyle = css(0x120e0a);
          g.fill();
          for (const [x, y, a] of [[-24, 12, 0.3], [20, 14, -0.4], [-4, 16, 0.1]] as const) {
            g.save();
            g.translate(x, y);
            g.rotate(a);
            line(g, -6, 0, 6, 0, "rgba(232,228,214,1)", 2);
            circle(g, -6, 0, 1.6, css(0xe8e4d6), null);
            circle(g, 6, 0, 1.6, css(0xe8e4d6), null);
            g.restore();
          }
          break;
        }
        default: {
          // drake roost: a jagged spire of scorched rock and a gold hoard
          poly(g, [[-30, 8], [-18, -30], [-8, -10], [2, -50], [14, -16], [26, -28], [34, 8]], hgrad(g, -30, 34, 0x5a4a44, 0x2a2220));
          if (!cleared) for (let i = 0; i < 12; i++) circle(g, -14 + (i % 6) * 5 + (i > 5 ? 2 : 0), 10 - (i > 5 ? 3 : 0), 2.6, ball(g, 0, 8, 3, 0xf2c840), "rgba(120,80,10,0.6)", 0.5);
          break;
        }
      }
    }),
  );
}

// ---------------------------------------------------------------- tools and weapons

/** Held items, drawn pointing up from the grip at (6, 26). */
export function toolArt(kind: string): Art {
  return cached(`t:${kind}`, () =>
    make(30, 34, 8, 28, (g) => {
      const handle = (len: number, color = 0x7a4a24): void => line(g, 8, 28, 8, 28 - len, css(color), 2);
      switch (kind) {
        case "axe":
          handle(20);
          poly(g, [[8, 10], [16, 6], [17, 14], [8, 14]], hgrad(g, 8, 17, 0xe0e4ec, 0x8a909a));
          break;
        case "greataxe":
          handle(26, 0x4a2a14);
          poly(g, [[8, 4], [19, -1], [20, 14], [8, 10]], hgrad(g, 8, 20, 0xd0d4dc, 0x6a707a));
          poly(g, [[8, 4], [-1, 2], [0, 12], [8, 10]], hgrad(g, -1, 8, 0x6a707a, 0xb0b4bc));
          break;
        case "pick":
          handle(20);
          poly(g, [[0, 9], [8, 6], [17, 9], [8, 9]], css(0x9a9ea8));
          break;
        case "hammer":
          handle(18);
          poly(g, [[3, 7], [13, 7], [13, 13], [3, 13]], hgrad(g, 3, 13, 0xa0a4ac, 0x5a5e66));
          break;
        case "warhammer":
          handle(24, 0x5a3a1a);
          poly(g, [[2, 3], [14, 3], [14, 10], [2, 10]], hgrad(g, 2, 14, 0xdfe3ea, 0x7a808a));
          line(g, 2, 6.5, 14, 6.5, css(0xe0b040), 1.4);
          circle(g, 8, 1.5, 1.6, css(0xe0b040), INK, 0.6);
          break;
        case "sword":
          line(g, 8, 28, 8, 24, css(0x5a3a1a), 2.4);
          line(g, 4, 24, 12, 24, css(0xc8a040), 2);
          poly(g, [[6.5, 24], [9.5, 24], [9, 4], [8, 1], [7, 4]], hgrad(g, 6, 10, 0xffffff, 0x9aa0aa));
          break;
        case "dagger":
          line(g, 8, 28, 8, 24, css(0x2a1a2a), 2.4);
          poly(g, [[6.8, 24], [9.2, 24], [8.6, 12], [8, 9], [7.4, 12]], hgrad(g, 6, 10, 0xe8e0ff, 0x7a6aa0));
          break;
        case "bow":
          g.beginPath();
          g.moveTo(8, 28);
          g.quadraticCurveTo(20, 15, 8, 2);
          g.strokeStyle = css(0x8a5a2a);
          g.lineWidth = 2;
          g.stroke();
          line(g, 8, 28, 8, 2, "rgba(240,240,230,0.9)", 0.7);
          break;
        case "staff_orb":
          handle(26, 0xe8d8b0);
          circle(g, 8, 2, 6, "rgba(120,200,255,0.3)", null);
          circle(g, 8, 2, 3.4, ball(g, 8, 2, 3.4, 0x6ac8ff), INK, 0.6);
          break;
        case "staff_skull":
          handle(26, 0x3a3a2a);
          circle(g, 8, 2, 6, "rgba(120,255,140,0.25)", null);
          circle(g, 8, 2, 3.6, css(0xe8e4d8), INK, 0.7);
          circle(g, 7, 1.6, 0.9, "rgba(80,255,120,1)", null);
          circle(g, 9.6, 1.6, 0.9, "rgba(80,255,120,1)", null);
          break;
        case "staff_feather":
          handle(26, 0x8a5a2a);
          for (let i = 0; i < 3; i++) poly(g, [[8, 4 + i * 3], [16 + i * 2, 1 + i * 4], [9, 7 + i * 3]], css([0xd04a2a, 0x2a8ac8, 0xe0c040][i] as number), INK, 0.5);
          circle(g, 8, 2, 2.5, css(0xe8e0c8), INK, 0.6);
          break;
        case "basket":
          ellipse(g, 8, 22, 6, 4, ball(g, 8, 22, 6, 0xc8a060));
          circle(g, 6, 19, 1.8, css(0xd0305a), null);
          circle(g, 9.5, 18.5, 1.8, css(0xd0305a), null);
          break;
        case "trowel":
          handle(10);
          poly(g, [[5, 18], [11, 18], [8, 13]], css(0xb0b4bc));
          break;
        case "spyglass":
          poly(g, [[6, 28], [10, 28], [9, 10], [7, 10]], hgrad(g, 6, 10, 0xc8a050, 0x7a5a2a));
          break;
        default:
          break;
      }
    }),
  );
}

/** The weapon a unit holds when fighting (and heroes always). */
export function weaponFor(type: string): string {
  switch (type) {
    case "soldier":
    case "knight":
    case "skeleton":
      return "sword";
    case "miner":
      return "pick";
    case "ranger":
      return "bow";
    case "cleric":
      return "staff_orb";
    case "goblin":
      return "dagger";
    case "goblin_chief":
    case "ogre_warlord":
      return "greataxe";
    case "ogre":
      return "warhammer";
    case "lich":
      return "staff_skull";
    case "archer":
    case "scout":
      return "bow";
    case "hero_human":
      return "warhammer";
    case "hero_orc":
      return "greataxe";
    case "hero_dwarf":
      return "hammer";
    case "hero_high_elf":
      return "staff_orb";
    case "hero_dark_elf":
      return "dagger";
    case "hero_undead":
      return "staff_skull";
    case "hero_troll":
      return "staff_feather";
    case "woodcutter":
      return "axe";
    case "builder":
      return "hammer";
    default:
      return "dagger";
  }
}
