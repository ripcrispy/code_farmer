import type { Effect } from "./effects.ts";

/**
 * Discoveries: knowledge players gain through exploration, observation and training.
 * Every discovery grants real effects through the shared effect system (unlocked
 * commands, buildings or stat bonuses); none is a mere collectible.
 *
 * Inspection tiers (project specification, section 10):
 *  1. visible  - public stats and capabilities (shared unit/creature definitions)
 *  2. observed - a species' behaviour program, after a unit observes one (per player)
 *  3. trainable - taming and training, which require the species to be observed
 *  4. hidden   - discoveries below, found only under specific conditions
 */
export interface DiscoveryDef {
  id: string;
  name: string;
  description: string;
  /** How it is found (shown once known). */
  source: string;
  tier: "fragment" | "hidden";
  effects: Effect[];
}

export const DISCOVERY_DEFS: Record<string, DiscoveryDef> = {
  surveyors_lens: {
    id: "surveyors_lens",
    name: "Surveyor's Lens",
    description: "An inscription describing how to survey surroundings at a glance.",
    source: "Investigating ruins",
    tier: "fragment",
    effects: [{ unlock: "command:scan" }],
  },
  watchtower_blueprint: {
    id: "watchtower_blueprint",
    name: "Watchtower Blueprint",
    description: "Plans for a tall tower that watches over distant land.",
    source: "Investigating ancient ruins",
    tier: "hidden",
    effects: [{ unlock: "building:watchtower" }],
  },
  foragers_instinct: {
    id: "foragers_instinct",
    name: "Forager's Instinct",
    description: "Watching a wild boar root for berries teaches your people where the best fruit hides.",
    source: "Observing a wild boar while it forages",
    tier: "hidden",
    effects: [{ stat: "gather.food", pct: 0.1 }],
  },
  war_drums: {
    id: "war_drums",
    name: "Goblin War Drums",
    description: "The rhythm the goblins fought to. Your fighters keep it: +5% damage.",
    source: "Defeating a Goblin Chief",
    tier: "hidden",
    effects: [{ stat: "damage", pct: 0.05 }],
  },
  silk_rigging: {
    id: "silk_rigging",
    name: "Silk Rigging",
    description: "Spider silk nets and hoists let your stores hold more: +10% storage capacity.",
    source: "Defeating a Spider Queen",
    tier: "hidden",
    effects: [{ stat: "storageCapacity", pct: 0.1 }],
  },
  necromantic_grimoire: {
    id: "necromantic_grimoire",
    name: "Necromantic Grimoire",
    description: "The lich's notes, mostly on how to study faster: -10% research time.",
    source: "Defeating a Lich",
    tier: "hidden",
    effects: [{ stat: "researchTime", pct: -0.1 }],
  },
  ogre_masonry: {
    id: "ogre_masonry",
    name: "Ogre Masonry",
    description: "Crude but clever: how ogres pile stone without mortar. -10% building cost.",
    source: "Defeating an Ogre Warlord",
    tier: "hidden",
    effects: [{ stat: "buildingCost", pct: -0.1 }],
  },
  dragonfire_lore: {
    id: "dragonfire_lore",
    name: "Dragonfire Lore",
    description: "Where a drake's fire splits the rock, gold shows: +10% gold gathering.",
    source: "Defeating an Ancient Drake",
    tier: "hidden",
    effects: [{ stat: "gather.gold", pct: 0.1 }],
  },
  pack_discipline: {
    id: "pack_discipline",
    name: "Pack Discipline",
    description: "Training a wolf to guard teaches lessons in watchfulness.",
    source: "Training a wolf to guard",
    tier: "fragment",
    effects: [{ stat: "senseRadius", add: 2 }],
  },
};

export function findDiscoveryDef(id: string): DiscoveryDef | undefined {
  return Object.hasOwn(DISCOVERY_DEFS, id) ? DISCOVERY_DEFS[id] : undefined;
}

/** Ruin contents. Every ruin can be read by every player (knowledge is not consumed); salvage is taken once per world. */
export const RUIN_LOOT = {
  common: { fragment: "surveyors_lens", salvage: { stone: 40, gold: 15 }, seconds: 12 },
  ancient: { fragment: "watchtower_blueprint", salvage: { stone: 80, gold: 40 }, seconds: 20 },
} as const;
