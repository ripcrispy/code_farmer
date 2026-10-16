import type { Effect, StatKey } from "./effects.ts";
import type { ResourceBag } from "./resources.ts";

/**
 * Heroes: one per player, a different one per race. A hero is an ordinary unit
 * (type "hero_<race>") with extra rules:
 *  - recruited once at a Town Hall, revived at a Town Hall or Barracks after dying
 *    (it keeps its training);
 *  - health and damage grow with the player's level, Barracks battle training and
 *    Library research;
 *  - a passive aura or trait and three abilities with cooldowns, usable from the UI
 *    or from scripts (use_ability). Abilities that hurt others need combat enabled.
 * See docs/GAME_DESIGN.md (Heroes).
 */

/** A timed modifier on a unit or building (from abilities). */
export interface BuffSpec {
  /** Stat changed while the buff lasts, or a special state. */
  stat: StatKey | "invulnerable" | "stealth" | "vulnerable";
  /** Fractional change (+0.25 = +25%). Ignored for invulnerable and stealth. */
  pct: number;
}

export type AbilityKind =
  /** Heal own units within `radius` of the hero by `amount`. */
  | { kind: "heal_area"; radius: number; amount: number }
  /** Buff own units within `radius` of the hero for `duration` seconds. */
  | { kind: "buff_units"; radius: number; duration: number; buffs: BuffSpec[] }
  /** Buff own buildings within `radius` of the hero (training/research speed). */
  | { kind: "buff_buildings"; radius: number; duration: number; buffs: BuffSpec[] }
  /** Buff the hero itself. */
  | { kind: "self_buff"; duration: number; buffs: BuffSpec[] }
  /** Add a fraction of total construction to own building sites within `radius`. */
  | { kind: "construct"; radius: number; fraction: number }
  /** Pay `from` (from storage near the hero) and receive `to` there. */
  | { kind: "convert"; from: Partial<ResourceBag>; to: Partial<ResourceBag> }
  /** Tame the nearest tameable wild animal within `radius` instantly (no observing or food). */
  | { kind: "tame_nearest"; radius: number }
  /** Move the hero to a passable tile within `range`. */
  | { kind: "teleport"; range: number }
  /** Let the player see (and detect hidden units) around a point within `range` for `duration` seconds. */
  | { kind: "reveal"; range: number; radius: number; duration: number }
  /** Damage one enemy unit within `range`. */
  | { kind: "strike"; range: number; damage: number; lifesteal?: number; hiddenBonus?: number }
  /** Damage attackable units within `radius` of the hero, optionally slowing them. */
  | { kind: "area_damage"; radius: number; damage: number; slow?: number; slowDuration?: number }
  /** Curse one enemy unit within `range`: takes more damage and moves slower. */
  | { kind: "debuff"; range: number; duration: number; vulnerable: number; slow: number };

export type AbilityTarget = "none" | "enemy" | "point";

export interface AbilityDef {
  id: string;
  name: string;
  description: string;
  /** Seconds before it can be used again (before modifiers). */
  cooldown: number;
  target: AbilityTarget;
  /** Hurts other units: only usable when combat is enabled on the server. */
  combat: boolean;
  effect: AbilityKind;
}

export interface HeroDef {
  race: string;
  /** Unit type id of this hero. */
  type: string;
  name: string;
  strengths: string;
  weaknesses: string;
  /** Passive aura: own units within `radius` tiles of the living hero get these effects. */
  aura: { name: string; description: string; radius: number; effects: { stat: StatKey; pct: number }[] } | null;
  /** Passive trait without an aura (described for the UI). */
  trait: string | null;
  /** Damage reduction 0..1 before buffs. */
  armor: number;
  /** Revival cost and time multiplier (Undead: 0.5). */
  reviveFactor: number;
  abilities: AbilityDef[];
}

export const HERO_DEFS: Record<string, HeroDef> = {
  human: {
    race: "human",
    type: "hero_human",
    name: "Paladin",
    strengths: "Tough and well armoured; heals and inspires workers",
    weaknesses: "Slow; melee only",
    aura: { name: "Devotion", description: "Own units nearby take 15% less damage", radius: 6, effects: [{ stat: "armor", pct: 0.15 }] },
    trait: null,
    armor: 0.3,
    reviveFactor: 1,
    abilities: [
      { id: "holy_light", name: "Holy Light", description: "Heal your units within 6 tiles by 60 health.", cooldown: 30, target: "none", combat: false, effect: { kind: "heal_area", radius: 6, amount: 60 } },
      { id: "rally", name: "Rally", description: "Your units within 8 tiles gather and build 25% faster for 30 seconds.", cooldown: 90, target: "none", combat: false, effect: { kind: "buff_units", radius: 8, duration: 30, buffs: [{ stat: "gather.wood", pct: 0.25 }, { stat: "gather.stone", pct: 0.25 }, { stat: "gather.gold", pct: 0.25 }, { stat: "gather.food", pct: 0.25 }, { stat: "buildRate", pct: 0.25 }] } },
      { id: "divine_shield", name: "Divine Shield", description: "The Paladin cannot be harmed for 8 seconds.", cooldown: 60, target: "none", combat: false, effect: { kind: "self_buff", duration: 8, buffs: [{ stat: "invulnerable", pct: 0 }] } },
    ],
  },
  orc: {
    race: "orc",
    type: "hero_orc",
    name: "Warchief",
    strengths: "Highest damage; fast; speeds up training",
    weaknesses: "Light armour",
    aura: { name: "Warpath", description: "Own units nearby move 15% faster", radius: 8, effects: [{ stat: "moveSpeed", pct: 0.15 }] },
    trait: null,
    armor: 0.15,
    reviveFactor: 1,
    abilities: [
      { id: "war_cry", name: "War Cry", description: "Your units within 8 tiles deal 30% more damage and move 20% faster for 20 seconds.", cooldown: 60, target: "none", combat: false, effect: { kind: "buff_units", radius: 8, duration: 20, buffs: [{ stat: "damage", pct: 0.3 }, { stat: "moveSpeed", pct: 0.2 }] } },
      { id: "muster", name: "Muster", description: "Your buildings within 10 tiles train units twice as fast for 30 seconds.", cooldown: 120, target: "none", combat: false, effect: { kind: "buff_buildings", radius: 10, duration: 30, buffs: [{ stat: "trainTime", pct: -0.5 }] } },
      { id: "whirlwind", name: "Whirlwind", description: "Deal 40 damage to every unit you may attack within 2 tiles.", cooldown: 25, target: "none", combat: true, effect: { kind: "area_damage", radius: 2, damage: 40 } },
    ],
  },
  dwarf: {
    race: "dwarf",
    type: "hero_dwarf",
    name: "Thane",
    strengths: "Most health and armour; a master builder and miner",
    weaknesses: "Slowest hero; short sight",
    aura: { name: "Stonework", description: "Own units nearby build and repair 20% faster", radius: 6, effects: [{ stat: "buildRate", pct: 0.2 }] },
    trait: null,
    armor: 0.35,
    reviveFactor: 1,
    abilities: [
      { id: "master_mason", name: "Master Mason", description: "Your construction sites within 6 tiles advance by a quarter of their total build time.", cooldown: 60, target: "none", combat: false, effect: { kind: "construct", radius: 6, fraction: 0.25 } },
      { id: "rich_seam", name: "Rich Seam", description: "Your units within 8 tiles gather stone and gold 50% faster for 30 seconds.", cooldown: 90, target: "none", combat: false, effect: { kind: "buff_units", radius: 8, duration: 30, buffs: [{ stat: "gather.stone", pct: 0.5 }, { stat: "gather.gold", pct: 0.5 }] } },
      { id: "thunder_slam", name: "Thunder Slam", description: "Deal 30 damage to every unit you may attack within 3 tiles and slow them by 50% for 5 seconds.", cooldown: 30, target: "none", combat: true, effect: { kind: "area_damage", radius: 3, damage: 30, slow: 0.5, slowDuration: 5 } },
    ],
  },
  high_elf: {
    race: "high_elf",
    type: "hero_high_elf",
    name: "Loremaster",
    strengths: "Attacks from range; long sight; speeds research",
    weaknesses: "Fragile",
    aura: { name: "Clarity", description: "Own units nearby get a 50% larger script instruction budget", radius: 8, effects: [{ stat: "scriptOps", pct: 0.5 }] },
    trait: null,
    armor: 0.05,
    reviveFactor: 1,
    abilities: [
      { id: "farsight", name: "Farsight", description: "Reveal the area around a point up to 40 tiles away for 20 seconds, including hidden units.", cooldown: 60, target: "point", combat: false, effect: { kind: "reveal", range: 40, radius: 10, duration: 20 } },
      { id: "inspiration", name: "Inspiration", description: "Your buildings within 8 tiles research and train 50% faster for 30 seconds.", cooldown: 90, target: "none", combat: false, effect: { kind: "buff_buildings", radius: 8, duration: 30, buffs: [{ stat: "researchTime", pct: -0.34 }, { stat: "trainTime", pct: -0.34 }] } },
      { id: "arcane_bolt", name: "Arcane Bolt", description: "Deal 45 damage to a unit you may attack within 7 tiles.", cooldown: 12, target: "enemy", combat: true, effect: { kind: "strike", range: 7, damage: 45 } },
    ],
  },
  dark_elf: {
    race: "dark_elf",
    type: "hero_dark_elf",
    name: "Shadowblade",
    strengths: "Fastest hero; always stealthy; devastating single strikes",
    weaknesses: "Fragile",
    aura: null,
    trait: "Always hidden from other players unless they have something close by",
    armor: 0.1,
    reviveFactor: 1,
    abilities: [
      { id: "shadowstep", name: "Shadowstep", description: "Step to an open tile up to 10 tiles away.", cooldown: 20, target: "point", combat: false, effect: { kind: "teleport", range: 10 } },
      { id: "veil_of_night", name: "Veil of Night", description: "Your units within 6 tiles are hidden from other players for 30 seconds.", cooldown: 90, target: "none", combat: false, effect: { kind: "buff_units", radius: 6, duration: 30, buffs: [{ stat: "stealth", pct: 0 }] } },
      { id: "backstab", name: "Backstab", description: "Deal 50 damage to an adjacent unit you may attack; double while the Shadowblade is hidden.", cooldown: 15, target: "enemy", combat: true, effect: { kind: "strike", range: 1, damage: 50, hiddenBonus: 1 } },
    ],
  },
  undead: {
    race: "undead",
    type: "hero_undead",
    name: "Necromancer",
    strengths: "Revives for half the cost and time; turns food into gold",
    weaknesses: "Slow; low damage",
    aura: null,
    trait: "Revives for half the cost and in half the time",
    armor: 0.15,
    reviveFactor: 0.5,
    abilities: [
      { id: "dark_ritual", name: "Dark Ritual", description: "Turn 100 food from storage near the Necromancer into 50 gold.", cooldown: 60, target: "none", combat: false, effect: { kind: "convert", from: { food: 100 }, to: { gold: 50 } } },
      { id: "unholy_toil", name: "Unholy Toil", description: "Your units within 8 tiles gather and build 30% faster for 30 seconds.", cooldown: 90, target: "none", combat: false, effect: { kind: "buff_units", radius: 8, duration: 30, buffs: [{ stat: "gather.wood", pct: 0.3 }, { stat: "gather.stone", pct: 0.3 }, { stat: "gather.gold", pct: 0.3 }, { stat: "gather.food", pct: 0.3 }, { stat: "buildRate", pct: 0.3 }] } },
      { id: "drain_life", name: "Drain Life", description: "Deal 35 damage to a unit you may attack within 5 tiles and heal the Necromancer by as much.", cooldown: 15, target: "enemy", combat: true, effect: { kind: "strike", range: 5, damage: 35, lifesteal: 1 } },
    ],
  },
  troll: {
    race: "troll",
    type: "hero_troll",
    name: "Shaman",
    strengths: "Healing and regeneration; befriends wild animals",
    weaknesses: "Low damage and armour",
    aura: { name: "Spirit Bond", description: "Own units nearby regenerate three times as fast", radius: 6, effects: [{ stat: "regeneration", pct: 2 }] },
    trait: null,
    armor: 0.1,
    reviveFactor: 1,
    abilities: [
      { id: "spirit_totem", name: "Spirit Totem", description: "Heal your units within 6 tiles by 50 health.", cooldown: 30, target: "none", combat: false, effect: { kind: "heal_area", radius: 6, amount: 50 } },
      { id: "wild_call", name: "Wild Call", description: "Instantly tame the nearest tameable wild animal within 6 tiles, without observing it or feeding it.", cooldown: 120, target: "none", combat: false, effect: { kind: "tame_nearest", radius: 6 } },
      { id: "hex", name: "Hex", description: "Curse a unit you may attack within 6 tiles: it takes 50% more damage and moves 40% slower for 10 seconds.", cooldown: 30, target: "enemy", combat: true, effect: { kind: "debuff", range: 6, duration: 10, vulnerable: 0.5, slow: 0.4 } },
    ],
  },
};

/** Barracks battle training: three tracks of up to five ranks each. Ranks are kept through death. */
export interface HeroTrainingDef {
  id: string;
  name: string;
  description: string;
  maxRank: number;
  /** Effect of one rank. */
  effects: Effect[];
}

export const HERO_TRAINING: Record<string, HeroTrainingDef> = {
  strength: { id: "strength", name: "Strength", description: "+12% hero damage per rank", maxRank: 5, effects: [{ stat: "heroDamage", pct: 0.12 }] },
  vitality: { id: "vitality", name: "Vitality", description: "+15% hero health per rank", maxRank: 5, effects: [{ stat: "heroHp", pct: 0.15 }] },
  tactics: { id: "tactics", name: "Tactics", description: "-8% hero ability cooldowns per rank", maxRank: 5, effects: [{ stat: "heroCooldown", pct: -0.08 }] },
};

/** Cost and seconds of the given (1-based) training rank. */
export function heroTrainingCost(rank: number): { cost: ResourceBag; time: number } {
  return { cost: { wood: 20 * rank, stone: 0, gold: 25 * rank, food: 50 * rank }, time: 20 + 10 * rank };
}

/** The first recruitment is free, so every player can have a hero from the start. */
export const HERO_RECRUIT_COST: Partial<ResourceBag> = {};
export const HERO_RECRUIT_SECONDS = 30;

/** Revival cost and seconds before race and research modifiers. */
export function heroReviveBase(level: number): { cost: ResourceBag; time: number } {
  return { cost: { wood: 0, stone: 0, gold: 25 + 5 * level, food: 50 }, time: 20 + level };
}

/** Hero health and damage grow by this fraction per player level above 1. */
export const HERO_LEVEL_SCALING = 0.02;

/** Buildings where a hero can be recruited or revived. */
export const HERO_BUILDINGS: readonly string[] = ["town_hall", "barracks"];

export function heroDefForRace(race: string): HeroDef | undefined {
  return Object.hasOwn(HERO_DEFS, race) ? HERO_DEFS[race] : undefined;
}

export function heroDefForType(type: string): HeroDef | undefined {
  if (!type.startsWith("hero_")) return undefined;
  return heroDefForRace(type.slice(5));
}

export function isHeroType(type: string): boolean {
  return heroDefForType(type) !== undefined;
}

export function findAbility(hero: HeroDef, id: string): AbilityDef | undefined {
  return hero.abilities.find((a) => a.id === id);
}
