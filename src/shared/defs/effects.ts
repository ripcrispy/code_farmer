/**
 * Data-driven gameplay effects. Research, racial passives and talents all express
 * their gameplay changes as Effects; the simulation reads aggregated values through
 * the Modifiers helper (src/sim/modifiers.ts) instead of checking where a bonus came from.
 *
 * Percentage effects ("pct") add up within a stat: two +10% bonuses give +20%.
 * Flat effects ("add") are added to the base before percentages apply.
 */

export const STATS = [
  "gather.wood",
  "gather.stone",
  "gather.gold",
  "gather.food",
  "moveSpeed",
  "capacity",
  "buildRate",
  "senseRadius",
  "trainTime",
  "trainCost",
  "buildingCost",
  "buildingHp",
  "production",
  "territoryRadius",
  "scriptOps",
  "xpGain",
  "salvage",
  "researchTime",
  "regeneration",
  "unitCap",
  "buildingCap",
  "storageCapacity",
  "damage",
  "armor",
  "heroHp",
  "heroDamage",
  "heroCooldown",
  "heroAura",
  "heroRevive",
] as const;
export type StatKey = (typeof STATS)[number];

export const STAT_LABELS: Record<StatKey, string> = {
  "gather.wood": "wood gathering",
  "gather.stone": "stone gathering",
  "gather.gold": "gold gathering",
  "gather.food": "food gathering",
  moveSpeed: "unit movement speed",
  capacity: "unit carrying capacity",
  buildRate: "construction speed",
  senseRadius: "unit sensing radius",
  trainTime: "unit training time",
  trainCost: "unit training cost",
  buildingCost: "building cost",
  buildingHp: "building health",
  production: "farm production",
  territoryRadius: "territory radius",
  scriptOps: "script instruction budget",
  xpGain: "experience gained",
  salvage: "salvage from ruins",
  researchTime: "research time",
  regeneration: "health regeneration",
  unitCap: "unit limit",
  buildingCap: "building limit",
  storageCapacity: "storage capacity",
  damage: "attack damage",
  armor: "armor (damage reduction)",
  heroHp: "hero health",
  heroDamage: "hero damage",
  heroCooldown: "hero ability cooldowns",
  heroAura: "hero aura and ability radius",
  heroRevive: "hero revival cost and time",
};

/** Readable names for ability unlocks ("ability:<id>"). */
export const ABILITY_LABELS: Record<string, string> = {
  forest_stealth: "your units are hidden from other players while in forest",
  reuse_defeated: "defeated enemy units yield part of their cost as resources",
};

export type Effect =
  | { stat: StatKey; pct: number }
  | { stat: StatKey; add: number }
  /** Unlocks a capability, e.g. "building:town_hall" or "command:scan". */
  | { unlock: string };

export function isStatKey(s: unknown): s is StatKey {
  return typeof s === "string" && (STATS as readonly string[]).includes(s);
}

/** Human-readable one-line description of an effect, e.g. "+20% wood gathering". */
export function describeEffect(e: Effect): string {
  if ("unlock" in e) {
    const [kind, id] = e.unlock.split(":");
    if (kind === "ability" && id && Object.hasOwn(ABILITY_LABELS, id)) return `Ability: ${ABILITY_LABELS[id]}`;
    return `Unlocks ${kind} ${id?.replace(/_/g, " ")}`;
  }
  const label = STAT_LABELS[e.stat];
  if ("pct" in e) return `${e.pct > 0 ? "+" : ""}${Math.round(e.pct * 100)}% ${label}`;
  return `${e.add > 0 ? "+" : ""}${e.add} ${label}`;
}
