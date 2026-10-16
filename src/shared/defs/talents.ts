import type { Effect } from "./effects.ts";

export const TALENT_CATEGORIES = ["economy", "gathering", "construction", "automation", "exploration", "logistics", "territory", "racial"] as const;
export type TalentCategory = (typeof TALENT_CATEGORIES)[number];

export interface TalentDef {
  id: string;
  name: string;
  description: string;
  category: TalentCategory;
  maxRank: number;
  /** Talent points per rank. */
  cost: number;
  /** Character level required before the first rank can be taken. */
  requiredLevel: number;
  prerequisites: { talent: string; rank: number }[];
  /** Effects applied once per rank. */
  effects: Effect[];
  /** Only this race may take the talent. */
  race?: string;
}

const T = (d: Omit<TalentDef, "cost" | "prerequisites"> & Partial<Pick<TalentDef, "cost" | "prerequisites">>): TalentDef => ({
  cost: 1,
  prerequisites: [],
  ...d,
});

export const TALENT_DEFS: Record<string, TalentDef> = Object.fromEntries(
  [
    // ---- economy
    T({ id: "thrift", name: "Thrift", description: "Buildings cost less.", category: "economy", maxRank: 3, requiredLevel: 2, effects: [{ stat: "buildingCost", pct: -0.04 }] }),
    T({ id: "bargaining", name: "Bargaining", description: "Units cost less to train.", category: "economy", maxRank: 3, requiredLevel: 10, prerequisites: [{ talent: "thrift", rank: 1 }], effects: [{ stat: "trainCost", pct: -0.05 }] }),
    // ---- gathering
    T({ id: "lumberjack", name: "Lumberjack", description: "Faster wood gathering.", category: "gathering", maxRank: 3, requiredLevel: 2, effects: [{ stat: "gather.wood", pct: 0.05 }] }),
    T({ id: "stonecutter", name: "Stonecutter", description: "Faster stone gathering.", category: "gathering", maxRank: 3, requiredLevel: 2, effects: [{ stat: "gather.stone", pct: 0.05 }] }),
    T({ id: "forager", name: "Forager", description: "Faster food gathering.", category: "gathering", maxRank: 3, requiredLevel: 2, effects: [{ stat: "gather.food", pct: 0.05 }] }),
    T({ id: "prospector", name: "Prospector", description: "Faster gold gathering.", category: "gathering", maxRank: 3, requiredLevel: 12, prerequisites: [{ talent: "stonecutter", rank: 2 }], effects: [{ stat: "gather.gold", pct: 0.06 }] }),
    // ---- construction
    T({ id: "master_builder", name: "Master Builder", description: "Construction is faster.", category: "construction", maxRank: 3, requiredLevel: 4, effects: [{ stat: "buildRate", pct: 0.08 }] }),
    T({ id: "fortification", name: "Fortification", description: "Sturdier buildings.", category: "construction", maxRank: 2, requiredLevel: 14, prerequisites: [{ talent: "master_builder", rank: 1 }], effects: [{ stat: "buildingHp", pct: 0.1 }] }),
    // ---- automation
    T({ id: "optimised_routines", name: "Optimised Routines", description: "Larger script instruction budget per unit.", category: "automation", maxRank: 3, requiredLevel: 4, effects: [{ stat: "scriptOps", pct: 0.1 }] }),
    T({ id: "scholarship", name: "Scholarship", description: "Research completes sooner.", category: "automation", maxRank: 2, requiredLevel: 16, prerequisites: [{ talent: "optimised_routines", rank: 1 }], effects: [{ stat: "researchTime", pct: -0.08 }] }),
    // ---- exploration
    T({ id: "keen_eyes", name: "Keen Eyes", description: "Units sense resources further away.", category: "exploration", maxRank: 3, requiredLevel: 2, effects: [{ stat: "senseRadius", add: 2 }] }),
    T({ id: "pathfinder", name: "Pathfinder", description: "Units move faster.", category: "exploration", maxRank: 3, requiredLevel: 8, prerequisites: [{ talent: "keen_eyes", rank: 1 }], effects: [{ stat: "moveSpeed", pct: 0.05 }] }),
    // ---- logistics
    T({ id: "pack_mules", name: "Pack Mules", description: "Units carry more.", category: "logistics", maxRank: 3, requiredLevel: 6, effects: [{ stat: "capacity", add: 2 }] }),
    T({ id: "supply_lines", name: "Supply Lines", description: "Units train faster.", category: "logistics", maxRank: 2, requiredLevel: 18, prerequisites: [{ talent: "pack_mules", rank: 2 }], effects: [{ stat: "trainTime", pct: -0.1 }] }),
    // ---- territory
    T({ id: "surveyor", name: "Surveyor", description: "Buildings claim a wider territory.", category: "territory", maxRank: 3, requiredLevel: 6, effects: [{ stat: "territoryRadius", add: 1 }] }),
    T({ id: "manifest_destiny", name: "Manifest Destiny", description: "A large boost to territorial claims.", category: "territory", maxRank: 1, cost: 2, requiredLevel: 30, prerequisites: [{ talent: "surveyor", rank: 3 }], effects: [{ stat: "territoryRadius", add: 2 }] }),
    // ---- racial
    T({ id: "jack_of_all_trades", name: "Jack of All Trades", description: "Every kind of gathering improves.", category: "racial", race: "human", maxRank: 3, requiredLevel: 10, effects: [{ stat: "gather.wood", pct: 0.03 }, { stat: "gather.stone", pct: 0.03 }, { stat: "gather.gold", pct: 0.03 }, { stat: "gather.food", pct: 0.03 }] }),
    T({ id: "civic_spirit", name: "Civic Spirit", description: "Much cheaper buildings.", category: "racial", race: "human", maxRank: 1, requiredLevel: 24, prerequisites: [{ talent: "jack_of_all_trades", rank: 2 }], effects: [{ stat: "buildingCost", pct: -0.1 }] }),
    T({ id: "shadowstep", name: "Shadowstep", description: "Units move faster.", category: "racial", race: "dark_elf", maxRank: 3, requiredLevel: 10, effects: [{ stat: "moveSpeed", pct: 0.06 }] }),
    T({ id: "night_vision", name: "Night Vision", description: "Units sense much further.", category: "racial", race: "dark_elf", maxRank: 2, requiredLevel: 20, prerequisites: [{ talent: "shadowstep", rank: 1 }], effects: [{ stat: "senseRadius", add: 3 }] }),
    T({ id: "arcane_insight", name: "Arcane Insight", description: "More experience from everything.", category: "racial", race: "high_elf", maxRank: 3, requiredLevel: 10, effects: [{ stat: "xpGain", pct: 0.1 }] }),
    T({ id: "spellwoven_code", name: "Spellwoven Code", description: "Larger script budgets.", category: "racial", race: "high_elf", maxRank: 2, requiredLevel: 20, prerequisites: [{ talent: "arcane_insight", rank: 1 }], effects: [{ stat: "scriptOps", pct: 0.15 }] }),
    T({ id: "warband", name: "Warband", description: "Faster unit training.", category: "racial", race: "orc", maxRank: 3, requiredLevel: 10, effects: [{ stat: "trainTime", pct: -0.08 }] }),
    T({ id: "conquest", name: "Conquest", description: "Wider territorial claims.", category: "racial", race: "orc", maxRank: 3, requiredLevel: 20, prerequisites: [{ talent: "warband", rank: 1 }], effects: [{ stat: "territoryRadius", add: 1 }] }),
    T({ id: "deep_delving", name: "Deep Delving", description: "Faster stone and gold mining.", category: "racial", race: "dwarf", maxRank: 3, requiredLevel: 10, effects: [{ stat: "gather.stone", pct: 0.08 }, { stat: "gather.gold", pct: 0.08 }] }),
    T({ id: "stonewright", name: "Stonewright", description: "Faster, sturdier construction.", category: "racial", race: "dwarf", maxRank: 2, requiredLevel: 20, prerequisites: [{ talent: "deep_delving", rank: 1 }], effects: [{ stat: "buildRate", pct: 0.1 }, { stat: "buildingHp", pct: 0.1 }] }),
    T({ id: "grave_robbing", name: "Grave Robbing", description: "More salvage from ruins.", category: "racial", race: "undead", maxRank: 3, requiredLevel: 10, effects: [{ stat: "salvage", pct: 0.2 }] }),
    T({ id: "tireless", name: "Tireless", description: "Units move faster and carry more.", category: "racial", race: "undead", maxRank: 3, requiredLevel: 20, prerequisites: [{ talent: "grave_robbing", rank: 1 }], effects: [{ stat: "moveSpeed", pct: 0.05 }, { stat: "capacity", add: 1 }] }),
    T({ id: "bountiful", name: "Bountiful", description: "Faster food gathering.", category: "racial", race: "troll", maxRank: 3, requiredLevel: 10, effects: [{ stat: "gather.food", pct: 0.08 }] }),
    T({ id: "wildwalker", name: "Wildwalker", description: "Units see further and move faster.", category: "racial", race: "troll", maxRank: 3, requiredLevel: 20, prerequisites: [{ talent: "bountiful", rank: 1 }], effects: [{ stat: "senseRadius", add: 2 }, { stat: "moveSpeed", pct: 0.04 }] }),
  ].map((t) => [t.id, t]),
);

export function findTalentDef(id: string): TalentDef | undefined {
  return Object.hasOwn(TALENT_DEFS, id) ? TALENT_DEFS[id] : undefined;
}
