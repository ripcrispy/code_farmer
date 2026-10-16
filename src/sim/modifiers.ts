import { STATS, type Effect, type StatKey } from "../shared/defs/effects.ts";

/**
 * Aggregated effects for one player. Sources (research, race, talents) are combined by
 * World.mods(); simulation code asks for final values here and never inspects sources.
 */
export class Modifiers {
  readonly pct = {} as Record<StatKey, number>;
  readonly add = {} as Record<StatKey, number>;
  readonly unlocks = new Set<string>();

  constructor() {
    for (const s of STATS) {
      this.pct[s] = 0;
      this.add[s] = 0;
    }
  }

  apply(effects: readonly Effect[], ranks = 1): void {
    for (const e of effects) {
      if ("unlock" in e) this.unlocks.add(e.unlock);
      else if ("pct" in e) this.pct[e.stat] += e.pct * ranks;
      else this.add[e.stat] += e.add * ranks;
    }
  }

  /** Final value for a stat with a base value. Multipliers never drop below 20% of base. */
  value(stat: StatKey, base: number): number {
    return (base + this.add[stat]) * Math.max(0.2, 1 + this.pct[stat]);
  }

  /** Multiplier only (for stats without a meaningful base, such as costs). */
  factor(stat: StatKey): number {
    return Math.max(0.2, 1 + this.pct[stat]);
  }

  has(unlock: string): boolean {
    return this.unlocks.has(unlock);
  }

  /** Non-zero entries, for display. */
  summary(): { stat: StatKey; pct: number; add: number }[] {
    return STATS.filter((s) => this.pct[s] !== 0 || this.add[s] !== 0).map((s) => ({ stat: s, pct: this.pct[s], add: this.add[s] }));
  }
}

export const NO_MODIFIERS = new Modifiers();
