import type { ResourceBag, ResourceType } from "./resources.ts";
import type { TileCode } from "./terrain.ts";

export interface BuildingDef {
  type: string;
  name: string;
  description: string;
  width: number;
  height: number;
  cost: Partial<ResourceBag>;
  /** Construction points required (a builder with buildRate 1 adds 1 point per second). */
  buildTime: number;
  maxHp: number;
  /** Can players place this building through the construction interface? */
  placeable: boolean;
  /** Acts as a deposit point for unit cargo. */
  storage: boolean;
  /** Storage buildings: total items held (all resources together), before research bonuses. */
  storageCapacity: number;
  /** Unit types this building can train. */
  trains: string[];
  /** Can research technologies. */
  research: boolean;
  /** Passive production in resource units per second (once complete). */
  produces: Partial<ResourceBag> | null;
  /** Terrain codes the whole footprint must sit on; null = any buildable terrain. */
  allowedTerrain: TileCode[] | null;
  /** Radius (tiles) of territory claimed around the building when completed. */
  influence: number;
  /**
   * Expansion buildings may be placed on unclaimed land near your territory
   * (within BALANCE.expansionRange tiles); all others must sit entirely inside it.
   */
  expansion: boolean;
  /** Gathering bonus for your units harvesting nodes within `radius` tiles. */
  aura: { resources: ResourceType[]; pct: number; radius: number } | null;
  /** Prerequisites checked at placement. */
  /** `combat`: only available when combat is enabled on the server. */
  requires: { buildings?: string[]; techs?: string[]; unlock?: string; combat?: boolean } | null;
  /** Extra chunks of vision around the building (interest management). */
  vision: number;
  /** Display colours: base wall, roof/accent. */
  colors: { base: number; roof: number; trim: number };
  /** Paddocks: how many tamed animals it holds. */
  pen?: number;
}

const B = (
  d: Omit<BuildingDef, "research" | "aura" | "requires" | "expansion" | "vision" | "storageCapacity"> &
    Partial<Pick<BuildingDef, "research" | "aura" | "requires" | "expansion" | "vision" | "storageCapacity">>,
): BuildingDef => ({
  storageCapacity: 0,
  research: false,
  aura: null,
  requires: null,
  expansion: false,
  vision: 0,
  ...d,
});

export const BUILDING_DEFS: Record<string, BuildingDef> = {
  town_hall: B({
    type: "town_hall",
    name: "Town Hall",
    description: "Centre of a settlement. Claims a large territory, stores resources and trains Workers. New Town Halls found new settlements.",
    width: 3,
    height: 3,
    cost: { wood: 200, stone: 100 },
    buildTime: 90,
    maxHp: 1000,
    placeable: true,
    storage: true,
    storageCapacity: 5000,
    trains: ["worker"],
    produces: null,
    allowedTerrain: null,
    influence: 12,
    expansion: true,
    requires: { unlock: "building:town_hall" },
    colors: { base: 0x8b6a43, roof: 0x9c2f2f, trim: 0xe0c070 },
  }),
  outpost: B({
    type: "outpost",
    name: "Outpost",
    description: "A frontier post. Can be built just outside your territory; when complete it claims the land around it and accepts deposits.",
    width: 2,
    height: 2,
    cost: { wood: 60, stone: 30 },
    buildTime: 25,
    maxHp: 400,
    placeable: true,
    storage: true,
    storageCapacity: 1500,
    trains: [],
    produces: null,
    allowedTerrain: null,
    influence: 8,
    expansion: true,
    colors: { base: 0x6a5a48, roof: 0x3d6f4a, trim: 0xd8c890 },
  }),
  stockpile: B({
    type: "stockpile",
    name: "Stockpile",
    description: "A covered yard where units can deposit cargo. Build near resources to shorten trips.",
    width: 2,
    height: 2,
    cost: { wood: 40 },
    buildTime: 12,
    maxHp: 300,
    placeable: true,
    storage: true,
    storageCapacity: 2000,
    trains: [],
    produces: null,
    allowedTerrain: null,
    influence: 3,
    colors: { base: 0x7a5a32, roof: 0x4f6f8f, trim: 0xcfae7a },
  }),
  farm: B({
    type: "farm",
    name: "Farm",
    description: "Produces food continuously once built. Fertile soil under the footprint increases output.",
    width: 3,
    height: 3,
    cost: { wood: 60 },
    buildTime: 20,
    maxHp: 250,
    placeable: true,
    storage: false,
    trains: [],
    produces: { food: 0.25 },
    allowedTerrain: [2, 6, 3],
    influence: 3,
    colors: { base: 0xa08040, roof: 0xd8c050, trim: 0x6a4a20 },
  }),
  lumber_camp: B({
    type: "lumber_camp",
    name: "Lumber Camp",
    description: "Storage for woodcutters. Your units harvest wood 25% faster from trees within 10 tiles.",
    width: 2,
    height: 2,
    cost: { wood: 50 },
    buildTime: 15,
    maxHp: 300,
    placeable: true,
    storage: true,
    storageCapacity: 1500,
    trains: [],
    produces: null,
    allowedTerrain: null,
    influence: 3,
    aura: { resources: ["wood"], pct: 0.25, radius: 10 },
    colors: { base: 0x6b4a28, roof: 0x8a5a2a, trim: 0xc89a5a },
  }),
  mine: B({
    type: "mine",
    name: "Mine",
    description: "Built on hills. Storage, trains Miners, and your units quarry stone and gold 25% faster within 10 tiles.",
    width: 2,
    height: 2,
    cost: { wood: 60, stone: 20 },
    buildTime: 20,
    maxHp: 450,
    placeable: true,
    storage: true,
    storageCapacity: 1500,
    trains: ["miner"],
    produces: null,
    allowedTerrain: [4],
    influence: 3,
    aura: { resources: ["stone", "gold"], pct: 0.25, radius: 10 },
    colors: { base: 0x5e5a56, roof: 0x3a3632, trim: 0xe5c040 },
  }),
  lodge: B({
    type: "lodge",
    name: "Lodge",
    description: "Trains Workers, Scouts, Haulers and Rangers.",
    width: 3,
    height: 3,
    cost: { wood: 100, stone: 40 },
    buildTime: 35,
    maxHp: 600,
    placeable: true,
    storage: false,
    trains: ["worker", "scout", "hauler", "ranger"],
    produces: null,
    allowedTerrain: null,
    influence: 5,
    colors: { base: 0x7d5c3a, roof: 0x2f5f8f, trim: 0xe8d8a8 },
  }),
  watchtower: B({
    type: "watchtower",
    name: "Watchtower",
    description: "Built from an ancient blueprint. Sees far across the land and claims territory around it.",
    width: 2,
    height: 2,
    cost: { wood: 60, stone: 40 },
    buildTime: 30,
    maxHp: 500,
    placeable: true,
    storage: false,
    trains: [],
    produces: null,
    allowedTerrain: null,
    influence: 6,
    expansion: true,
    vision: 2,
    requires: { unlock: "building:watchtower" },
    colors: { base: 0x7a7266, roof: 0x5a3a2a, trim: 0xd8c890 },
  }),
  library: B({
    type: "library",
    name: "Library",
    description: "Researches technologies that improve your civilisation and unlock new capabilities. Trains Clerics.",
    width: 3,
    height: 3,
    cost: { wood: 80, stone: 60, gold: 20 },
    buildTime: 40,
    maxHp: 500,
    placeable: true,
    storage: false,
    trains: ["cleric"],
    research: true,
    produces: null,
    allowedTerrain: null,
    influence: 4,
    requires: { buildings: ["lodge"] },
    colors: { base: 0xc8c0b0, roof: 0x5a3a8a, trim: 0xe5c040 },
  }),
  paddock: B({
    type: "paddock",
    name: "Paddock",
    description: "A fenced pasture for tamed animals (send one here, or let it walk in by itself). Each animal gives food or a bonus for your whole settlement, and pairs raise young while there is room.",
    width: 4,
    height: 4,
    cost: { wood: 80, stone: 20 },
    buildTime: 30,
    maxHp: 400,
    placeable: true,
    storage: false,
    trains: [],
    produces: null,
    allowedTerrain: null,
    influence: 3,
    pen: 8,
    colors: { base: 0x8a6a3a, roof: 0x6a8a3a, trim: 0xd8c890 },
  }),
  barracks: B({
    type: "barracks",
    name: "Barracks",
    description: "Battle training for your hero, and revives a fallen hero. Trains Soldiers, Archers and Knights when fighting is possible on the server (combat or PvE).",
    width: 3,
    height: 3,
    cost: { wood: 120, stone: 60 },
    buildTime: 40,
    maxHp: 800,
    placeable: true,
    storage: false,
    trains: ["soldier", "archer", "knight"],
    produces: null,
    allowedTerrain: null,
    influence: 4,
    requires: { buildings: ["lodge"] },
    colors: { base: 0x6a5040, roof: 0x8a2a2a, trim: 0xd0d0d0 },
  }),
};

export function findBuildingDef(type: string): BuildingDef | undefined {
  return Object.hasOwn(BUILDING_DEFS, type) ? BUILDING_DEFS[type] : undefined;
}

export function buildingDef(type: string): BuildingDef {
  const d = Object.hasOwn(BUILDING_DEFS, type) ? BUILDING_DEFS[type] : undefined;
  if (!d) throw new Error(`Unknown building type '${type}'`);
  return d;
}

/** Extra multiplier on farm output per fraction of fertile tiles under the footprint. */
export const FERTILE_BONUS = 0.6;
