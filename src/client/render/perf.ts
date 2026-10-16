/**
 * Client frame profiler for the performance overlay (F3). Keeps smoothed timings per
 * renderer section, the render itself and the whole frame, plus a count of slow frames
 * (the "stutters") over the last few seconds. Costs a few performance.now() calls a frame.
 */
export interface PerfCounts {
  /** Unit sprites drawn this frame / units the client knows about. */
  units: number;
  unitsKnown: number;
  buildings: number;
  nodes: number;
  /** Children of the depth-sorted object layer. */
  objects: number;
  chunks: number;
  paintQueue: number;
}

export interface PerfSnapshot {
  fps: number;
  /** Average ms per frame spent in each part (smoothed), and the worst in the window. */
  sections: [string, number, number][];
  render: number;
  renderPeak: number;
  /** Renderer update + Pixi render, ms (smoothed). */
  total: number;
  /** Worst frame interval in the window, ms. */
  worst: number;
  /** Frames slower than 50 ms in the last 5 seconds. */
  slow: number;
  /** Main-thread tasks over 50 ms in the last 5 seconds (null: not measurable here), and the longest. */
  longTasks: number | null;
  longestTask: number;
  counts: PerfCounts;
}

const SMOOTH = 0.1;
const WINDOW_MS = 5000;
export const SLOW_FRAME_MS = 50;

export class PerfStats {
  private sections = new Map<string, number>();
  private frameAcc = new Map<string, number>();
  private render = 0;
  private total = 0;
  private fps = 0;
  /** [time, interval, section times] of recent frames. */
  private recent: [number, number, Map<string, number>][] = [];
  private counts: PerfCounts = { units: 0, unitsKnown: 0, buildings: 0, nodes: 0, objects: 0, chunks: 0, paintQueue: 0 };
  frameStart = 0;
  private updateEnd = 0;
  /** [time, duration] of main-thread tasks over 50 ms (any cause: rendering, messages, React, GC). */
  private longTasks: [number, number][] = [];
  private observer: PerformanceObserver | null = null;

  constructor() {
    try {
      if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        this.observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) this.longTasks.push([e.startTime, e.duration]);
        });
        this.observer.observe({ type: "longtask", buffered: false });
      }
    } catch {
      this.observer = null; // Long-task timing is optional (not every browser has it).
    }
  }

  dispose(): void {
    this.observer?.disconnect();
  }

  add(name: string, ms: number): void {
    this.frameAcc.set(name, (this.frameAcc.get(name) ?? 0) + ms);
    this.updateEnd = performance.now();
  }

  endFrame(now: number, frameStart: number, intervalMs: number, counts: PerfCounts): void {
    for (const [k, v] of this.frameAcc) this.sections.set(k, (this.sections.get(k) ?? v) * (1 - SMOOTH) + v * SMOOTH);
    const frame = this.frameAcc;
    this.frameAcc = new Map();
    const render = Math.max(0, now - this.updateEnd);
    this.render = this.render * (1 - SMOOTH) + render * SMOOTH;
    this.total = this.total * (1 - SMOOTH) + (now - frameStart) * SMOOTH;
    if (intervalMs > 0) this.fps = this.fps * (1 - SMOOTH) + (1000 / intervalMs) * SMOOTH;
    frame.set("render", render);
    this.recent.push([now, intervalMs, frame]);
    while (this.recent.length && (this.recent[0] as [number, number, unknown])[0] < now - WINDOW_MS) this.recent.shift();
    this.counts = counts;
  }

  snapshot(): PerfSnapshot {
    let worst = 0;
    let slow = 0;
    const peak = new Map<string, number>();
    for (const [, d, f] of this.recent) {
      worst = Math.max(worst, d);
      if (d > SLOW_FRAME_MS) slow++;
      for (const [k, v] of f) peak.set(k, Math.max(peak.get(k) ?? 0, v));
    }
    const cutoff = performance.now() - WINDOW_MS;
    this.longTasks = this.longTasks.filter(([t]) => t >= cutoff);
    const longestTask = this.longTasks.reduce((m, [, d]) => Math.max(m, d), 0);
    return { longTasks: this.observer ? this.longTasks.length : null, longestTask, fps: this.fps, sections: [...this.sections].map(([k, v]) => [k, v, peak.get(k) ?? 0]), render: this.render, renderPeak: peak.get("render") ?? 0, total: this.total, worst, slow, counts: { ...this.counts } };
  }
}
