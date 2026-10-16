/**
 * Deterministic hashing and pseudo-random helpers.
 *
 * Everything here uses 32-bit integer arithmetic (Math.imul, shifts) and plain
 * IEEE-754 +,-,*,/ so results are identical on every JavaScript engine and
 * platform. Never use Math.random() or transcendental functions (sin, exp, ...)
 * in world generation: their results are not guaranteed to be bit-identical
 * across engines.
 */

/** FNV-1a hash of a string, followed by an avalanche mix. Returns uint32. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/** Murmur3 finaliser. Input/output are uint32. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of (seed, x, y, salt). Order-sensitive, works for negative coordinates. */
export function hash3(seed: number, x: number, y: number, salt: number): number {
  let h = mix32((seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0);
  h = mix32((h + Math.imul(x | 0, 0x27d4eb2d)) >>> 0);
  h = mix32((h + Math.imul(y | 0, 0x165667b1)) >>> 0);
  return h;
}

/** Uniform float in [0, 1) from (seed, x, y, salt). */
export function rand01(seed: number, x: number, y: number, salt: number): number {
  return hash3(seed, x, y, salt) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 2D value noise at the given lattice scale (in tiles). Returns [0, 1).
 * Floor division is done explicitly so negative coordinates are handled
 * consistently (no seam at the origin).
 */
export function valueNoise(seed: number, x: number, y: number, scale: number, salt: number): number {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  const fx = smooth((x - gx * scale) / scale);
  const fy = smooth((y - gy * scale) / scale);
  const a = rand01(seed, gx, gy, salt);
  const b = rand01(seed, gx + 1, gy, salt);
  const c = rand01(seed, gx, gy + 1, salt);
  const d = rand01(seed, gx + 1, gy + 1, salt);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

/** Fractal (fBm) value noise normalised to [0, 1). */
export function fbm(seed: number, x: number, y: number, scale: number, octaves: number, salt: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let s = scale;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(seed, x, y, s, salt + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    s = s / 2;
    if (s < 1) s = 1;
  }
  return sum / norm;
}

/** Small deterministic sequential PRNG (mulberry32) for non-world uses such as spawn search. */
export class SeededRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}
