import type { ResourceBag } from "./resources.ts";

/**
 * Global balance and rule constants. Tune here; simulation code reads these values
 * instead of embedding numbers. See docs/GAME_DESIGN.md for the rationale.
 */
export const BALANCE = {
  startingResources: { wood: 50, stone: 0, gold: 0, food: 50 } satisfies ResourceBag,
  /** Expansion buildings (Outpost, Town Hall) may be placed this many tiles beyond your territory. */
  expansionRange: 24,
  /** Units per player before research (Administration and its successors raise it). */
  maxUnitsPerPlayer: 60,
  /** Buildings per player before research. */
  maxBuildingsPerPlayer: 80,
  /** Storage buildings within this many tiles of each other form one storage network. */
  storageLinkRange: 24,
  /** Costs are paid from the storage network nearest the site or building, within this many tiles. */
  supplyRange: 48,
  /** Share of a destroyed storage building's contents the attacker carries off. */
  plunderFraction: 0.25,
  /** Max queued training orders per building. */
  maxTrainQueue: 5,
  /** Minimum distance between two players' spawn town halls. */
  spawnSeparation: 40,
  /** Distance range for explore() legs. */
  exploreMin: 8,
  exploreMax: 16,
  /** Max seconds for wait(). */
  maxWaitSeconds: 60,
  /** Extra gathering speed inside contested zones (rich land is the reason to fight over them). */
  contestedGatherBonus: 0.5,
} as const;
