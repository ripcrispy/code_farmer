/**
 * Rolling per-phase timings of simulation ticks (for /admin/status): the mean and the
 * worst of the last WINDOW ticks, so occasional slow ticks are visible, not averaged away.
 */
const WINDOW = 300;

export class PhaseTimes {
  private current = new Map<string, number>();
  private history: Map<string, number>[] = [];

  add(name: string, ms: number): void {
    this.current.set(name, (this.current.get(name) ?? 0) + ms);
  }

  endTick(): void {
    this.history.push(this.current);
    if (this.history.length > WINDOW) this.history.shift();
    this.current = new Map();
  }

  /** name -> { mean, max, p99 } in ms, over the window. */
  summary(): Record<string, { mean: number; p99: number; max: number }> {
    const names = new Set<string>();
    for (const h of this.history) for (const k of h.keys()) names.add(k);
    const out: Record<string, { mean: number; p99: number; max: number }> = {};
    for (const k of names) {
      const v = this.history.map((h) => h.get(k) ?? 0).sort((a, b) => a - b);
      const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
      const r = (x: number): number => Math.round(x * 100) / 100;
      out[k] = { mean: r(mean), p99: r(v[Math.min(v.length - 1, Math.floor(v.length * 0.99))] ?? 0), max: r(v[v.length - 1] ?? 0) };
    }
    return out;
  }
}
