import { HERO_DEFS } from "./heroes.ts";
import type { ResourceBag, ResourceType } from "./resources.ts";
import type { StatKey } from "./effects.ts";

/** Unit capability flags. Commands check these rather than unit type names. */
export type Capability = "gather" | "build" | "explore" | "follow" | "guard" | "stealth";

/** Creature-specific data. Wild creatures are owned by nobody and run their own (inspectable) programs. */
export interface CreatureInfo {
  /** Food a unit must carry to tame one (0 = cannot be tamed). */
  tameCost: number;
  /** Seconds a unit must watch the creature (within 6 tiles) to learn its behaviour. */
  observeSeconds: number;
  /** Abilities a tamed creature can be trained in, with their food cost. */
  trainable: Record<string, { capability: Capability; cost: number; seconds: number; description: string }>;
  /** Program the creature runs while wild (players see it once they have observed the species). */
  wildProgram: string;
  /** Hidden discovery revealed by observing the creature while it does something specific. */
  hidden: { discovery: string; whileActivity: string } | null;
  color: number;
  /** Food a hunter receives when it kills one (only with combat enabled). */
  meat: number;
  /** What the animal gives while kept in a Paddock (absent: it cannot be penned). */
  paddock?: PaddockInfo;
}

/**
 * Benefits of a tamed animal kept in a Paddock. Production is per animal; a bonus counts
 * each animal of the species in any of your paddocks, up to `maxAnimals`.
 */
export interface PaddockInfo {
  /** Resources produced per minute by each animal. */
  produces: Partial<ResourceBag>;
  bonus: { stat: StatKey; pct?: number; add?: number; maxAnimals: number } | null;
  /** Seconds for a pair to raise a young one (while the paddock has room). */
  breedSeconds: number;
  /** Food paid (from your stock) when a young one is born. */
  breedCost: number;
}

/** Hostile PvE monsters. They live in lairs (see lairs.ts) and only fight intruders. */
export interface MonsterInfo {
  boss: boolean;
  /** Resources delivered to the killer's owner (bosses: their lair's boss loot instead). */
  loot: Partial<ResourceBag>;
  xp: number;
  /** Drawn as a figure (goblins, skeletons) rather than a beast. */
  humanoid: boolean;
  color: number;
}

/** Fighting ability. Only used when combat is enabled on the server. */
export interface AttackInfo {
  /** Damage per hit. */
  damage: number;
  /** Reach in tiles (Chebyshev); 1 = melee. */
  range: number;
  /** Seconds between hits. */
  cooldown: number;
  /** Damage multiplier against buildings (tools and claws do little to walls). */
  buildingFactor: number;
}

export interface UnitDef {
  type: string;
  name: string;
  description: string;
  capabilities: Capability[];
  /** Tiles per second. */
  speed: number;
  /** Total items carried across all resource types. */
  capacity: number;
  /** Units of resource gathered per second, per resource type. 0 = cannot gather it. */
  gatherRate: Record<ResourceType, number>;
  /** Construction points per second. */
  buildRate: number;
  maxHp: number;
  /** Radius (tiles) used by find_nearest queries. */
  senseRadius: number;
  /** Cost when trained from a building. null = cannot be trained. */
  cost: Partial<ResourceBag> | null;
  /** Training time in seconds. */
  trainTime: number;
  /** Default behaviour program, in the Code Farmer script language. */
  defaultProgram: string;
  /** Present for creatures (wildlife). */
  creature?: CreatureInfo;
  /** Present for units that can fight (combat must be enabled on the server). */
  attack?: AttackInfo;
  /** Military units: only trainable when fighting is possible on the server (combat or PvE enabled). */
  requiresCombat?: boolean;
  /** The race's hero (one per player; see heroes.ts). */
  hero?: boolean;
  /** Present for PvE monsters. */
  monster?: MonsterInfo;
  /** Drawing scale (bosses and big beasts are larger). */
  size?: number;
  /** Heals your units nearby every second. */
  healer?: { radius: number; hpPerSecond: number };
  /** Tames for less food and observes faster (factors). */
  tamer?: { costFactor: number; observeFactor: number };
}

const GATHER_PROGRAM = `# Default gatherer: harvest the nearest tree, return the wood, repeat.
resource = "tree"

while alive:
    if inventory.is_full():
        deposit()
    else:
        node = find_nearest(resource)
        if node is not None:
            harvest(node)
        elif not inventory.is_empty():
            deposit()
        else:
            print("No", resource, "nearby - exploring")
            explore()
`;

const BUILDER_PROGRAM = `# Default builder: help finish construction sites, otherwise gather stone or wood.
while alive:
    site = find_nearest("construction")
    if site is not None:
        if not inventory.is_empty():
            deposit()
        build(site)
    elif inventory.is_full():
        deposit()
    else:
        node = find_nearest("stone")
        if node is None:
            node = find_nearest("tree")
        if node is not None:
            harvest(node)
        else:
            wait(2)
`;

const SCOUT_PROGRAM = `# Default scout: explore the surroundings and report what it finds.
steps = 0
while alive:
    explore()
    steps += 1
    gold = find_nearest("gold")
    if gold is not None:
        print("Gold seen at", gold.x, gold.y)
    if steps % 5 == 0:
        print("Explored", steps, "legs; now at", me.x, me.y)
`;

const HAULER_PROGRAM = `# Default hauler: fill up on whichever resource you have least of, then deposit.
def lowest():
    s = stock_all()
    best = "wood"
    for r in ["stone", "food", "wood"]:
        if s[r] < s[best]:
            best = r
    return best

kinds = {"wood": "tree", "stone": "stone", "food": "berries"}
while alive:
    if inventory.is_full():
        deposit()
    else:
        node = find_nearest(kinds[lowest()])
        if node is None:
            node = find_nearest("tree")
        if node is not None:
            harvest(node)
        elif not inventory.is_empty():
            deposit()
        else:
            explore()
`;

const WORKER_PROGRAM = `# Default worker: gather food from berry bushes, fall back to wood.
while alive:
    if inventory.is_full():
        deposit()
    else:
        node = find_nearest("berries")
        if node is None:
            node = find_nearest("tree")
        if node is not None:
            harvest(node)
        else:
            explore()
`;

const DEER_WILD = `# Deer: graze and wander near home; run from anything that hurts it.
while alive:
    a = last_attacker()
    if a is not None:
        flee(a)
    else:
        wander(6)
        wait(3)
`;

const BOAR_WILD = `# Wild boar: root for berries near its home; otherwise roam. Charges whoever attacks it.
while alive:
    a = last_attacker()
    if a is not None:
        attack(a)
        continue
    b = find_nearest("berries")
    if b is not None and distance_to(b) < 12:
        harvest(b)
        wait(2)
    else:
        wander(8)
        wait(2)
`;

const WOLF_WILD = `# Wolf: patrol the territory around its den. Never attacks first, but fights back.
while alive:
    a = last_attacker()
    if a is not None:
        attack(a)
    else:
        wander(10)
        wait(2)
`;

const BOAR_TAMED = `# Tamed boar: forage berries and bring them home.
while alive:
    if inventory.is_full():
        deposit()
    else:
        b = find_nearest("berries")
        if b is not None:
            harvest(b)
        else:
            wander(8)
`;

const WOLF_TAMED = `# Tamed wolf: roam ahead of your settlement as a lookout.
while alive:
    explore()
    wait(2)
`;

const PADDOCK_ANIMAL = (name: string): string => `# Tamed ${name}: walk to the nearest paddock with room and live there.
# Otherwise stay close to your units until you build one.
while alive:
    p = find_nearest("paddock")
    if p is not None:
        pen(p)
    else:
        u = find_nearest("unit")
        if u is not None:
            follow(u, 20)
        else:
            wait(3)
`;

const SHEEP_WILD = `# Sheep: graze in a loose flock near home; run from anything that hurts them.
while alive:
    a = last_attacker()
    if a is not None:
        flee(a)
    else:
        wander(5)
        wait(4)
`;

const GOAT_WILD = `# Mountain goat: climbs about the hills near home; bolts when attacked.
while alive:
    a = last_attacker()
    if a is not None:
        flee(a)
    else:
        wander(7)
        wait(3)
`;

const HORSE_WILD = `# Wild horse: roams widely across open grassland, and outruns trouble.
while alive:
    a = last_attacker()
    if a is not None:
        flee(a)
    else:
        wander(14)
        wait(2)
`;

const AUROCHS_WILD = `# Aurochs: wild cattle. Grazes slowly and stands its ground if attacked.
while alive:
    a = last_attacker()
    if a is not None:
        attack(a)
    else:
        wander(6)
        wait(4)
`;

const BEAR_WILD = `# Bear: forages for berries around its den. Fights back hard when attacked.
while alive:
    a = last_attacker()
    if a is not None:
        attack(a)
        continue
    b = find_nearest("berries")
    if b is not None and distance_to(b) < 8:
        harvest(b)
        wait(3)
    else:
        wander(6)
        wait(3)
`;

/** Lair guardians: attack whoever enters the lair, and never stray far from it. */
const MONSTER_PROGRAM = (name: string): string => `# ${name}: guards its lair. Attacks anyone who comes in or hits it,
# and always returns home rather than chase intruders far.
while alive:
    a = last_attacker()
    if a is None:
        a = find_nearest("enemy")
    if a is not None:
        attack(a)
    elif distance_to_home() > 4:
        go_home()
    else:
        wander(4)
        wait(2)
`;

const MINER_PROGRAM = `# Default miner: quarry stone (or gold, if you change RESOURCE) and bring it home.
RESOURCE = "stone"

while alive:
    if inventory.is_full():
        deposit()
    else:
        node = find_nearest(RESOURCE)
        if node is None:
            node = find_nearest("gold")
        if node is not None:
            harvest(node)
        elif not inventory.is_empty():
            deposit()
        else:
            explore()
`;

const RANGER_PROGRAM = `# Default ranger: finds wild animals, studies them and tames them
# (they then walk to your paddock). Fights back if attacked.
while alive:
    a = last_attacker()
    if a is not None:
        attack(a)
        continue
    c = find_nearest("creature")
    if c is None:
        explore()
    elif observe(c):
        if inventory.count("food") < 40:
            withdraw("food", 40)
        if not tame(c):
            explore()
    else:
        explore()
`;

const KNIGHT_PROGRAM = `# Knight: defends the settlement and hunts monsters that come close.
while alive:
    a = last_attacker()
    if a is None:
        a = find_nearest("monster")
        if a is not None and distance_to(a) > 10:
            a = None
    if a is None:
        a = find_nearest("enemy")
        if a is not None and distance_to(a) > 12:
            a = None
    if a is not None:
        attack(a)
    else:
        wait(2)
`;

const CLERIC_PROGRAM = `# Cleric: heals your units within 4 tiles every second, so stay with them.
# Follows your hero if you have one, otherwise the nearest unit.
while alive:
    h = hero()
    if h is None:
        h = find_nearest("unit")
    if h is not None:
        follow(h, 20)
    else:
        wait(3)
`;

const SOLDIER_PROGRAM = `# Soldier: defend the settlement. Fights back when attacked and
# engages enemies (and monsters) that come close; otherwise stands near home.
while alive:
    a = last_attacker()
    if a is None:
        a = find_nearest("enemy")
        if a is None:
            a = find_nearest("monster")
        if a is not None and distance_to(a) > 12:
            a = None
    if a is not None:
        attack(a)
    else:
        wait(2)
`;

const ARCHER_PROGRAM = `# Archer: like the soldier, but shoots from a distance.
while alive:
    a = last_attacker()
    if a is None:
        a = find_nearest("enemy")
        if a is not None and distance_to(a) > 14:
            a = None
    if a is not None:
        attack(a)
    else:
        wait(2)
`;

const ZERO = { wood: 0, stone: 0, gold: 0, food: 0 };

export const UNIT_DEFS: Record<string, UnitDef> = {
  woodcutter: {
    type: "woodcutter",
    name: "Woodcutter",
    description: "Starting gatherer. Fast at felling trees and carries more than other units.",
    capabilities: ["gather", "build", "explore"],
    speed: 2.5,
    capacity: 15,
    gatherRate: { wood: 1.6, stone: 0.8, gold: 0.6, food: 1.0 },
    buildRate: 0.6,
    maxHp: 60,
    senseRadius: 20,
    cost: null,
    trainTime: 0,
    attack: { damage: 4, range: 1, cooldown: 1.2, buildingFactor: 0.4 },
    defaultProgram: GATHER_PROGRAM,
  },
  builder: {
    type: "builder",
    name: "Builder",
    description: "Starting constructor. Builds quickly and quarries stone.",
    capabilities: ["gather", "build", "explore"],
    speed: 2.2,
    capacity: 10,
    gatherRate: { wood: 0.9, stone: 1.2, gold: 0.8, food: 0.8 },
    buildRate: 1.6,
    maxHp: 70,
    senseRadius: 20,
    cost: null,
    trainTime: 0,
    attack: { damage: 3, range: 1, cooldown: 1.2, buildingFactor: 0.5 },
    defaultProgram: BUILDER_PROGRAM,
  },
  scout: {
    type: "scout",
    name: "Scout",
    description: "Explorer. Moves quickly, senses further and is hard to spot (stealthy), but carries little. One is in every starting party; more can be trained at a Lodge.",
    capabilities: ["gather", "build", "explore", "stealth"],
    speed: 4.0,
    capacity: 6,
    gatherRate: { wood: 0.6, stone: 0.5, gold: 0.5, food: 0.9 },
    buildRate: 0.5,
    maxHp: 45,
    senseRadius: 28,
    cost: { food: 50 },
    trainTime: 12,
    attack: { damage: 3, range: 1, cooldown: 1.0, buildingFactor: 0.2 },
    defaultProgram: SCOUT_PROGRAM,
  },
  worker: {
    type: "worker",
    name: "Worker",
    description: "General-purpose labourer trained at a Town Hall.",
    capabilities: ["gather", "build", "explore"],
    speed: 2.5,
    capacity: 10,
    gatherRate: { wood: 1.0, stone: 0.9, gold: 0.7, food: 1.2 },
    buildRate: 1.0,
    maxHp: 50,
    senseRadius: 20,
    cost: { food: 40 },
    trainTime: 15,
    attack: { damage: 3, range: 1, cooldown: 1.2, buildingFactor: 0.3 },
    defaultProgram: WORKER_PROGRAM,
  },
  hauler: {
    type: "hauler",
    name: "Hauler",
    description: "Slow but carries three times as much. Ideal for distant resources.",
    capabilities: ["gather", "build", "explore"],
    speed: 2.0,
    capacity: 30,
    gatherRate: { wood: 0.9, stone: 0.9, gold: 0.6, food: 0.9 },
    buildRate: 0.4,
    maxHp: 80,
    senseRadius: 24,
    cost: { wood: 40, food: 40 },
    trainTime: 20,
    attack: { damage: 2, range: 1, cooldown: 1.4, buildingFactor: 0.3 },
    defaultProgram: HAULER_PROGRAM,
  },
  deer: {
    type: "deer",
    name: "Deer",
    description: "Shy grazers of open grassland. Harmless; cannot be tamed.",
    capabilities: ["explore"],
    speed: 3,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 40,
    senseRadius: 10,
    cost: null,
    trainTime: 0,
    defaultProgram: DEER_WILD,
    creature: { tameCost: 0, observeSeconds: 8, trainable: {}, wildProgram: DEER_WILD, hidden: null, color: 0xa0703a, meat: 40 },
  },
  boar: {
    type: "boar",
    name: "Wild Boar",
    description: "Forest foragers that strip berry bushes. Can be tamed to forage for you.",
    capabilities: ["gather", "explore"],
    speed: 2.2,
    capacity: 8,
    gatherRate: { ...ZERO, food: 0.8 },
    buildRate: 0,
    maxHp: 70,
    senseRadius: 14,
    cost: null,
    trainTime: 0,
    attack: { damage: 6, range: 1, cooldown: 1.2, buildingFactor: 0 },
    defaultProgram: BOAR_TAMED,
    creature: {
      tameCost: 30,
      observeSeconds: 10,
      trainable: {},
      wildProgram: BOAR_WILD,
      hidden: { discovery: "foragers_instinct", whileActivity: "foraging" },
      color: 0x4a3426,
      meat: 50,
      paddock: { produces: { food: 5 }, bonus: null, breedSeconds: 360, breedCost: 20 },
    },
  },
  wolf: {
    type: "wolf",
    name: "Wolf",
    description: "Pack hunters of forests and hills. Tamed wolves scout, follow, and can be trained to guard.",
    capabilities: ["explore", "follow"],
    speed: 3.5,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 90,
    senseRadius: 24,
    cost: null,
    trainTime: 0,
    attack: { damage: 9, range: 1, cooldown: 1.0, buildingFactor: 0 },
    defaultProgram: WOLF_TAMED,
    creature: {
      tameCost: 50,
      observeSeconds: 12,
      trainable: {
        guard: { capability: "guard", cost: 40, seconds: 10, description: "Stand guard at a spot; wild creatures stay away from resources near a guarding wolf." },
      },
      wildProgram: WOLF_WILD,
      hidden: null,
      color: 0x8a8a92,
      meat: 20,
      paddock: { produces: {}, bonus: { stat: "senseRadius", add: 1, maxAnimals: 3 }, breedSeconds: 600, breedCost: 40 },
    },
  },
  soldier: {
    type: "soldier",
    name: "Soldier",
    description: "Trained fighter with sword and shield. Strong against units and buildings. Trainable when combat or PvE is enabled on the server.",
    capabilities: ["explore"],
    speed: 2.6,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 140,
    senseRadius: 20,
    cost: { wood: 20, food: 60 },
    trainTime: 20,
    attack: { damage: 10, range: 1, cooldown: 1.0, buildingFactor: 1 },
    requiresCombat: true,
    defaultProgram: SOLDIER_PROGRAM,
  },
  archer: {
    type: "archer",
    name: "Archer",
    description: "Shoots from up to 5 tiles away. Fragile up close and weak against buildings. Trainable when combat or PvE is enabled on the server.",
    capabilities: ["explore"],
    speed: 2.6,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 70,
    senseRadius: 24,
    cost: { wood: 40, food: 50 },
    trainTime: 20,
    attack: { damage: 6, range: 5, cooldown: 1.5, buildingFactor: 0.3 },
    requiresCombat: true,
    defaultProgram: ARCHER_PROGRAM,
  },

  // ---- more player units ----
  miner: {
    type: "miner",
    name: "Miner",
    description: "Trained at a Mine. Quarries stone and gold much faster than other units.",
    capabilities: ["gather", "build", "explore"],
    speed: 2.3,
    capacity: 14,
    gatherRate: { wood: 0.6, stone: 1.9, gold: 1.5, food: 0.5 },
    buildRate: 0.5,
    maxHp: 65,
    senseRadius: 20,
    cost: { wood: 30, food: 40 },
    trainTime: 18,
    attack: { damage: 4, range: 1, cooldown: 1.2, buildingFactor: 0.5 },
    defaultProgram: MINER_PROGRAM,
  },
  ranger: {
    type: "ranger",
    name: "Ranger",
    description: "Trained at a Lodge. Studies animals twice as fast and tames them for half the food; shoots from 4 tiles.",
    capabilities: ["gather", "explore", "follow"],
    speed: 3.0,
    capacity: 10,
    gatherRate: { wood: 0.6, stone: 0.4, gold: 0.4, food: 1.1 },
    buildRate: 0.3,
    maxHp: 70,
    senseRadius: 26,
    cost: { food: 60, gold: 10 },
    trainTime: 18,
    attack: { damage: 7, range: 4, cooldown: 1.3, buildingFactor: 0.2 },
    tamer: { costFactor: 0.5, observeFactor: 0.5 },
    defaultProgram: RANGER_PROGRAM,
  },
  knight: {
    type: "knight",
    name: "Knight",
    description: "Trained at a Barracks. Heavily armoured; the backbone of a monster hunt. Trainable when combat or PvE is enabled on the server.",
    capabilities: ["explore", "follow"],
    speed: 2.8,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 240,
    senseRadius: 20,
    cost: { wood: 20, food: 80, gold: 40 },
    trainTime: 30,
    attack: { damage: 15, range: 1, cooldown: 1.0, buildingFactor: 0.8 },
    requiresCombat: true,
    size: 1.08,
    defaultProgram: KNIGHT_PROGRAM,
  },
  cleric: {
    type: "cleric",
    name: "Cleric",
    description: "Trained at a Library. Does not fight, but heals your units within 4 tiles by 3 health every second.",
    capabilities: ["explore", "follow"],
    speed: 2.5,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 60,
    senseRadius: 20,
    cost: { food: 50, gold: 40 },
    trainTime: 25,
    healer: { radius: 4, hpPerSecond: 3 },
    defaultProgram: CLERIC_PROGRAM,
  },

  // ---- more wildlife (generation v3) ----
  sheep: {
    type: "sheep",
    name: "Sheep",
    description: "Placid flocks of the grasslands. Easy to tame; in a paddock they give food and wool (traded for gold).",
    capabilities: ["explore", "follow"],
    speed: 2.0,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 35,
    senseRadius: 10,
    cost: null,
    trainTime: 0,
    size: 0.82,
    defaultProgram: PADDOCK_ANIMAL("sheep"),
    creature: { tameCost: 20, observeSeconds: 6, trainable: {}, wildProgram: SHEEP_WILD, hidden: null, color: 0xe8e4d8, meat: 30, paddock: { produces: { food: 4, gold: 1 }, bonus: null, breedSeconds: 300, breedCost: 15 } },
  },
  goat: {
    type: "goat",
    name: "Mountain Goat",
    description: "Sure-footed climbers of the hills. In a paddock they give milk, and their herders know the rocks: +3% stone gathering each (up to 5).",
    capabilities: ["explore", "follow"],
    speed: 2.6,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 40,
    senseRadius: 12,
    cost: null,
    trainTime: 0,
    size: 0.8,
    defaultProgram: PADDOCK_ANIMAL("goat"),
    creature: { tameCost: 25, observeSeconds: 8, trainable: {}, wildProgram: GOAT_WILD, hidden: null, color: 0xc8b89a, meat: 25, paddock: { produces: { food: 3 }, bonus: { stat: "gather.stone", pct: 0.03, maxAnimals: 5 }, breedSeconds: 300, breedCost: 15 } },
  },
  horse: {
    type: "horse",
    name: "Wild Horse",
    description: "Fast herds of the open plains. Hard to catch; every horse in your paddocks makes your units 3% faster (up to 5).",
    capabilities: ["explore", "follow"],
    speed: 4.2,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 80,
    senseRadius: 14,
    cost: null,
    trainTime: 0,
    size: 1.12,
    defaultProgram: PADDOCK_ANIMAL("horse"),
    creature: { tameCost: 60, observeSeconds: 10, trainable: {}, wildProgram: HORSE_WILD, hidden: null, color: 0x8a5a32, meat: 40, paddock: { produces: {}, bonus: { stat: "moveSpeed", pct: 0.03, maxAnimals: 5 }, breedSeconds: 600, breedCost: 40 } },
  },
  aurochs: {
    type: "aurochs",
    name: "Aurochs",
    description: "Great wild cattle. Fights back when provoked. In a paddock: plenty of food, and oxen carry loads: +3% carrying capacity each (up to 5).",
    capabilities: ["explore", "follow"],
    speed: 2.0,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: 140,
    senseRadius: 10,
    cost: null,
    trainTime: 0,
    attack: { damage: 9, range: 1, cooldown: 1.5, buildingFactor: 0 },
    size: 1.15,
    defaultProgram: PADDOCK_ANIMAL("aurochs"),
    creature: { tameCost: 70, observeSeconds: 10, trainable: {}, wildProgram: AUROCHS_WILD, hidden: null, color: 0x3a2a20, meat: 90, paddock: { produces: { food: 8 }, bonus: { stat: "capacity", pct: 0.03, maxAnimals: 5 }, breedSeconds: 600, breedCost: 40 } },
  },
  bear: {
    type: "bear",
    name: "Bear",
    description: "Lone foragers of forest and hills, and fearsome when attacked. A bear in your paddock inspires your fighters: +3% damage each (up to 5).",
    capabilities: ["gather", "explore", "follow"],
    speed: 2.6,
    capacity: 0,
    gatherRate: { ...ZERO, food: 0.6 },
    buildRate: 0,
    maxHp: 200,
    senseRadius: 14,
    cost: null,
    trainTime: 0,
    attack: { damage: 16, range: 1, cooldown: 1.2, buildingFactor: 0 },
    size: 1.25,
    defaultProgram: PADDOCK_ANIMAL("bear"),
    creature: { tameCost: 90, observeSeconds: 14, trainable: {}, wildProgram: BEAR_WILD, hidden: null, color: 0x5a3a24, meat: 70, paddock: { produces: {}, bonus: { stat: "damage", pct: 0.03, maxAnimals: 5 }, breedSeconds: 900, breedCost: 60 } },
  },
};


function heroProgram(name: string, support: string[]): string {
  return `# ${name}: stay with your workers, help build, and use support abilities
# whenever they are ready. Fights back when attacked (if combat is enabled).
SUPPORT = [${support.map((s) => `"${s}"`).join(", ")}]
while alive:
    a = last_attacker()
    if a is not None:
        attack(a)
        continue
    for name in SUPPORT:
        if ability_ready(name):
            use_ability(name)
    site = find_nearest("construction")
    if site is not None:
        build(site)
    else:
        u = find_nearest("unit")
        if u is not None:
            follow(u, 20)
        else:
            wait(3)
`;
}

type HeroStats = Pick<UnitDef, "speed" | "maxHp" | "senseRadius" | "buildRate"> & { attack: AttackInfo; support: string[] };
const HERO_STATS: Record<string, HeroStats> = {
  human: { speed: 2.4, maxHp: 400, senseRadius: 22, buildRate: 0.8, attack: { damage: 14, range: 1, cooldown: 1.0, buildingFactor: 0.6 }, support: ["rally", "holy_light"] },
  orc: { speed: 3.0, maxHp: 340, senseRadius: 22, buildRate: 0.8, attack: { damage: 20, range: 1, cooldown: 0.9, buildingFactor: 0.8 }, support: ["muster"] },
  dwarf: { speed: 2.1, maxHp: 480, senseRadius: 18, buildRate: 1.4, attack: { damage: 15, range: 1, cooldown: 1.1, buildingFactor: 1 }, support: ["master_mason", "rich_seam"] },
  high_elf: { speed: 2.6, maxHp: 220, senseRadius: 28, buildRate: 0.8, attack: { damage: 12, range: 5, cooldown: 1.3, buildingFactor: 0.3 }, support: ["inspiration"] },
  dark_elf: { speed: 3.6, maxHp: 240, senseRadius: 26, buildRate: 0.6, attack: { damage: 18, range: 1, cooldown: 0.8, buildingFactor: 0.4 }, support: [] },
  undead: { speed: 2.3, maxHp: 300, senseRadius: 22, buildRate: 0.8, attack: { damage: 11, range: 4, cooldown: 1.3, buildingFactor: 0.3 }, support: ["unholy_toil"] },
  troll: { speed: 2.8, maxHp: 300, senseRadius: 24, buildRate: 0.8, attack: { damage: 10, range: 4, cooldown: 1.2, buildingFactor: 0.3 }, support: ["spirit_totem", "wild_call"] },
};

for (const h of Object.values(HERO_DEFS)) {
  const st = HERO_STATS[h.race];
  if (!st) throw new Error(`Missing hero stats for ${h.race}`);
  UNIT_DEFS[h.type] = {
    type: h.type,
    name: h.name,
    description: `Hero. ${h.strengths}. Weakness: ${h.weaknesses.toLowerCase()}. Recruited once at a Town Hall; revived there or at a Barracks if it falls.`,
    capabilities: h.trait?.includes("hidden") ? ["build", "explore", "follow", "stealth"] : ["build", "explore", "follow"],
    speed: st.speed,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: st.buildRate,
    maxHp: st.maxHp,
    senseRadius: st.senseRadius,
    cost: null,
    trainTime: 0,
    attack: st.attack,
    hero: true,
    defaultProgram: heroProgram(h.name, st.support),
  };
}


// ---- PvE monsters (live in lairs, see lairs.ts) ----
function M(
  type: string,
  name: string,
  description: string,
  o: { hp: number; damage: number; range?: number; cooldown: number; speed: number; sense?: number; size?: number; boss?: boolean; humanoid: boolean; loot?: Partial<ResourceBag>; xp: number; color: number },
): UnitDef {
  return {
    type,
    name,
    description,
    capabilities: ["explore"],
    speed: o.speed,
    capacity: 0,
    gatherRate: { ...ZERO },
    buildRate: 0,
    maxHp: o.hp,
    senseRadius: o.sense ?? 10,
    cost: null,
    trainTime: 0,
    attack: { damage: o.damage, range: o.range ?? 1, cooldown: o.cooldown, buildingFactor: 0 },
    size: o.size ?? 1,
    defaultProgram: MONSTER_PROGRAM(name),
    monster: { boss: o.boss ?? false, loot: o.loot ?? {}, xp: o.xp, humanoid: o.humanoid, color: o.color },
  };
}

const MONSTER_DEFS: UnitDef[] = [
  M("goblin", "Goblin", "Small, quarrelsome raiders that hoard stolen timber and coin in their camps.", { hp: 70, damage: 6, cooldown: 1.0, speed: 2.6, humanoid: true, loot: { wood: 10, gold: 4 }, xp: 12, color: 0x6a8a2a }),
  M("goblin_chief", "Goblin Chief", "Boss of a goblin camp: tougher, angrier, and sitting on the camp's loot.", { hp: 450, damage: 14, cooldown: 1.1, speed: 2.4, size: 1.35, boss: true, humanoid: true, xp: 120, color: 0x8a2a1a }),
  M("giant_spider", "Giant Spider", "Fast, venomous hunters of the deep woods.", { hp: 95, damage: 9, cooldown: 0.9, speed: 3.2, humanoid: false, loot: { food: 15 }, xp: 18, color: 0x2a2a30 }),
  M("spider_queen", "Spider Queen", "Boss of a spider nest: an enormous, ancient spider.", { hp: 800, damage: 18, cooldown: 1.0, speed: 2.6, size: 1.8, boss: true, humanoid: false, xp: 250, color: 0x4a1a4a }),
  M("skeleton", "Skeleton", "Restless dead guarding a crypt.", { hp: 85, damage: 8, cooldown: 1.1, speed: 2.2, humanoid: true, loot: { stone: 10, gold: 6 }, xp: 18, color: 0xd8d4c4 }),
  M("lich", "Lich", "Boss of a crypt: a sorcerer who refused to die. Casts bolts from 4 tiles away.", { hp: 950, damage: 22, range: 4, cooldown: 1.6, speed: 2.0, size: 1.3, boss: true, humanoid: true, xp: 400, color: 0x3a6a4a }),
  M("ogre", "Ogre", "Huge brutes that hit very hard and slowly.", { hp: 280, damage: 20, cooldown: 1.4, speed: 2.0, size: 1.45, humanoid: true, loot: { stone: 25, gold: 15 }, xp: 45, color: 0x9a8a5a }),
  M("ogre_warlord", "Ogre Warlord", "Boss of an ogre den, scarred by a hundred fights.", { hp: 1500, damage: 32, cooldown: 1.4, speed: 2.0, size: 1.9, boss: true, humanoid: true, xp: 700, color: 0x7a3a2a }),
  M("drake_whelp", "Drake Whelp", "Young drakes. Breathe fire at 2 tiles.", { hp: 180, damage: 14, range: 2, cooldown: 1.2, speed: 3.0, sense: 12, size: 1.1, humanoid: false, loot: { gold: 25 }, xp: 40, color: 0xa0402a }),
  M("ancient_drake", "Ancient Drake", "Boss of a drake roost: a dragon as old as the hills, breathing fire at 3 tiles.", { hp: 3200, damage: 42, range: 3, cooldown: 1.5, speed: 2.6, sense: 14, size: 2.4, boss: true, humanoid: false, xp: 1500, color: 0x7a1a14 }),
];
for (const d of MONSTER_DEFS) UNIT_DEFS[d.type] = d;

/** Monster types (PvE). */
export const MONSTER_TYPES = MONSTER_DEFS.map((d) => d.type);

/** Creature types (wildlife). */
export const CREATURE_TYPES = Object.values(UNIT_DEFS).filter((d) => d.creature).map((d) => d.type);

/** What find_nearest() / scan() accept, with a description for the editor. */
export const FIND_KIND_INFO: Record<string, string> = {
  tree: "Trees (wood)",
  stone: "Stone deposits",
  gold: "Gold veins",
  berries: "Berry bushes (food)",
  storage: "Your completed storage buildings (deposit here)",
  construction: "Your unfinished buildings (build these)",
  ruin: "Ruins to investigate",
  creature: "Any wild animal",
  unit: "Your other units",
  enemy: "A unit you may attack right now (combat servers)",
  enemy_building: "A building you may attack right now (combat servers)",
  monster: "A PvE monster from a lair (goblins, spiders, ...)",
  boss: "A lair's boss monster",
  paddock: "Your completed paddock with room for another animal",
  ...Object.fromEntries(CREATURE_TYPES.map((t) => [t, `${UNIT_DEFS[t]?.name ?? t} (wild animal)`])),
  ...Object.fromEntries(MONSTER_TYPES.map((t) => [t, `${UNIT_DEFS[t]?.name ?? t} (monster)`])),
};
export const FIND_KINDS: readonly string[] = Object.keys(FIND_KIND_INFO);

/** The three units every new player starts with (exactly three). */
export const STARTING_UNITS: readonly string[] = ["woodcutter", "builder", "scout"];

export function findUnitDef(type: string): UnitDef | undefined {
  return Object.hasOwn(UNIT_DEFS, type) ? UNIT_DEFS[type] : undefined;
}

export function unitDef(type: string): UnitDef {
  const d = Object.hasOwn(UNIT_DEFS, type) ? UNIT_DEFS[type] : undefined;
  if (!d) throw new Error(`Unknown unit type '${type}'`);
  return d;
}
