import type { Effect } from "./effects.ts";

/**
 * Race definitions: identity, colour and passive effects. Passives use the shared
 * effect system, so the simulation applies them exactly like research and talents.
 * Race-specific talents live in talents.ts (TalentDef.race).
 */
export interface RaceDef {
  id: string;
  name: string;
  theme: string;
  description: string;
  color: number;
  passives: Effect[];
  /** Design themes not yet backed by mechanics (shown honestly in the UI). */
  plannedPassives: string[];
}

export const RACES: readonly RaceDef[] = [
  {
    id: "human",
    name: "Human",
    theme: "Adaptability",
    description: "Balanced production and general economic bonuses.",
    color: 0x3d7fd6,
    passives: [
      { stat: "gather.wood", pct: 0.1 },
      { stat: "gather.stone", pct: 0.1 },
      { stat: "gather.gold", pct: 0.1 },
      { stat: "gather.food", pct: 0.1 },
      { stat: "buildingCost", pct: -0.1 },
    ],
    plannedPassives: [],
  },
  {
    id: "dark_elf",
    name: "Dark Elf",
    theme: "Shadowcraft",
    description: "Scouting, forest operations and swift movement.",
    color: 0x7b4fc9,
    passives: [
      { stat: "senseRadius", add: 6 },
      { stat: "moveSpeed", pct: 0.15 },
      { stat: "gather.wood", pct: 0.2 },
      { unlock: "ability:forest_stealth" },
    ],
    plannedPassives: [],
  },
  {
    id: "high_elf",
    name: "High Elf",
    theme: "Arcane mastery",
    description: "Research, discovery and efficient coordination.",
    color: 0x4fc9c0,
    passives: [
      { stat: "xpGain", pct: 0.2 },
      { stat: "researchTime", pct: -0.2 },
      { stat: "scriptOps", pct: 0.25 },
    ],
    plannedPassives: [],
  },
  {
    id: "orc",
    name: "Orc",
    theme: "Aggressive expansion",
    description: "Cheap, fast recruitment and wide frontier claims.",
    color: 0xc94f3d,
    passives: [
      { stat: "trainCost", pct: -0.2 },
      { stat: "trainTime", pct: -0.25 },
      { stat: "territoryRadius", add: 2 },
    ],
    plannedPassives: [],
  },
  {
    id: "dwarf",
    name: "Dwarf",
    theme: "Engineering",
    description: "Mining, construction and durable structures.",
    color: 0xd69a3d,
    passives: [
      { stat: "gather.stone", pct: 0.25 },
      { stat: "gather.gold", pct: 0.25 },
      { stat: "buildRate", pct: 0.25 },
      { stat: "buildingHp", pct: 0.3 },
    ],
    plannedPassives: [],
  },
  {
    id: "undead",
    name: "Undead",
    theme: "Reclamation",
    description: "Reclaiming resources from ruins and tireless, cheap labour.",
    color: 0x8fa38a,
    passives: [
      { stat: "salvage", pct: 0.5 },
      { stat: "gather.gold", pct: 0.2 },
      { stat: "trainCost", pct: -0.15 },
      { unlock: "ability:reuse_defeated" },
    ],
    plannedPassives: [],
  },
  {
    id: "troll",
    name: "Troll",
    theme: "Wilderness mastery",
    description: "Natural-resource gathering and exploration.",
    color: 0x3dc96a,
    passives: [
      { stat: "gather.food", pct: 0.25 },
      { stat: "gather.wood", pct: 0.15 },
      { stat: "senseRadius", add: 4 },
      { stat: "moveSpeed", pct: 0.1 },
      { stat: "regeneration", pct: 2 },
    ],
    plannedPassives: [],
  },
];

export function raceDef(id: string): RaceDef | undefined {
  return RACES.find((r) => r.id === id);
}
