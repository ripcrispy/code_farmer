import { TEX, paintGround, type PaintSource } from "./terrainPainter.ts";

/**
 * Ground painting as self-contained jobs, so it can run in a Web Worker instead of
 * stalling the main thread (painting a whole chunk takes tens of milliseconds).
 *
 * A job carries the terrain and node kinds of the painted tiles plus a one-tile
 * border (the painter blends with neighbours), so the worker needs no game state.
 */
export interface GroundJob {
  id: number;
  /** Chunk the result is drawn into. */
  key: string;
  /** Painted tiles [tx0, tx1) x [ty0, ty1). */
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  /** Terrain codes of [tx0-1, tx1+1) x [ty0-1, ty1+1), row by row; -1 = unknown. */
  terrain: Int8Array;
  /** Node marks for the same area: 0 none, 1 tree, 2 stone or gold, 3 berries. */
  nodes: Uint8Array;
}

export interface GroundResult {
  id: number;
  key: string;
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  /** RGBA, (tx1 - tx0) * TEX pixels wide. */
  pixels: Uint8ClampedArray;
}

const NODE_CODE: Record<string, number> = { tree: 1, stone: 2, gold: 2, berries: 3 };
const NODE_KIND = ["", "tree", "stone", "berries"];

export function makeJob(id: number, key: string, tx0: number, ty0: number, tx1: number, ty1: number, src: PaintSource): GroundJob {
  const gw = tx1 - tx0 + 2;
  const gh = ty1 - ty0 + 2;
  const terrain = new Int8Array(gw * gh);
  const nodes = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x = tx0 - 1 + i;
      const y = ty0 - 1 + j;
      terrain[j * gw + i] = src.terrain(x, y) ?? -1;
      const n = src.node(x, y);
      nodes[j * gw + i] = n ? (NODE_CODE[n.kind] ?? 0) : 0;
    }
  }
  return { id, key, tx0, ty0, tx1, ty1, terrain, nodes };
}

/** Paint a job (in a worker, or on the main thread when workers are unavailable). */
export function runJob(job: GroundJob): GroundResult {
  const { tx0, ty0, tx1, ty1 } = job;
  const gw = tx1 - tx0 + 2;
  const gh = ty1 - ty0 + 2;
  const at = (x: number, y: number): number => {
    const i = x - tx0 + 1;
    const j = y - ty0 + 1;
    return i < 0 || j < 0 || i >= gw || j >= gh ? -1 : j * gw + i;
  };
  const src: PaintSource = {
    terrain: (x, y) => {
      const k = at(x, y);
      const t = k < 0 ? -1 : (job.terrain[k] as number);
      return t < 0 ? undefined : t;
    },
    node: (x, y) => {
      const k = at(x, y);
      const n = k < 0 ? 0 : (job.nodes[k] as number);
      return n ? { kind: NODE_KIND[n] as string, amount: 1 } : undefined;
    },
  };
  const width = (tx1 - tx0) * TEX;
  const pixels = new Uint8ClampedArray(width * (ty1 - ty0) * TEX * 4);
  paintGround({ data: pixels, width }, tx0, ty0, tx0, ty0, tx1, ty1, src);
  return { id: job.id, key: job.key, tx0, ty0, tx1, ty1, pixels };
}

/**
 * A small pool of painting workers. Jobs for the same chunk always go to the same
 * worker, so their results arrive in the order they were requested.
 */
export class GroundPainter {
  private workers: Worker[] = [];
  private readonly onResult: (r: GroundResult) => void;
  private nextId = 1;
  private inflight = 0;
  /** Painted synchronously because workers could not be started. */
  readonly fallback: boolean;

  constructor(onResult: (r: GroundResult) => void) {
    this.onResult = onResult;
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL("./groundWorker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<GroundResult>) => {
          this.inflight--;
          this.onResult(e.data);
        };
        w.onerror = (e) => {
          // A failed worker is reported, not hidden; painting continues on the main thread.
          console.error("Ground painting worker failed:", e.message);
          this.disable();
        };
        this.workers.push(w);
      }
    } catch (e) {
      console.warn("Ground painting workers unavailable, painting on the main thread:", e);
      this.disable();
    }
    this.fallback = this.workers.length === 0;
  }

  private disable(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.inflight = 0;
  }

  /** Jobs sent and not yet returned. */
  get pending(): number {
    return this.inflight;
  }

  /** Can take more work without building a long backlog. */
  get ready(): boolean {
    return this.workers.length === 0 || this.inflight < this.workers.length * 2;
  }

  paint(key: string, tx0: number, ty0: number, tx1: number, ty1: number, src: PaintSource): void {
    const job = makeJob(this.nextId++, key, tx0, ty0, tx1, ty1, src);
    if (this.workers.length === 0) {
      this.onResult(runJob(job));
      return;
    }
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const w = this.workers[Math.abs(h) % this.workers.length] as Worker;
    this.inflight++;
    w.postMessage(job, [job.terrain.buffer, job.nodes.buffer]);
  }

  destroy(): void {
    this.disable();
  }
}
