/**
 * Registry of every function, namespace and constant visible to player scripts.
 *
 * This is the single source of truth used by:
 *  - the compiler (unknown-name and argument-count diagnostics),
 *  - the VM (dispatch: built-ins run inside the VM, queries/actions go to the host),
 *  - the server host (which implements queries and actions with validation),
 *  - the editor's command reference panel.
 *
 * "action" commands suspend the program until the simulation finishes the task.
 * "query" commands return immediately and never change authoritative state
 * (print() only appends to the unit's own log).
 */

export type CommandKind = "builtin" | "query" | "action";

export interface CommandDef {
  name: string;
  kind: CommandKind;
  minArgs: number;
  maxArgs: number;
  signature: string;
  returns: string;
  description: string;
  /** Instruction-budget cost charged when called (in addition to 1 for the CALL itself). */
  cost: number;
  category: CommandCategory;
  /** Unlock id required to use this command (e.g. "command:scan"); compile error otherwise. */
  requires?: string;
  /** How to unlock it, shown in diagnostics and the reference. */
  lockedHint?: string;
}

/** Reference sections, in display order. Every command belongs to one of them. */
export const COMMAND_CATEGORIES = ["Actions", "World queries", "Hero", "Creatures", "Combat", "Unit", "Built-ins"] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

const C = (d: CommandDef): CommandDef => d;

export const COMMANDS: readonly CommandDef[] = [
  // ---- actions (suspend until complete) ----
  C({ name: "move_to", kind: "action", minArgs: 1, maxArgs: 2, signature: "move_to(target) / move_to(x, y)", returns: "True if arrived, False if unreachable", description: "Walk next to a target object, or onto tile (x, y).", cost: 20, category: "Actions" }),
  C({ name: "harvest", kind: "action", minArgs: 1, maxArgs: 1, signature: "harvest(node)", returns: "amount gathered (0 on failure)", description: "Walk to a resource node and gather until the inventory is full or the node is exhausted.", cost: 20, category: "Actions" }),
  C({ name: "deposit", kind: "action", minArgs: 0, maxArgs: 1, signature: "deposit() / deposit(storage)", returns: "True if cargo was stored", description: "Carry all cargo to the nearest completed storage building you own (or the given one) and store it. With storage networks, a full building is skipped by deposit(); deposit(storage) fails if that building is full.", cost: 20, category: "Actions" }),
  C({ name: "deposit_at_nearest_storage", kind: "action", minArgs: 0, maxArgs: 0, signature: "deposit_at_nearest_storage()", returns: "True if cargo was stored", description: "Same as deposit().", cost: 20, category: "Actions" }),
  C({ name: "withdraw", kind: "action", minArgs: 1, maxArgs: 3, signature: 'withdraw(resource) / withdraw(resource, amount) / withdraw(resource, amount, storage)', returns: "amount taken (0 on failure)", description: "Walk to your nearest storage (or the given one) and take resources from your stock into this unit's inventory (up to its free capacity). With storage networks, the nearest storage holding that resource is used, and the amount comes out of that building's network.", cost: 20, category: "Actions" }),
  C({ name: "build", kind: "action", minArgs: 1, maxArgs: 1, signature: "build(site)", returns: "True when the building is complete", description: "Walk to one of your construction sites and work on it until it is finished.", cost: 20, category: "Actions" }),
  C({ name: "explore", kind: "action", minArgs: 0, maxArgs: 0, signature: "explore()", returns: "True if the leg was completed", description: "Walk 8-16 tiles in a direction that tends away from your settlement.", cost: 20, category: "Actions" }),
  C({ name: "place", kind: "action", minArgs: 2, maxArgs: 3, signature: 'place(type, x, y) / place(type, [x, y])', returns: "construction site object, or None if the placement was rejected (reason in the log)", description: "Place a construction site and pay its cost. Same rules as placing from the build menu.", cost: 20, category: "Actions" }),
  C({ name: "train_unit", kind: "action", minArgs: 1, maxArgs: 1, signature: 'train_unit(type)', returns: "True if queued", description: "Queue a unit (e.g. \"worker\") at your nearest completed building that trains it, paying its cost.", cost: 20, category: "Actions" }),
  C({ name: "wander", kind: "action", minArgs: 0, maxArgs: 1, signature: "wander(radius=8)", returns: "True if the stroll was completed", description: "Walk to a random reachable spot within `radius` tiles (of home, for creatures).", cost: 20, category: "Actions" }),
  C({ name: "investigate", kind: "action", minArgs: 1, maxArgs: 1, signature: "investigate(ruin)", returns: "name of the discovery read, or None", description: 'Search ruins from find_nearest("ruin"): salvage resources (once per ruin) and read its inscription.', cost: 20, category: "Actions" }),
  C({ name: "observe", kind: "action", minArgs: 1, maxArgs: 1, signature: "observe(creature)", returns: "True once the species' behaviour is understood", description: "Watch a wild creature from within 6 tiles until its behaviour is understood (needed before taming).", cost: 20, category: "Creatures" }),
  C({ name: "tame", kind: "action", minArgs: 1, maxArgs: 1, signature: "tame(creature)", returns: "True if the creature joined you", description: "Tame an observed wild creature. This unit must carry the food it costs (see withdraw()).", cost: 20, category: "Creatures" }),
  C({ name: "train_creature", kind: "action", minArgs: 2, maxArgs: 2, signature: 'train_creature(creature, "guard")', returns: "True when learned", description: "Teach one of your tamed creatures a new ability. This unit must carry the food it costs.", cost: 20, category: "Creatures" }),
  C({ name: "follow", kind: "action", minArgs: 1, maxArgs: 2, signature: "follow(target, seconds=30)", returns: "True if it kept up", description: "Stay close to another unit or creature (units with the follow ability, e.g. tamed wolves).", cost: 20, category: "Creatures" }),
  C({ name: "guard", kind: "action", minArgs: 2, maxArgs: 3, signature: "guard(x, y, seconds=60)", returns: "True when the watch ends", description: "Stand guard near a tile; wild creatures will not forage within 8 tiles (needs the guard ability).", cost: 20, category: "Creatures" }),
  C({ name: "pen", kind: "action", minArgs: 1, maxArgs: 1, signature: "pen(paddock)", returns: "True once inside", description: 'Tamed animals only: walk into one of your paddocks (find_nearest("paddock") finds one with room) and live there. Animals in a paddock give food or bonuses, raise young, and stop running their program.', cost: 20, category: "Creatures" }),
  C({ name: "go_home", kind: "action", minArgs: 0, maxArgs: 0, signature: "go_home()", returns: "True when back home", description: "Walk back to this unit's home (wild creatures, monsters and tamed animals have one).", cost: 20, category: "Creatures" }),
  C({ name: "attack", kind: "action", minArgs: 1, maxArgs: 1, signature: "attack(target)", returns: "True when the target is defeated or destroyed, False if it got away or cannot be attacked", description: 'Fight a unit, creature or building until it falls. Lair monsters (find_nearest("monster")) can be fought whenever PvE is on (the default). Fighting other players needs combat enabled on the server and both players opted in to PvP; hunting wild animals needs combat enabled. Targets: find_nearest("monster"), find_nearest("enemy"), find_nearest("enemy_building"), a creature, or last_attacker().', cost: 20, category: "Combat" }),
  C({ name: "repair", kind: "action", minArgs: 1, maxArgs: 1, signature: "repair(building)", returns: "True when fully repaired", description: "Restore a damaged building's health. A full repair costs half the building's price, paid as the work is done.", cost: 20, category: "Combat" }),
  C({ name: "flee", kind: "action", minArgs: 1, maxArgs: 1, signature: "flee(target)", returns: "True if the unit got away", description: "Run about 10 tiles directly away from a unit or object.", cost: 20, category: "Combat" }),
  C({ name: "wait", kind: "action", minArgs: 0, maxArgs: 1, signature: "wait(seconds=1)", returns: "None", description: "Do nothing for up to 60 seconds.", cost: 5, category: "Actions" }),

  // ---- world queries ----
  C({ name: "find_nearest", kind: "query", minArgs: 1, maxArgs: 1, signature: 'find_nearest(kind)', returns: "object or None", description: 'Nearest object of a kind within sensing range: "tree", "stone", "gold", "berries", "storage" (your completed storage), "construction" (your unfinished buildings), "paddock" (your paddock with room), "ruin", "creature" (any wild animal), a species such as "deer" or "sheep", "monster" or "boss" (lair monsters), "enemy", or "unit" (your other units).', cost: 40, category: "World queries" }),
  C({ name: "scan", kind: "query", minArgs: 1, maxArgs: 1, signature: "scan(kind)", returns: "list of up to 10 objects, nearest first", description: "Everything of a kind within sensing range (same kinds as find_nearest).", cost: 80, category: "World queries", requires: "command:scan", lockedHint: "Discover the Surveyor's Lens by investigating ruins" }),
  C({ name: "distance_to", kind: "query", minArgs: 1, maxArgs: 2, signature: "distance_to(target) / distance_to(x, y)", returns: "number of tiles", description: "Tile distance (king moves) from this unit to a target or tile.", cost: 2, category: "World queries" }),
  C({ name: "exists", kind: "query", minArgs: 1, maxArgs: 1, signature: "exists(target)", returns: "True/False", description: "Whether an object returned earlier still exists.", cost: 4, category: "World queries" }),
  C({ name: "stock", kind: "query", minArgs: 1, maxArgs: 1, signature: 'stock(resource)', returns: "number", description: 'Your stored amount of "wood", "stone", "gold" or "food" (with storage networks: the total across all your storage buildings).', cost: 2, category: "World queries" }),
  C({ name: "stock_all", kind: "query", minArgs: 0, maxArgs: 0, signature: "stock_all()", returns: "dict", description: 'All your stored resources, e.g. {"wood": 120, "stone": 40, ...}.', cost: 4, category: "World queries" }),
  C({ name: "find_build_spot", kind: "query", minArgs: 1, maxArgs: 1, signature: "find_build_spot(type)", returns: "[x, y] or None", description: "Nearest valid placement for a building type within 10 tiles of this unit (checks terrain, occupancy and territory, not cost).", cost: 300, category: "World queries" }),
  C({ name: "count_units", kind: "query", minArgs: 0, maxArgs: 1, signature: "count_units() / count_units(type)", returns: "number", description: "How many units you own (optionally of one type), including units queued for training.", cost: 4, category: "World queries" }),
  C({ name: "use_ability", kind: "action", minArgs: 1, maxArgs: 3, signature: 'use_ability(name) / use_ability(name, target) / use_ability(name, x, y)', returns: "True if the ability was used, False otherwise (reason in the log)", description: 'Heroes only: use one of your hero\'s abilities, e.g. use_ability("rally"). Some need a target unit (use_ability("arcane_bolt", enemy)) or a tile (use_ability("shadowstep", x, y)). Abilities that hurt others need combat enabled on the server. The cooldown starts only if it worked.', cost: 20, category: "Hero" }),
  C({ name: "ability_ready", kind: "query", minArgs: 1, maxArgs: 1, signature: "ability_ready(name)", returns: "True/False", description: "Heroes only: whether this hero has that ability and it is off cooldown (and usable on this server).", cost: 2, category: "Hero" }),
  C({ name: "hero", kind: "query", minArgs: 0, maxArgs: 0, signature: "hero()", returns: "your hero object, or None", description: "Your hero, wherever it is (None if not recruited or fallen). Any of your units can ask, e.g. follow(hero()).", cost: 4, category: "Hero" }),
  C({ name: "last_attacker", kind: "query", minArgs: 0, maxArgs: 0, signature: "last_attacker()", returns: "unit object or None", description: "The unit that hit this unit in the last 10 seconds, if it can still be fought back.", cost: 4, category: "Combat" }),
  C({ name: "can_attack", kind: "query", minArgs: 1, maxArgs: 1, signature: "can_attack(target)", returns: "True/False", description: "Whether this unit may attack the target right now (combat enabled, PvP opt-in on both sides, a unit that can fight).", cost: 4, category: "Combat" }),
  C({ name: "in_contested_zone", kind: "query", minArgs: 0, maxArgs: 2, signature: "in_contested_zone() / in_contested_zone(target) / in_contested_zone(x, y)", returns: "True/False", description: "Whether this unit (or a target, or a tile) is inside a contested zone, where PvP is always on. Always False when combat is disabled.", cost: 4, category: "Combat" }),
  C({ name: "storage_contents", kind: "query", minArgs: 1, maxArgs: 1, signature: "storage_contents(storage)", returns: "dict", description: 'What one of your storage buildings holds, e.g. {"wood": 120, ...}, plus "capacity" and "free". With shared storage (the default) buildings hold nothing themselves: stock() is your whole stock.', cost: 4, category: "World queries" }),
  C({ name: "storage_mode", kind: "query", minArgs: 0, maxArgs: 0, signature: "storage_mode()", returns: '"shared" or "networks"', description: 'How this server stores resources: "shared" (one stock usable anywhere) or "networks" (each storage building holds its own; costs are paid from storage near the work).', cost: 1, category: "World queries" }),
  C({ name: "distance_to_home", kind: "query", minArgs: 0, maxArgs: 0, signature: "distance_to_home()", returns: "number of tiles (0 without a home)", description: "How far this unit is from its home (see go_home()).", cost: 2, category: "Creatures" }),
  C({ name: "time", kind: "query", minArgs: 0, maxArgs: 0, signature: "time()", returns: "number", description: "Game time in seconds.", cost: 1, category: "World queries" }),
  C({ name: "print", kind: "query", minArgs: 0, maxArgs: 16, signature: "print(...)", returns: "None", description: "Write a line to this unit's log (visible in the unit panel).", cost: 5, category: "Unit" }),

  // ---- built-ins (pure, run inside the VM) ----
  C({ name: "len", kind: "builtin", minArgs: 1, maxArgs: 1, signature: "len(x)", returns: "number", description: "Length of a list, string or range.", cost: 1, category: "Built-ins" }),
  C({ name: "range", kind: "builtin", minArgs: 1, maxArgs: 3, signature: "range(stop) / range(start, stop[, step])", returns: "range", description: "Integer sequence for for-loops.", cost: 1, category: "Built-ins" }),
  C({ name: "abs", kind: "builtin", minArgs: 1, maxArgs: 1, signature: "abs(n)", returns: "number", description: "Absolute value.", cost: 1, category: "Built-ins" }),
  C({ name: "min", kind: "builtin", minArgs: 1, maxArgs: 8, signature: "min(a, b, ...) / min(list)", returns: "value", description: "Smallest value.", cost: 2, category: "Built-ins" }),
  C({ name: "max", kind: "builtin", minArgs: 1, maxArgs: 8, signature: "max(a, b, ...) / max(list)", returns: "value", description: "Largest value.", cost: 2, category: "Built-ins" }),
  C({ name: "int", kind: "builtin", minArgs: 1, maxArgs: 1, signature: "int(x)", returns: "number", description: "Truncate to an integer (or parse a string).", cost: 1, category: "Built-ins" }),
  C({ name: "str", kind: "builtin", minArgs: 1, maxArgs: 1, signature: "str(x)", returns: "string", description: "Convert to text.", cost: 1, category: "Built-ins" }),
  C({ name: "round", kind: "builtin", minArgs: 1, maxArgs: 1, signature: "round(n)", returns: "number", description: "Round to the nearest integer.", cost: 1, category: "Built-ins" }),
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

export function commandDef(name: string): CommandDef | undefined {
  return BY_NAME.get(name);
}

/** Namespaces exposed as globals; attribute access is resolved by the host. */
export interface NamespaceMember {
  name: string;
  /** "method" members are called with (); "value" members are read directly. */
  type: "method" | "value";
  signature: string;
  description: string;
}

export const NAMESPACES: Record<string, NamespaceMember[]> = {
  inventory: [
    { name: "is_full", type: "method", signature: "inventory.is_full()", description: "True when carrying capacity is reached." },
    { name: "is_empty", type: "method", signature: "inventory.is_empty()", description: "True when carrying nothing." },
    { name: "total", type: "method", signature: "inventory.total()", description: "Total items carried." },
    { name: "count", type: "method", signature: 'inventory.count("wood")', description: "Amount of one resource carried." },
    { name: "capacity", type: "method", signature: "inventory.capacity()", description: "Maximum items this unit can carry." },
    { name: "free", type: "method", signature: "inventory.free()", description: "Remaining carrying space." },
  ],
  me: [
    { name: "x", type: "value", signature: "me.x", description: "This unit's tile x coordinate." },
    { name: "y", type: "value", signature: "me.y", description: "This unit's tile y coordinate." },
    { name: "id", type: "value", signature: "me.id", description: "This unit's id." },
    { name: "type", type: "value", signature: "me.type", description: 'Unit type, e.g. "woodcutter".' },
    { name: "hp", type: "value", signature: "me.hp", description: "This unit's current health." },
    { name: "max_hp", type: "value", signature: "me.max_hp", description: "This unit's maximum health." },
  ],
};

/** Attributes readable on objects returned by queries (resource nodes, buildings). */
export const OBJECT_ATTRIBUTES: Record<string, string> = {
  id: "Object id",
  kind: 'Kind, e.g. "tree" or "stockpile"',
  x: "Tile x coordinate",
  y: "Tile y coordinate",
  amount: "Remaining resource amount (resource nodes) or None",
};

/** Global constants. */
export const CONSTANTS: Record<string, string> = {
  alive: "True while this unit exists. Use 'while alive:' for a unit's main loop.",
};

export function isKnownGlobal(name: string): boolean {
  return BY_NAME.has(name) || isNamespace(name) || isConstant(name);
}

/** Own-property checks: never use `in` with player-supplied names (prototype keys like "constructor"). */
export function isNamespace(name: string): boolean {
  return Object.hasOwn(NAMESPACES, name);
}

export function isConstant(name: string): boolean {
  return Object.hasOwn(CONSTANTS, name);
}
