/**
 * Character progression: experience curve, level cap and talent points.
 * Level and talent points are derived from total experience, never stored or
 * accepted from clients, so repeated requests cannot award extra points.
 */
export const MAX_LEVEL = 60;

/** Experience needed to advance from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return Math.round(100 * Math.pow(level, 1.6));
}

/** Cumulative experience at which each level starts (index = level; [1] = 0). */
export const LEVEL_THRESHOLDS: readonly number[] = (() => {
  const t = [0, 0];
  for (let l = 1; l < MAX_LEVEL; l++) t.push((t[l] as number) + xpForLevel(l));
  return t;
})();

/** Experience at which the level cap is reached; experience is capped here. */
export const MAX_XP = LEVEL_THRESHOLDS[MAX_LEVEL] as number;

export function levelForXp(xp: number): number {
  let lo = 1;
  let hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp >= (LEVEL_THRESHOLDS[mid] as number)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One talent point at every even level from 2 to 60 (30 at the cap). */
export function talentPointsForLevel(level: number): number {
  return Math.floor(Math.min(level, MAX_LEVEL) / 2);
}

/** Experience awards (before the player's experience modifier). */
export const XP_AWARDS = {
  /** Per unit of resource gathered from a world node (farm output gives none). */
  perResourceGathered: 0.5,
  /** Fraction of a building's base resource cost awarded when it is completed. */
  constructionFraction: 0.5,
  /** Each chunk your units enter for the first time. */
  perChunkExplored: 25,
  /** Per tile of territory newly claimed. */
  perTerritoryTile: 0.2,
  /** Fraction of a technology's resource cost awarded when research completes. */
  researchFraction: 0.5,
  /** Gold per allocated talent point to reset talents. */
  respecGoldPerPoint: 20,
  /** Each new discovery (code fragment or hidden discovery). */
  perDiscovery: 100,
  /** Observing a species for the first time. */
  perObservation: 40,
  /** Investigating a ruin (once per ruin per player is not tracked: salvage is once per world). */
  perInvestigation: 30,
  perTame: 80,
  perTraining: 50,
  /** Hunting a wild creature (combat). Creatures never respawn, so this cannot be farmed. */
  perHunt: 15,
  /**
   * Fraction of a defeated unit's training cost (PvP). Starting units cost nothing and give
   * nothing, so a friend's re-founded settlement cannot be farmed.
   */
  killCostFraction: 0.25,
  /** Fraction of a destroyed building's cost (PvP). Town Halls (granted free on re-founding) give nothing. */
  destroyCostFraction: 0.1,
} as const;
