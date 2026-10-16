import type { Effect } from "./effects.ts";
import type { ResourceBag } from "./resources.ts";

/** Technologies researched at a Library. Effects apply to the whole civilisation once complete. */
export interface TechDef {
  id: string;
  name: string;
  description: string;
  cost: Partial<ResourceBag>;
  /** Research time in seconds (before modifiers). */
  time: number;
  requires: string[];
  effects: Effect[];
}

export const TECH_DEFS: Record<string, TechDef> = {
  sharpened_axes: {
    id: "sharpened_axes",
    name: "Sharpened Axes",
    description: "Better tools for felling trees.",
    cost: { wood: 60, stone: 20 },
    time: 40,
    requires: [],
    effects: [{ stat: "gather.wood", pct: 0.2 }],
  },
  masonry: {
    id: "masonry",
    name: "Masonry",
    description: "Quarrying techniques and sturdier walls.",
    cost: { wood: 60, stone: 40 },
    time: 45,
    requires: [],
    effects: [{ stat: "gather.stone", pct: 0.2 }, { stat: "buildingHp", pct: 0.15 }],
  },
  prospecting: {
    id: "prospecting",
    name: "Prospecting",
    description: "Follow the veins.",
    cost: { wood: 80, stone: 40, gold: 10 },
    time: 50,
    requires: ["masonry"],
    effects: [{ stat: "gather.gold", pct: 0.25 }],
  },
  crop_rotation: {
    id: "crop_rotation",
    name: "Crop Rotation",
    description: "Farms produce more food.",
    cost: { wood: 80, food: 40 },
    time: 45,
    requires: [],
    effects: [{ stat: "production", pct: 0.3 }, { stat: "gather.food", pct: 0.1 }],
  },
  ox_carts: {
    id: "ox_carts",
    name: "Ox Carts",
    description: "Units carry more on every trip.",
    cost: { wood: 100, food: 40 },
    time: 50,
    requires: [],
    effects: [{ stat: "capacity", add: 4 }],
  },
  surveying: {
    id: "surveying",
    name: "Surveying",
    description: "Units see further and buildings claim more land.",
    cost: { wood: 60, stone: 30 },
    time: 40,
    requires: [],
    effects: [{ stat: "senseRadius", add: 4 }, { stat: "territoryRadius", add: 2 }],
  },
  civic_planning: {
    id: "civic_planning",
    name: "Civic Planning",
    description: "Allows founding new settlements with additional Town Halls.",
    cost: { wood: 150, stone: 100, gold: 30 },
    time: 60,
    requires: ["surveying"],
    effects: [{ unlock: "building:town_hall" }],
  },
  efficient_scripts: {
    id: "efficient_scripts",
    name: "Efficient Scripts",
    description: "Your units' programs get a larger instruction budget each tick.",
    cost: { wood: 50, gold: 40 },
    time: 40,
    requires: [],
    effects: [{ stat: "scriptOps", pct: 0.25 }],
  },
  warehousing: {
    id: "warehousing",
    name: "Warehousing",
    description: "Shelving, sacks and order: every storage building holds more.",
    cost: { wood: 120, stone: 60 },
    time: 50,
    requires: [],
    effects: [{ stat: "storageCapacity", pct: 0.5 }],
  },
  administration: {
    id: "administration",
    name: "Administration",
    description: "Clerks and records let you run a larger civilisation.",
    cost: { wood: 200, stone: 150, gold: 50 },
    time: 60,
    requires: [],
    effects: [
      { stat: "unitCap", add: 30 },
      { stat: "buildingCap", add: 40 },
    ],
  },
  bureaucracy: {
    id: "bureaucracy",
    name: "Bureaucracy",
    description: "Departments, ledgers and deputies for a growing realm.",
    cost: { wood: 400, stone: 300, gold: 150 },
    time: 90,
    requires: ["administration"],
    effects: [
      { stat: "unitCap", add: 40 },
      { stat: "buildingCap", add: 60 },
    ],
  },
  grand_council: {
    id: "grand_council",
    name: "Grand Council",
    description: "A council of governors to run a sprawling civilisation.",
    cost: { wood: 800, stone: 600, gold: 400 },
    time: 120,
    requires: ["bureaucracy"],
    effects: [
      { stat: "unitCap", add: 50 },
      { stat: "buildingCap", add: 80 },
    ],
  },
  heroic_legends: {
    id: "heroic_legends",
    name: "Heroic Legends",
    description: "Songs of your hero's deeds make them stronger.",
    cost: { wood: 150, stone: 100, gold: 60 },
    time: 60,
    requires: [],
    effects: [
      { stat: "heroHp", pct: 0.2 },
      { stat: "heroDamage", pct: 0.2 },
    ],
  },
  arcane_channeling: {
    id: "arcane_channeling",
    name: "Arcane Channeling",
    description: "Your hero's abilities recover faster.",
    cost: { wood: 100, gold: 80 },
    time: 60,
    requires: [],
    effects: [{ stat: "heroCooldown", pct: -0.2 }],
  },
  far_reaching_auras: {
    id: "far_reaching_auras",
    name: "Far-Reaching Auras",
    description: "Your hero's aura and abilities reach further.",
    cost: { wood: 120, stone: 80, gold: 40 },
    time: 60,
    requires: ["heroic_legends"],
    effects: [{ stat: "heroAura", pct: 0.5 }],
  },
  rites_of_return: {
    id: "rites_of_return",
    name: "Rites of Return",
    description: "A fallen hero returns sooner and for less.",
    cost: { wood: 100, stone: 60, gold: 50 },
    time: 50,
    requires: [],
    effects: [{ stat: "heroRevive", pct: -0.4 }],
  },
};

export function findTechDef(id: string): TechDef | undefined {
  return Object.hasOwn(TECH_DEFS, id) ? TECH_DEFS[id] : undefined;
}
