import type { Effect } from "./effects.ts";
import type { ResourceBag } from "./resources.ts";

/**
 * PvE lairs: monster camps placed across the world (generation v3+, see shared/lairs.ts).
 * A lair's monsters stay in and around it and attack anyone who comes in. Killing them
 * gives resources and experience; killing the boss also gives the lair's boss loot, a
 * trophy (a permanent bonus, once per boss kind) and a discovery. When every monster is
 * dead the lair is cleared: for a while only the player who cleared it may build there,
 * even far from their territory (an Outpost claims it). A cleared lair that nobody claims
 * is reoccupied after `respawnMinutes`.
 */
export interface TrophyDef {
  id: string;
  name: string;
  description: string;
  effects: Effect[];
}

export interface LairDef {
  kind: string;
  name: string;
  description: string;
  /** 1 (easy) to 4 (very hard). */
  tier: number;
  /** Radius in tiles of the lair's area (monsters attack intruders inside it). */
  radius: number;
  pack: { type: string; count: number }[];
  boss: string;
  bossLoot: Partial<ResourceBag>;
  /** Experience for clearing the lair (in addition to each kill). */
  clearXp: number;
  trophy: TrophyDef;
  /** Discovery id granted to whoever kills the boss (see discoveries.ts). */
  discovery: string;
  respawnMinutes: number;
  /** Ground colour of the lair area. */
  color: number;
}

export const LAIR_DEFS: Record<string, LairDef> = {
  goblin_camp: {
    kind: "goblin_camp",
    name: "Goblin Camp",
    description: "A ramshackle camp of goblin raiders and their chief.",
    tier: 1,
    radius: 7,
    pack: [{ type: "goblin", count: 4 }],
    boss: "goblin_chief",
    bossLoot: { wood: 200, gold: 80 },
    clearXp: 150,
    trophy: { id: "goblin_totem", name: "Goblin Totem", description: "The chief's carved totem. Your woodcutters work with renewed spite.", effects: [{ stat: "gather.wood", pct: 0.05 }] },
    discovery: "war_drums",
    respawnMinutes: 30,
    color: 0x6a5232,
  },
  spider_nest: {
    kind: "spider_nest",
    name: "Spider Nest",
    description: "Webs hang between the trees; giant spiders and their queen lurk within.",
    tier: 2,
    radius: 7,
    pack: [{ type: "giant_spider", count: 5 }],
    boss: "spider_queen",
    bossLoot: { food: 300, gold: 120 },
    clearXp: 300,
    trophy: { id: "silk_banner", name: "Silk Banner", description: "A banner woven from the queen's silk. Strong, light cords for every pack: +5% carrying capacity.", effects: [{ stat: "capacity", pct: 0.05 }] },
    discovery: "silk_rigging",
    respawnMinutes: 30,
    color: 0x3e3a36,
  },
  bone_crypt: {
    kind: "bone_crypt",
    name: "Bone Crypt",
    description: "An old tomb where the dead do not rest, ruled by a lich.",
    tier: 2,
    radius: 8,
    pack: [{ type: "skeleton", count: 6 }],
    boss: "lich",
    bossLoot: { stone: 200, gold: 200 },
    clearXp: 450,
    trophy: { id: "lich_phylactery", name: "Lich's Phylactery", description: "Drained of its master, it still hums with lore: +5% experience.", effects: [{ stat: "xpGain", pct: 0.05 }] },
    discovery: "necromantic_grimoire",
    respawnMinutes: 40,
    color: 0x5a5a52,
  },
  ogre_den: {
    kind: "ogre_den",
    name: "Ogre Den",
    description: "A cave mouth strewn with bones. Ogres and their warlord.",
    tier: 3,
    radius: 8,
    pack: [{ type: "ogre", count: 3 }],
    boss: "ogre_warlord",
    bossLoot: { stone: 400, gold: 250 },
    clearXp: 800,
    trophy: { id: "warlord_skull", name: "Warlord's Skull", description: "Mounted over the gate, it daunts attackers: +10% building health.", effects: [{ stat: "buildingHp", pct: 0.1 }] },
    discovery: "ogre_masonry",
    respawnMinutes: 45,
    color: 0x6a5a4a,
  },
  drake_roost: {
    kind: "drake_roost",
    name: "Drake Roost",
    description: "Scorched rock and a hoard of gold: an ancient drake and its whelps.",
    tier: 4,
    radius: 9,
    pack: [{ type: "drake_whelp", count: 3 }],
    boss: "ancient_drake",
    bossLoot: { gold: 800 },
    clearXp: 2000,
    trophy: { id: "drake_scale", name: "Drake Scale", description: "A scale as big as a shield. Your fighters hit harder knowing they faced worse: +10% damage.", effects: [{ stat: "damage", pct: 0.1 }] },
    discovery: "dragonfire_lore",
    respawnMinutes: 120,
    color: 0x4a2a22,
  },
};

export const LAIR_KINDS = Object.keys(LAIR_DEFS);

export function findLairDef(kind: string): LairDef | undefined {
  return Object.hasOwn(LAIR_DEFS, kind) ? LAIR_DEFS[kind] : undefined;
}

/** All trophies by id. */
export const TROPHY_DEFS: Record<string, TrophyDef> = Object.fromEntries(Object.values(LAIR_DEFS).map((l) => [l.trophy.id, l.trophy]));

export function findTrophyDef(id: string): TrophyDef | undefined {
  return Object.hasOwn(TROPHY_DEFS, id) ? TROPHY_DEFS[id] : undefined;
}

/** Monsters chase intruders at most this many tiles beyond their lair's edge. */
export const LAIR_LEASH = 6;
/** After clearing, only the clearing player may build in the lair for this long. */
export const LAIR_CLAIM_MINUTES = 60;
