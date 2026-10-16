import { chebyshev, chunkKey, distToRect, facingFromDelta, floorDiv, isSafeCoord } from "../shared/coords.ts";
import { BALANCE } from "../shared/defs/balance.ts";
import { FERTILE_BONUS, buildingDef, findBuildingDef } from "../shared/defs/buildings.ts";
import { NODE_DEFS, RESOURCE_TYPES, bagTotal, emptyBag, isNodeKind, isResourceType, type NodeKind, type ResourceBag, type ResourceType } from "../shared/defs/resources.ts";
import { TECH_DEFS, findTechDef } from "../shared/defs/techs.ts";
import { findTalentDef } from "../shared/defs/talents.ts";
import { raceDef } from "../shared/defs/races.ts";
import { MAX_XP, XP_AWARDS, levelForXp, talentPointsForLevel } from "../shared/defs/progression.ts";
import type { StatKey } from "../shared/defs/effects.ts";
import { Tile, terrainDef } from "../shared/defs/terrain.ts";
import { STARTING_UNITS, findUnitDef, unitDef, CREATURE_TYPES, MONSTER_TYPES } from "../shared/defs/units.ts";
import { LAIR_CLAIM_MINUTES, LAIR_DEFS, LAIR_LEASH, findTrophyDef, type LairDef } from "../shared/defs/lairs.ts";
import { Lairs, LAIR_SPAWN_CLEARANCE, type Lair } from "../shared/lairs.ts";
import { LESSONS, sourceFeatures, type LessonEvent, type SourceFeatures } from "../shared/defs/lessons.ts";
import { HERO_BUILDINGS, HERO_LEVEL_SCALING, HERO_RECRUIT_COST, HERO_RECRUIT_SECONDS, HERO_TRAINING, findAbility, heroDefForRace, heroDefForType, heroReviveBase, heroTrainingCost, type AbilityDef, type BuffSpec, type HeroDef } from "../shared/defs/heroes.ts";
import { RUIN_LOOT, findDiscoveryDef } from "../shared/defs/discoveries.ts";
import { SeededRandom, hashString } from "../shared/rng.ts";
import { WorldGenerator, type GeneratedCreature, type WorldGenParams } from "../shared/worldgen.ts";
import { compileSource } from "../script/compiler.ts";
import { VM, type ActionRequest } from "../script/vm.ts";
import { ListValue, ObjectRef, repr, type Value } from "../script/values.ts";
import { ChunkStore } from "./chunks.ts";
import { Modifiers } from "./modifiers.ts";
import { Territory } from "./territory.ts";
import { findPath, type Rect } from "./pathfinding.ts";
import { CoarseMap } from "./coarse.ts";
import { ContestedZones, ZONE_SPAWN_CLEARANCE, type ContestedZone } from "../shared/zones.ts";
import { OVERVIEW_SAMPLES } from "../shared/protocol.ts";
import { UnitScriptHost } from "./scriptHost.ts";
import { PhaseTimes } from "./phaseTimes.ts";
import {
  fail,
  ok,
  type Activity,
  type Buff,
  type BuildingState,
  type CommandResult,
  type TrainOrder,
  newHeroState,
  type PlayerState,
  type Task,
  type TaskResult,
  type UnitState,
  NEUTRAL,
} from "./types.ts";

export interface SimConfig {
  tickRate: number;
  /** Instruction budget per unit per tick. */
  scriptOpsPerUnitTick: number;
  /** Instruction budget for all scripts in one tick; remaining units are deferred round-robin. */
  scriptOpsPerTick: number;
  /** Pathfinding search radius in tiles. */
  pathRadius: number;
  /** Largest absolute tile coordinate accepted from clients and scripts. */
  maxCoordinate: number;
  maxCachedChunks: number;
  /** Combat is off unless the server enables it (config `combat.enabled`). */
  combatEnabled: boolean;
  /** Seconds a player stays attackable after opting out of PvP (and after their last fight). */
  pvpOptOutSeconds: number;
  /** Contested zones (PvP for everyone inside) are active when combat is enabled and this is true. */
  contestedZones: boolean;
  /**
   * PvE: units may fight lair monsters (and monsters fight intruders) even when PvP
   * combat is off. Config `combat.pve` (default true).
   */
  pveEnabled: boolean;
  /**
   * "shared": one stock per player usable anywhere (the original rule).
   * "networks": each storage building holds its own resources; costs are paid from the
   * storage network serving the place, so resources must be hauled where they are needed.
   */
  storageMode: StorageMode;
  /** Server-wide ceilings on the research-raised unit and building limits (performance protection). */
  unitLimitCeiling: number;
  buildingLimitCeiling: number;
}

export type StorageMode = "shared" | "networks";

export const DEFAULT_SIM_CONFIG: SimConfig = {
  tickRate: 10,
  scriptOpsPerUnitTick: 400,
  scriptOpsPerTick: 200_000,
  pathRadius: 48,
  maxCoordinate: 1_000_000,
  maxCachedChunks: 512,
  combatEnabled: false,
  pvpOptOutSeconds: 120,
  contestedZones: true,
  pveEnabled: true,
  storageMode: "shared",
  unitLimitCeiling: 300,
  buildingLimitCeiling: 400,
};

export class ChangeSet {
  units = new Set<number>();
  buildings = new Set<number>();
  players = new Set<number>();
  removedUnits = new Set<number>();
  removedBuildings = new Set<number>();
  clear(): void {
    this.units.clear();
    this.buildings.clear();
    this.players.clear();
    this.removedUnits.clear();
    this.removedBuildings.clear();
  }
}

export interface AuditEvent {
  tick: number;
  playerId: number;
  action: string;
  detail: string;
}

export type ManualCommand =
  | { kind: "move"; x: number; y: number }
  | { kind: "gather"; x: number; y: number }
  | { kind: "build"; buildingId: number }
  | { kind: "deposit" }
  | { kind: "stop" }
  | { kind: "investigate"; x: number; y: number }
  | { kind: "observe" | "tame"; targetId: number }
  | { kind: "attack"; targetId: number }
  | { kind: "attack_building" | "repair"; buildingId: number }
  | { kind: "pen"; buildingId: number };

/** Runtime state of a lair that has been woken (absent: dormant, never spawned). */
export interface LairState {
  id: string;
  status: "active" | "cleared";
  /** Player who killed its last monster, and when. */
  clearedBy: number | null;
  clearedTick: number | null;
  /** A cleared lair is reoccupied at this tick unless its centre is someone's territory. */
  respawnTick: number | null;
  /** Until this tick only `clearedBy` may build in the lair (and Outposts may be placed there however far from their land). */
  claimUntil: number | null;
}

export type ProgramControl = "run" | "pause" | "resume" | "stop";

const LOG_LIMIT = 40;
const TRACE_LIMIT = 20;
const AVOID_TICKS_SECONDS = 60;

/**
 * The authoritative game simulation. Pure in-memory state plus deterministic rules;
 * it knows nothing about sockets or databases. The server feeds it validated
 * commands, calls step() at the configured tick rate, and reads change sets to
 * broadcast updates and persist state.
 */
export class World {
  readonly cfg: SimConfig;
  readonly gen: WorldGenerator;
  readonly chunks: ChunkStore;
  tick = 0;
  nextId = 1;
  readonly players = new Map<number, PlayerState>();
  readonly units = new Map<number, UnitState>();
  readonly buildings = new Map<number, BuildingState>();
  /** Building occupancy keyed by tileNum(x, y). */
  private readonly buildingTiles = new Map<number, number>();
  private readonly unitsByChunk = new Map<string, Set<number>>();
  private readonly buildingsByChunk = new Map<string, Set<number>>();
  private readonly unitsByOwner = new Map<number, Set<number>>();
  private readonly buildingsByOwner = new Map<number, Set<number>>();
  /** Changes since the last network broadcast. */
  readonly net = new ChangeSet();
  /** Changes since the last persistence flush. */
  readonly persist = new ChangeSet();
  audit: AuditEvent[] = [];
  readonly territory: Territory;
  /** Contested zone geometry (deterministic from the seed). Only matters when `zonesActive`. */
  readonly zones: ContestedZones;
  /** PvE lairs (positions are a pure function of the seed; generation v3+). */
  readonly lairs: Lairs;
  /** Lairs that have been woken (persisted). */
  readonly lairState = new Map<string, LairState>();
  /** Lairs whose state changed (broadcast to clients, then cleared by the server). */
  readonly lairNet = new Set<string>();
  /** Lairs whose state changed since the last save (persisted, then cleared). */
  readonly lairDirty = new Set<string>();
  private modsCache = new Map<number, Modifiers>();
  /** Newly explored chunks per player since the last flush. */
  exploredNew: { playerId: number; key: string }[] = [];
  /** Level-ups since the last broadcast (for notifications). */
  levelUps: { playerId: number; level: number }[] = [];
  private xpAcc = new Map<number, number>();
  private xpDirty = new Set<number>();
  /** Chunks whose wildlife has been spawned (persisted so creatures are not re-spawned). */
  readonly populated = new Set<string>();
  populatedNew: string[] = [];
  /** Chunks that became active and still need their wildlife (processed a few per tick). */
  private pendingSpawns: string[] = [];
  /** Creature spawns of generated, not yet populated chunks (a cache; regenerated if dropped). */
  private spawnLists = new Map<string, GeneratedCreature[]>();
  /** Wildlife renewal: active chunks in round-robin order, last renewal per chunk, cached spawn templates. */
  private renewList: string[] = [];
  private renewCursor = 0;
  private lastRenewal = new Map<string, number>();
  private spawnTemplates = new Map<string, GeneratedCreature[]>();
  /** Ruins whose salvage has been taken ("x,y"). */
  readonly lootedRuins = new Set<string>();
  /** Ruin changes since the last broadcast and since the last flush. */
  ruinChanges: { x: number; y: number }[] = [];
  lootedNew: { x: number; y: number; playerId: number }[] = [];
  /** Chunks near any player's presence; wildlife elsewhere is dormant. */
  private activeChunks = new Set<string>();
  private guardZones: { x: number; y: number }[] = [];
  /** Minimap terrain samples per chunk (deterministic, so safe to cache forever; bounded). */
  private overviewCache = new Map<string, Uint8Array>();
  /** Messages for players (deaths, destruction, PvP changes), drained by the server each broadcast. */
  notices: { playerId: number; kind: "info" | "error" | "success"; text: string }[] = [];
  /** Players whose public combat status changed (owner info must be re-sent). */
  readonly ownersChanged = new Set<number>();
  /** Units and buildings with active ability effects (checked once a second for expiry). */
  private readonly buffedUnits = new Set<number>();
  private readonly buffedBuildings = new Set<number>();
  /** Farsight: areas a player can see (and detect hidden units in) for a while. */
  reveals: { owner: number; x: number; y: number; radius: number; until: number }[] = [];
  /** Last "under attack" warning per player (tick), to avoid flooding. */
  private attackWarned = new Map<number, number>();
  /** Players who lost a unit or building this tick (checked for re-founding). */
  private eliminationCheck = new Set<number>();
  /** Where a chased unit was when the chaser's current path was planned (transient). */
  private chaseAim = new Map<number, { x: number; y: number }>();
  private scriptCursor = 0;
  private wideSearchesThisTick = 0;
  private wideMsThisTick = 0;
  private pathMsThisTick = 0;
  // Long-range planning must not generate chunks across half the map: use generator terrain where not cached.
  private readonly coarse = new CoarseMap((x, y) => isSafeCoord(x, this.cfg.maxCoordinate) && isSafeCoord(y, this.cfg.maxCoordinate) && this.chunks.approxPassable(x, y) && !this.buildingTiles.has(tileNum(x, y)));
  /** Per-phase tick timings over the last few hundred ticks (admin status). */
  readonly tickPhases = new PhaseTimes();
  readonly stats = { lastTickMs: 0, maxTickMs: 0, scriptOps: 0, scriptUnitsRun: 0, scriptUnitsDeferred: 0, pathSearches: 0, pathFailures: 0, coarseSearches: 0, internalErrors: 0 };
  /**
   * Receives internal errors that were contained (a bug in one unit's or building's update).
   * The server routes this to its log; the default prints to stderr so nothing is silent.
   */
  onInternalError: (msg: string, err: unknown) => void = (msg, err) => console.error(msg, err);

  constructor(params: WorldGenParams, cfg: Partial<SimConfig> = {}) {
    this.cfg = { ...DEFAULT_SIM_CONFIG, ...cfg };
    validateSimConfig(this.cfg);
    this.gen = new WorldGenerator(params);
    this.chunks = new ChunkStore(this.gen, this.cfg.maxCachedChunks, () => this.tick, this.cfg.tickRate);
    this.territory = new Territory(this.gen.params.chunkSize);
    this.zones = new ContestedZones(params.seed, (x, y) => terrainDef(this.gen.terrainAt(x, y)).passable);
    // Lairs sit on land outside contested zones (both checks are pure functions of the seed).
    this.lairs = new Lairs(params.seed, params.generationVersion >= 3, (x, y) => {
      const t = this.gen.terrainAt(x, y);
      return terrainDef(t).passable && t !== Tile.Sand && this.zones.at(x, y) === null;
    });
    // Remember generated creature spawns; chunks are only populated once a player is nearby.
    this.chunks.onGenerated = (g) => {
      const key = chunkKey(g.cx, g.cy);
      if (this.populated.has(key)) return;
      if (this.spawnLists.size >= 20_000) this.spawnLists.clear();
      this.spawnLists.set(key, g.creatures);
    };
  }

  // ------------------------------------------------------------------ modifiers (research, race, talents)

  /** Aggregated effects for a player (cached; invalidated when a source changes). */
  mods(playerId: number): Modifiers {
    let m = this.modsCache.get(playerId);
    if (!m) {
      m = new Modifiers();
      const p = this.players.get(playerId);
      if (p) {
        m.apply(raceDef(p.race)?.passives ?? []);
        for (const t of p.techs) m.apply(findTechDef(t)?.effects ?? []);
        for (const [id, rank] of Object.entries(p.talents)) m.apply(findTalentDef(id)?.effects ?? [], rank);
        for (const d of p.discoveries) m.apply(findDiscoveryDef(d)?.effects ?? []);
        for (const [track, rank] of Object.entries(p.hero.ranks)) m.apply(HERO_TRAINING[track]?.effects ?? [], rank);
        for (const t of p.trophies) m.apply(findTrophyDef(t)?.effects ?? []);
        // Animals in paddocks: each species' bonus counts its animals up to a cap.
        for (const [type, n] of this.pennedCounts(playerId)) {
          const bonus = findUnitDef(type)?.creature?.paddock?.bonus;
          if (!bonus) continue;
          const k = Math.min(n, bonus.maxAnimals);
          if (bonus.pct) m.apply([{ stat: bonus.stat, pct: bonus.pct }], k);
          if (bonus.add) m.apply([{ stat: bonus.stat, add: bonus.add }], k);
        }
      }
      this.modsCache.set(playerId, m);
    }
    return m;
  }

  invalidateMods(playerId: number): void {
    this.modsCache.delete(playerId);
  }

  stat(playerId: number, stat: StatKey, base: number): number {
    return this.mods(playerId).value(stat, base);
  }

  capacity(u: UnitState): number {
    return Math.round(this.stat(u.owner, "capacity", unitDef(u.type).capacity));
  }

  scaledCost(playerId: number, cost: Partial<ResourceBag>, stat: StatKey): ResourceBag {
    const f = this.mods(playerId).factor(stat);
    const out = emptyBag();
    for (const r of RESOURCE_TYPES) out[r] = Math.ceil((cost[r] ?? 0) * f);
    return out;
  }

  buildingMaxHp(b: BuildingState): number {
    return Math.round(this.stat(b.owner, "buildingHp", buildingDef(b.type).maxHp));
  }

  /** Seconds to train a unit or research a tech for a player. */
  orderTime(playerId: number, order: TrainOrder | { kind: "unit"; unitType: string } | { kind: "tech"; techId: string }): number {
    if (order.kind === "unit") return this.stat(playerId, "trainTime", unitDef(order.unitType).trainTime);
    if (order.kind === "hero" || order.kind === "hero_training") return order.time;
    return this.stat(playerId, "researchTime", findTechDef(order.techId)?.time ?? 1);
  }

  // ------------------------------------------------------------------ indices & change tracking

  markUnit(u: UnitState): void {
    if (!this.units.has(u.id)) return; // removed (killed) this tick
    u.rev++;
    this.net.units.add(u.id);
    this.persist.units.add(u.id);
  }
  markBuilding(b: BuildingState): void {
    if (!this.buildings.has(b.id)) return; // destroyed this tick
    b.rev++;
    this.net.buildings.add(b.id);
    this.persist.buildings.add(b.id);
  }
  markPlayer(p: PlayerState): void {
    this.net.players.add(p.id);
    this.persist.players.add(p.id);
  }

  private indexUnit(u: UnitState): void {
    const k = chunkKey(floorDiv(u.x, this.chunks.size), floorDiv(u.y, this.chunks.size));
    let s = this.unitsByChunk.get(k);
    if (!s) this.unitsByChunk.set(k, (s = new Set()));
    s.add(u.id);
    let o = this.unitsByOwner.get(u.owner);
    if (!o) this.unitsByOwner.set(u.owner, (o = new Set()));
    o.add(u.id);
  }
  private unindexUnitChunk(u: UnitState): void {
    const k = chunkKey(floorDiv(u.x, this.chunks.size), floorDiv(u.y, this.chunks.size));
    const s = this.unitsByChunk.get(k);
    if (s) {
      s.delete(u.id);
      if (s.size === 0) this.unitsByChunk.delete(k);
    }
  }
  private moveUnitTo(u: UnitState, x: number, y: number): void {
    const size = this.chunks.size;
    const changedChunk = floorDiv(u.x, size) !== floorDiv(x, size) || floorDiv(u.y, size) !== floorDiv(y, size);
    if (changedChunk) this.unindexUnitChunk(u);
    u.facing = facingFromDelta(x - u.x, y - u.y);
    u.x = x;
    u.y = y;
    if (changedChunk) {
      this.indexUnit(u);
      this.noteExplored(u);
    }
  }

  private indexBuilding(b: BuildingState): void {
    const size = this.chunks.size;
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        this.buildingTiles.set(tileNum(x, y), b.id);
        const k = chunkKey(floorDiv(x, size), floorDiv(y, size));
        let s = this.buildingsByChunk.get(k);
        if (!s) this.buildingsByChunk.set(k, (s = new Set()));
        s.add(b.id);
      }
    }
    let o = this.buildingsByOwner.get(b.owner);
    if (!o) this.buildingsByOwner.set(b.owner, (o = new Set()));
    o.add(b.id);
  }

  unitsInChunk(key: string): ReadonlySet<number> {
    return this.unitsByChunk.get(key) ?? EMPTY;
  }
  buildingsInChunk(key: string): ReadonlySet<number> {
    return this.buildingsByChunk.get(key) ?? EMPTY;
  }
  unitsOf(owner: number): ReadonlySet<number> {
    return this.unitsByOwner.get(owner) ?? EMPTY;
  }
  buildingsOf(owner: number): ReadonlySet<number> {
    return this.buildingsByOwner.get(owner) ?? EMPTY;
  }

  /** Chunks containing at least one entity owned by the player. */
  presenceChunks(owner: number): Set<string> {
    const size = this.chunks.size;
    const out = new Set<string>();
    for (const id of this.unitsOf(owner)) {
      const u = this.units.get(id);
      if (u) out.add(chunkKey(floorDiv(u.x, size), floorDiv(u.y, size)));
    }
    for (const id of this.buildingsOf(owner)) {
      const b = this.buildings.get(id);
      if (b) out.add(chunkKey(floorDiv(b.x, size), floorDiv(b.y, size)));
    }
    for (const r of this.reveals) if (r.owner === owner && r.until > this.tick) out.add(chunkKey(floorDiv(r.x, size), floorDiv(r.y, size)));
    return out;
  }

  buildingAt(x: number, y: number): BuildingState | undefined {
    const id = this.buildingTiles.get(tileNum(x, y));
    return id === undefined ? undefined : this.buildings.get(id);
  }

  isPassable(x: number, y: number): boolean {
    if (!isSafeCoord(x, this.cfg.maxCoordinate) || !isSafeCoord(y, this.cfg.maxCoordinate)) return false;
    return this.chunks.naturallyPassable(x, y) && !this.buildingTiles.has(tileNum(x, y));
  }

  private noteExplored(u: UnitState): void {
    const p = this.players.get(u.owner);
    if (!p) return;
    const key = chunkKey(floorDiv(u.x, this.chunks.size), floorDiv(u.y, this.chunks.size));
    if (p.explored.has(key)) return;
    p.explored.add(key);
    this.exploredNew.push({ playerId: p.id, key });
    this.markPlayer(p);
    this.onChunkExplored(p, key);
  }

  private onChunkExplored(p: PlayerState, _key: string): void {
    this.awardXp(p, XP_AWARDS.perChunkExplored, "exploration");
  }

  // ------------------------------------------------------------------ progression

  level(p: PlayerState): number {
    return levelForXp(p.xp);
  }

  talentPoints(p: PlayerState): number {
    return talentPointsForLevel(this.level(p));
  }

  spentTalentPoints(p: PlayerState): number {
    let n = 0;
    for (const [id, rank] of Object.entries(p.talents)) n += (findTalentDef(id)?.cost ?? 1) * rank;
    return n;
  }

  /** Award experience (scaled by the player's xpGain modifier). Experience is capped at the level-60 threshold. */
  awardXp(p: PlayerState, base: number, source: string): void {
    if (base <= 0 || p.xp >= MAX_XP) return;
    const acc = (this.xpAcc.get(p.id) ?? 0) + base * this.mods(p.id).factor("xpGain");
    const whole = Math.floor(acc);
    this.xpAcc.set(p.id, acc - whole);
    if (whole <= 0) return;
    const before = this.level(p);
    p.xp = Math.min(MAX_XP, p.xp + whole);
    this.persist.players.add(p.id);
    this.xpDirty.add(p.id);
    const after = this.level(p);
    if (after > before) {
      this.levelUps.push({ playerId: p.id, level: after });
      this.audit.push({ tick: this.tick, playerId: p.id, action: "level_up", detail: `level ${after} (${source})` });
      this.markPlayer(p);
    }
  }

  /** Spend talent points on one rank of a talent. Every rule is checked against authoritative state. */
  allocateTalent(playerId: number, talentId: string): CommandResult<PlayerState> {
    const p = this.players.get(playerId);
    if (!p) return fail("no_player", "Unknown player");
    const t = findTalentDef(talentId);
    if (!t) return fail("bad_talent", `Unknown talent '${talentId}'`);
    if (t.race && t.race !== p.race) return fail("wrong_race", `${t.name} is only available to ${raceDef(t.race)?.name ?? t.race} players`);
    const rank = p.talents[t.id] ?? 0;
    if (rank >= t.maxRank) return fail("max_rank", `${t.name} is already at its maximum rank (${t.maxRank})`);
    const level = this.level(p);
    if (level < t.requiredLevel) return fail("level_too_low", `${t.name} requires level ${t.requiredLevel} (you are level ${level})`);
    for (const pre of t.prerequisites) {
      if ((p.talents[pre.talent] ?? 0) < pre.rank) return fail("missing_prerequisite", `${t.name} requires ${findTalentDef(pre.talent)?.name ?? pre.talent} rank ${pre.rank}`);
    }
    const available = this.talentPoints(p) - this.spentTalentPoints(p);
    if (available < t.cost) return fail("no_points", `Not enough talent points (${available} available, ${t.cost} needed)`);
    p.talents[t.id] = rank + 1;
    this.invalidateMods(p.id);
    this.markPlayer(p);
    this.audit.push({ tick: this.tick, playerId: p.id, action: "talent", detail: `${t.id} rank ${rank + 1}` });
    this.onModifiersChanged(p);
    return ok(p);
  }

  /** Refund all talent points for a gold fee (respec). */
  resetTalents(playerId: number): CommandResult<number> {
    const p = this.players.get(playerId);
    if (!p) return fail("no_player", "Unknown player");
    const spent = this.spentTalentPoints(p);
    if (spent === 0) return fail("nothing_to_reset", "No talent points are allocated");
    const fee = spent * XP_AWARDS.respecGoldPerPoint;
    if (!this.payAnywhere(p.id, { gold: fee })) return fail("insufficient_resources", `Resetting talents costs ${fee} gold (you have ${p.resources.gold})`);
    p.talents = {};
    this.invalidateMods(p.id);
    this.markPlayer(p);
    this.audit.push({ tick: this.tick, playerId: p.id, action: "talent_reset", detail: `${spent} points for ${fee} gold` });
    this.onModifiersChanged(p);
    return ok(spent);
  }

  /** Keep derived building values in step with modifier changes (e.g. health bonuses). */
  private onModifiersChanged(p: PlayerState): void {
    const hero = this.heroOf(p.id);
    if (hero) {
      const max = this.unitMaxHp(hero);
      if (hero.hp > max || !this.fightingEnabled) {
        hero.hp = max;
        this.markUnit(hero);
      }
    }
    for (const id of this.buildingsOf(p.id)) {
      const b = this.buildings.get(id);
      if (!b?.complete) continue;
      const max = this.buildingMaxHp(b);
      if (b.hp !== max) {
        b.hp = max;
        this.markBuilding(b);
      }
    }
  }

  private allocId(): number {
    return this.nextId++;
  }

  private log(u: UnitState, line: string): void {
    u.log.push(`[${(this.tick / this.cfg.tickRate).toFixed(1)}s] ${line}`);
    if (u.log.length > LOG_LIMIT) u.log.splice(0, u.log.length - LOG_LIMIT);
    u.detailRev++;
    this.markUnit(u);
  }

  /** Public so the script host can write print() output. */
  appendLog(u: UnitState, line: string): void {
    this.log(u, line.length > 200 ? `${line.slice(0, 200)}...` : line);
  }

  // ------------------------------------------------------------------ players & spawning

  /** Create a new player with a Town Hall, exactly three starting units and starting resources. */
  createPlayer(id: number, name: string, race: string): CommandResult<PlayerState> {
    if (this.players.has(id)) return fail("exists", "Player already exists");
    const spawn = this.findSpawn(id);
    if (!spawn) return fail("no_spawn", "Could not find a free spawn location");
    const p: PlayerState = { id, name, race, resources: emptyBag(), spawnX: spawn.x, spawnY: spawn.y, techs: [], explored: new Set(), xp: 0, talents: {}, discoveries: [], observed: [], pvp: false, pvpUntil: null, hero: newHeroState(), lessons: [], trophies: [] };
    this.players.set(id, p);
    this.markPlayer(p);
    // Clear the settlement site of resource nodes.
    for (let y = spawn.y - 2; y <= spawn.y + 2; y++) for (let x = spawn.x - 2; x <= spawn.x + 2; x++) this.chunks.clearNode(x, y);
    const hall = this.addBuilding(id, "town_hall", spawn.x - 1, spawn.y - 1, true);
    this.grantAt(hall, BALANCE.startingResources);
    // The starting claim and starting chunk are free: they award no experience.
    this.claimTerritory(hall, true);
    this.territory.dirty.add(chunkKey(floorDiv(hall.x, this.chunks.size), floorDiv(hall.y, this.chunks.size)));
    const startKey = chunkKey(floorDiv(spawn.x, this.chunks.size), floorDiv(spawn.y, this.chunks.size));
    p.explored.add(startKey);
    this.exploredNew.push({ playerId: id, key: startKey });
    STARTING_UNITS.forEach((type, i) => {
      this.addUnit(id, type, spawn.x - 1 + i, spawn.y + 2, true);
    });
    this.audit.push({ tick: this.tick, playerId: id, action: "player_created", detail: `spawn ${spawn.x},${spawn.y} hall ${hall.id}` });
    return ok(p);
  }

  private findSpawn(playerId: number): { x: number; y: number } | null {
    const rng = new SeededRandom(hashString(`${this.gen.params.seed}:spawn:${playerId}`));
    const halls = [...this.buildings.values()].filter((b) => b.type === "town_hall");
    for (let attempt = 0; attempt < 800; attempt++) {
      const ring = halls.length === 0 ? 8 + attempt * 2 : BALANCE.spawnSeparation + attempt * 3;
      const x = rng.int(ring * 2 + 1) - ring;
      const y = rng.int(ring * 2 + 1) - ring;
      if (halls.some((h) => chebyshev(h.x + 1, h.y + 1, x, y) < BALANCE.spawnSeparation)) continue;
      let okArea = true;
      for (let ty = y - 4; ty <= y + 4 && okArea; ty++) {
        for (let tx = x - 4; tx <= x + 4; tx++) {
          const t = this.chunks.terrainAt(tx, ty);
          if (!terrainDef(t).passable || t === Tile.Sand || this.buildingTiles.has(tileNum(tx, ty))) {
            okArea = false;
            break;
          }
        }
      }
      if (!okArea) continue;
      let trees = 0;
      let food = 0;
      for (let ty = y - 14; ty <= y + 14; ty++) {
        for (let tx = x - 14; tx <= x + 14; tx++) {
          const n = this.chunks.nodeAt(tx, ty);
          if (n?.kind === "tree") trees++;
          if (n?.kind === "berries") food++;
        }
      }
      if (trees < 15 || (food < 3 && attempt < 400)) continue;
      // Do not spawn inside or right next to another player's territory.
      let claimed = false;
      for (let ty = y - 14; ty <= y + 14 && !claimed; ty += 2) for (let tx = x - 14; tx <= x + 14; tx += 2) if (this.territory.ownerAt(tx, ty) !== 0) { claimed = true; break; }
      if (claimed) continue;
      // Never settle next to a contested zone (whether or not combat is currently enabled), or a lair.
      if (this.zones.near(x, y, ZONE_SPAWN_CLEARANCE).length > 0) continue;
      if (this.lairs.near(x, y, LAIR_SPAWN_CLEARANCE).length > 0) continue;
      return { x, y };
    }
    return null;
  }

  private newUnitState(id: number, owner: number, type: string, x: number, y: number): UnitState {
    const def = unitDef(type);
    return {
      id,
      owner,
      type,
      x,
      y,
      facing: 2,
      hp: def.maxHp,
      inventory: emptyBag(),
      learned: [],
      home: null,
      pen: null,
      task: { kind: "idle" },
      taskSource: "manual",
      program: { source: def.defaultProgram, version: 0, state: "stopped", error: null, note: "", library: null },
      blocked: "",
      vm: null,
      path: null,
      moveProgress: 0,
      log: [],
      exploreCount: 0,
      avoid: new Map(),
      activity: "idle",
      pendingResult: null,
      scriptAction: null,
      trace: [],
      detailRev: 0,
      pathFail: null,
      pathNarrowFailed: null,
      rev: 0,
      lastHit: null,
      provokedBy: null,
      attackedBy: null,
      lastAttackEvent: -1_000_000,
      revealedUntil: 0,
      wasStealthy: false,
      buffs: [],
      cooldowns: {},
    };
  }

  addUnit(owner: number, type: string, x: number, y: number, startProgram: boolean): UnitState {
    const u = this.newUnitState(this.allocId(), owner, type, x, y);
    if (unitDef(type).hero) u.hp = this.unitMaxHp(u);
    this.units.set(u.id, u);
    this.indexUnit(u);
    this.markUnit(u);
    if (startProgram) this.controlProgramInternal(u, "run");
    return u;
  }

  addBuilding(owner: number, type: string, x: number, y: number, complete: boolean): BuildingState {
    const def = buildingDef(type);
    let fertile = 0;
    for (let ty = y; ty < y + def.height; ty++) for (let tx = x; tx < x + def.width; tx++) if (this.chunks.terrainAt(tx, ty) === Tile.Fertile) fertile++;
    const b: BuildingState = {
      id: this.allocId(),
      owner,
      type,
      x,
      y,
      w: def.width,
      h: def.height,
      hp: complete ? Math.round(this.stat(owner, "buildingHp", def.maxHp)) : Math.ceil(def.maxHp * 0.1),
      complete,
      progress: complete ? def.buildTime : 0,
      queue: [],
      prodAcc: 0,
      fertility: fertile / (def.width * def.height),
      completedTick: complete ? this.tick : null,
      stock: emptyBag(),
      prodBlocked: false,
      buffs: [],
      pen: def.pen ? { acc: {}, breed: {} } : null,
      rev: 0,
    };
    this.buildings.set(b.id, b);
    this.indexBuilding(b);
    this.markBuilding(b);
    return b;
  }

  // ------------------------------------------------------------------ restoring persisted state

  restorePlayer(p: PlayerState): void {
    this.players.set(p.id, p);
  }

  restoreBuilding(b: BuildingState): void {
    this.buildings.set(b.id, b);
    this.indexBuilding(b);
    this.nextId = Math.max(this.nextId, b.id + 1);
  }

  /** Recompute territory from completed buildings in completion order (deterministic). Call after loading. */
  rebuildTerritory(): void {
    const done = [...this.buildings.values()].filter((b) => b.complete);
    done.sort((a, b) => (a.completedTick ?? 0) - (b.completedTick ?? 0) || a.id - b.id);
    for (const b of done) this.claimTerritory(b, true);
    this.territory.claims = [];
    this.territory.dirty.clear();
  }

  private claimTerritory(b: BuildingState, silent = false): void {
    const def = buildingDef(b.type);
    if (def.influence <= 0) return;
    const radius = Math.round(this.stat(b.owner, "territoryRadius", def.influence));
    const n = this.territory.claim(b.owner, b.id, b, radius, this.tick);
    if (n > 0 && !silent) {
      const p = this.players.get(b.owner);
      if (p) this.markPlayer(p);
      this.onTerritoryClaimed(b, n);
    }
  }

  private onTerritoryClaimed(b: BuildingState, tiles: number): void {
    const p = this.players.get(b.owner);
    if (p) this.awardXp(p, tiles * XP_AWARDS.perTerritoryTile, "territory");
  }

  restoreUnit(u: PersistedUnit): void {
    const full: UnitState = { ...u, vm: null, path: null, moveProgress: 0, log: [], exploreCount: 0, avoid: new Map(), activity: "idle", pendingResult: null, scriptAction: null, trace: [], detailRev: 0, pathFail: null, pathNarrowFailed: null, rev: 0, lastHit: null, provokedBy: null, attackedBy: null, lastAttackEvent: -1_000_000, revealedUntil: 0, wasStealthy: false, buffs: [], cooldowns: {} };
    // Wild creatures always run the current behaviour of their species (players cannot edit it).
    if (full.owner === NEUTRAL) {
      const wild = findUnitDef(full.type)?.creature?.wildProgram;
      if (wild && full.program.source !== wild) full.program.source = wild;
    }
    this.units.set(full.id, full);
    this.indexUnit(full);
    this.nextId = Math.max(this.nextId, full.id + 1);
    // Script VM state is transient: running programs restart from the beginning.
    if (full.program.state === "running") {
      this.controlProgramInternal(full, "run");
      this.log(full, "Server restarted: program restarted from the beginning");
    } else if (full.program.state === "paused") {
      full.program.state = "stopped";
      full.program.note = "Paused program was stopped by a server restart";
    }
    // In-flight tasks are restarted by the script; manual tasks are dropped.
    full.task = { kind: "idle" };
  }

  // ------------------------------------------------------------------ player commands (validated)

  private ownUnit(playerId: number, unitId: number): CommandResult<UnitState> {
    const u = this.units.get(unitId);
    if (!u) return fail("not_found", `Unit ${unitId} does not exist`);
    if (u.owner !== playerId) return fail("permission_denied", "Permission denied: you do not own that unit");
    return ok(u);
  }

  private ownBuilding(playerId: number, buildingId: number): CommandResult<BuildingState> {
    const b = this.buildings.get(buildingId);
    if (!b) return fail("not_found", `Building ${buildingId} does not exist`);
    if (b.owner !== playerId) return fail("permission_denied", "Permission denied: you do not own that building");
    return ok(b);
  }

  private checkCoord(x: number, y: number): CommandResult<undefined> {
    if (!isSafeCoord(x, this.cfg.maxCoordinate) || !isSafeCoord(y, this.cfg.maxCoordinate)) {
      return fail("bad_coordinate", "Coordinates out of range");
    }
    return ok(undefined);
  }

  /** Validate a building placement without changing anything. */
  checkPlacement(playerId: number, type: string, x: number, y: number, ignoreCost = false): CommandResult<undefined> {
    const p = this.players.get(playerId);
    if (!p) return fail("no_player", "Unknown player");
    const def = findBuildingDef(type);
    if (!def) return fail("bad_type", `Unknown building type '${type}'`);
    if (!def.placeable) return fail("not_placeable", `${def.name} cannot be built yet`);
    const req = this.missingRequirement(playerId, def.requires);
    if (req) return fail("missing_prerequisite", `Missing prerequisite for ${def.name}: ${req}`);
    const c = this.checkCoord(x, y);
    if (!c.ok) return c;
    const bcap = this.buildingCap(playerId);
    if (this.buildingsOf(playerId).size >= bcap) return fail("limit", `Building limit (${bcap}) reached: research Administration at a Library to raise it`);
    for (let ty = y; ty < y + def.height; ty++) {
      for (let tx = x; tx < x + def.width; tx++) {
        const t = this.chunks.terrainAt(tx, ty);
        const td = terrainDef(t);
        if (!td.buildable) return fail("bad_terrain", `Cannot build on ${td.name.toLowerCase()} at ${tx},${ty}`);
        if (def.allowedTerrain && !def.allowedTerrain.includes(t)) {
          return fail("bad_terrain", `${def.name} cannot be built on ${td.name.toLowerCase()} (at ${tx},${ty})`);
        }
        if (this.chunks.nodeAt(tx, ty)) return fail("occupied", `A resource node occupies ${tx},${ty}; harvest it first`);
        if (this.buildingTiles.has(tileNum(tx, ty))) return fail("occupied", `Another building occupies ${tx},${ty}`);
        const owner = this.territory.ownerAt(tx, ty);
        if (owner !== 0 && owner !== playerId) {
          return fail("foreign_territory", `${tx},${ty} is in ${this.players.get(owner)?.name ?? "another player"}'s territory`);
        }
        if (!def.expansion && owner !== playerId) {
          return fail("outside_territory", `${def.name} must be built inside your territory (${tx},${ty} is unclaimed). Build an Outpost to expand.`);
        }
      }
    }
    // Lairs: nobody builds in an occupied lair; a freshly cleared one is reserved for whoever cleared it.
    let lairClaim = false;
    for (const l of this.lairsTouching({ x, y, w: def.width, h: def.height })) {
      const st = this.lairState.get(l.id);
      const ld = LAIR_DEFS[l.kind] as LairDef;
      const claimedLand = this.territory.ownerAt(l.x, l.y) !== 0;
      if ((!st && !claimedLand) || st?.status === "active") return fail("lair", `That is a ${ld.name}: clear out its monsters before building there`);
      if (st?.status === "cleared" && st.claimUntil !== null && this.tick < st.claimUntil) {
        if (st.clearedBy !== playerId) {
          const mins = Math.ceil((st.claimUntil - this.tick) / this.cfg.tickRate / 60);
          return fail("lair_claimed", `${this.ownerLabel(st.clearedBy ?? 0)} cleared this ${ld.name} and has first claim on it for ${mins} more minute${mins === 1 ? "" : "s"}`);
        }
        lairClaim = true;
      }
    }
    if (def.expansion && !lairClaim && !this.nearOwnTerritory(playerId, { x, y, w: def.width, h: def.height }, BALANCE.expansionRange)) {
      return fail("out_of_range", `Too far from your territory: ${def.name}s must be within ${BALANCE.expansionRange} tiles of land you own (or in a lair you have just cleared)`);
    }
    if (!ignoreCost) {
      const cost = this.scaledCost(playerId, def.cost, "buildingCost");
      const pay = this.canPayAt(playerId, { x, y, w: def.width, h: def.height }, cost, `a ${def.name}`);
      if (!pay.ok) return pay;
    }
    return ok(undefined);
  }

  /** Lairs whose area overlaps a rectangle of tiles. */
  lairsTouching(r: Rect): Lair[] {
    return this.lairs.near(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h)).filter((l) => {
      const nx = Math.max(r.x, Math.min(l.x, r.x + r.w - 1));
      const ny = Math.max(r.y, Math.min(l.y, r.y + r.h - 1));
      return Math.hypot(nx - l.x, ny - l.y) <= l.r;
    });
  }

  /** Fighting is possible on this server: PvP combat, or PvE against lair monsters. */
  get fightingEnabled(): boolean {
    return this.cfg.combatEnabled || this.cfg.pveEnabled;
  }

  /** A human-readable missing prerequisite, or null when all are met. */
  missingRequirement(playerId: number, req: { buildings?: string[]; techs?: string[]; unlock?: string; combat?: boolean } | null): string | null {
    if (!req) return null;
    if (req.combat && !this.cfg.combatEnabled) return "combat, which is disabled on this server";
    const p = this.players.get(playerId);
    for (const t of req.buildings ?? []) {
      const has = [...this.buildingsOf(playerId)].some((id) => {
        const b = this.buildings.get(id);
        return b?.type === t && b.complete;
      });
      if (!has) return `a completed ${findBuildingDef(t)?.name ?? t}`;
    }
    for (const t of req.techs ?? []) if (!p?.techs.includes(t)) return `research ${findTechDef(t)?.name ?? t}`;
    if (req.unlock && !this.mods(playerId).has(req.unlock)) {
      const tech = Object.values(TECHS_BY_UNLOCK).find((x) => x.unlock === req.unlock);
      return tech ? `research ${tech.name}` : `unlock ${req.unlock}`;
    }
    return null;
  }

  /** Is the rectangle within `range` tiles of any tile the player owns? (Checked via own influence buildings.) */
  private nearOwnTerritory(playerId: number, rect: Rect, range: number): boolean {
    for (const id of this.buildingsOf(playerId)) {
      const b = this.buildings.get(id);
      if (!b?.complete) continue;
      const infl = buildingDef(b.type).influence;
      if (infl <= 0) continue;
      const r = Math.round(this.stat(playerId, "territoryRadius", infl));
      if (rectGap(b, rect) <= r + range) return true;
    }
    return false;
  }

  /** Place a construction site. The cost is charged exactly once, here. */
  placeBuilding(playerId: number, type: string, x: number, y: number): CommandResult<BuildingState> {
    const check = this.checkPlacement(playerId, type, x, y);
    if (!check.ok) return check;
    const def = buildingDef(type);
    const cost = this.scaledCost(playerId, def.cost, "buildingCost");
    const paid = this.payAt(playerId, { x, y, w: def.width, h: def.height }, cost, `a ${def.name}`);
    if (!paid.ok) return paid;
    const b = this.addBuilding(playerId, type, x, y, false);
    this.audit.push({ tick: this.tick, playerId, action: "place_building", detail: `${type} #${b.id} at ${x},${y} cost ${formatCost(cost)}` });
    return ok(b);
  }

  trainUnit(playerId: number, buildingId: number, unitType: string): CommandResult<BuildingState> {
    const r = this.ownBuilding(playerId, buildingId);
    if (!r.ok) return r;
    const b = r.value;
    const p = this.players.get(playerId) as PlayerState;
    const def = buildingDef(b.type);
    const ud = findUnitDef(unitType);
    if (!ud) return fail("bad_type", `Unknown unit type '${unitType}'`);
    if (!b.complete) return fail("incomplete", `${def.name} is still under construction`);
    if (!def.trains.includes(unitType) || !ud.cost) return fail("cannot_train", `${def.name} cannot train ${ud.name}s`);
    if (ud.requiresCombat && !this.fightingEnabled) return fail("combat_disabled", `${ud.name}s can only be trained when combat or PvE is enabled on this server`);
    if (b.queue.length >= BALANCE.maxTrainQueue) return fail("queue_full", "Training queue is full");
    let queued = 0;
    for (const id of this.buildingsOf(playerId)) queued += this.buildings.get(id)?.queue.length ?? 0;
    const ucap = this.unitCap(playerId);
    if (this.limitedUnits(playerId) + queued >= ucap) return fail("limit", `Unit limit (${ucap}) reached: research Administration at a Library to raise it`);
    const cost = this.scaledCost(playerId, ud.cost, "trainCost");
    const paid = this.payAt(playerId, b, cost, `a ${ud.name}`);
    if (!paid.ok) return paid;
    b.queue.push({ kind: "unit", unitType, progress: 0 });
    this.markPlayer(p);
    this.markBuilding(b);
    this.audit.push({ tick: this.tick, playerId, action: "train_unit", detail: `${unitType} at #${b.id} cost ${formatCost(cost)}` });
    return ok(b);
  }

  /** Queue research at a Library. The cost is charged once, when queued. */
  research(playerId: number, buildingId: number, techId: string): CommandResult<BuildingState> {
    const r = this.ownBuilding(playerId, buildingId);
    if (!r.ok) return r;
    const b = r.value;
    const p = this.players.get(playerId) as PlayerState;
    const def = buildingDef(b.type);
    const tech = findTechDef(techId);
    if (!tech) return fail("bad_type", `Unknown technology '${techId}'`);
    if (!def.research) return fail("cannot_research", `${def.name} cannot research; build a Library`);
    if (!b.complete) return fail("incomplete", `${def.name} is still under construction`);
    if (p.techs.includes(techId)) return fail("already_researched", `${tech.name} is already researched`);
    for (const id of this.buildingsOf(playerId)) {
      if (this.buildings.get(id)?.queue.some((q) => q.kind === "tech" && q.techId === techId)) return fail("already_queued", `${tech.name} is already being researched`);
    }
    const missing = tech.requires.find((t) => !p.techs.includes(t));
    if (missing) return fail("missing_prerequisite", `Missing prerequisite: research ${findTechDef(missing)?.name ?? missing} first`);
    if (b.queue.length >= BALANCE.maxTrainQueue) return fail("queue_full", "Research queue is full");
    for (const res of RESOURCE_TYPES) {
      void res;
    }
    const paid = this.payAt(playerId, b, tech.cost, tech.name);
    if (!paid.ok) return paid;
    b.queue.push({ kind: "tech", techId, progress: 0 });
    this.markPlayer(p);
    this.markBuilding(b);
    this.audit.push({ tick: this.tick, playerId, action: "research", detail: `${techId} at #${b.id} cost ${formatCost(tech.cost)}` });
    return ok(b);
  }

  commandUnit(playerId: number, unitId: number, cmd: ManualCommand): CommandResult<UnitState> {
    const r = this.ownUnit(playerId, unitId);
    if (!r.ok) return r;
    const u = r.value;
    if (u.pen !== null) return fail("penned", "That animal lives in a paddock: release it from the paddock first");
    let task: Task;
    switch (cmd.kind) {
      case "stop":
        task = { kind: "idle" };
        break;
      case "move": {
        const c = this.checkCoord(cmd.x, cmd.y);
        if (!c.ok) return c;
        task = { kind: "move", goal: { x: cmd.x, y: cmd.y, w: 1, h: 1 }, range: 0, label: "move" };
        break;
      }
      case "gather": {
        const c = this.checkCoord(cmd.x, cmd.y);
        if (!c.ok) return c;
        const t = this.makeGatherTask(u, cmd.x, cmd.y);
        if (!t.ok) return t;
        task = t.value;
        break;
      }
      case "build": {
        const b = this.buildings.get(cmd.buildingId);
        if (!b) return fail("not_found", "Building not found");
        if (b.owner !== playerId) return fail("permission_denied", "Permission denied: not your building");
        if (b.complete) return fail("complete", "That building is already complete");
        if (!unitDef(u.type).capabilities.includes("build")) return fail("unsupported", "This unit cannot build");
        task = { kind: "build", buildingId: b.id, acc: 0 };
        break;
      }
      case "deposit":
        if (bagTotal(u.inventory) === 0) return fail("empty", "Nothing to deposit");
        task = { kind: "deposit", buildingId: null };
        break;
      case "investigate": {
        if (!this.chunks.ruinAt(cmd.x, cmd.y)) return fail("not_found", `There is no ruin at ${cmd.x},${cmd.y}`);
        if (!unitDef(u.type).capabilities.includes("explore")) return fail("unsupported", `${unitDef(u.type).name}s cannot investigate`);
        task = { kind: "investigate", x: cmd.x, y: cmd.y, progress: 0 };
        break;
      }
      case "observe":
      case "tame": {
        const c = this.units.get(cmd.targetId);
        // The server additionally refuses targets outside the player's vision with this same answer.
        if (!c || !unitDef(c.type).creature) return fail("not_found", "No such creature nearby");
        if (c.owner !== NEUTRAL) return fail("not_wild", "That creature is not wild");
        if (cmd.kind === "observe") {
          task = { kind: "observe", targetId: c.id, progress: 0, sawHidden: false };
        } else {
          const check = this.canTame(u, c);
          if (check) return fail("cannot_tame", check);
          task = { kind: "tame", targetId: c.id };
        }
        break;
      }
      case "attack": {
        const t = this.units.get(cmd.targetId);
        if (!t) return fail("not_found", "No such target nearby");
        const why = this.attackBlocker(u, t);
        if (why) return fail("cannot_attack", why);
        task = { kind: "attack", targetId: t.id, building: false, nextHit: this.tick };
        break;
      }
      case "attack_building": {
        const b = this.buildings.get(cmd.buildingId);
        if (!b) return fail("not_found", "No such building nearby");
        const why = this.buildingAttackBlocker(u, b);
        if (why) return fail("cannot_attack", why);
        task = { kind: "attack", targetId: b.id, building: true, nextHit: this.tick };
        break;
      }
      case "pen": {
        const b = this.buildings.get(cmd.buildingId);
        if (!b || b.owner !== playerId) return fail("not_found", "That is not one of your paddocks");
        const why = this.penBlocker(u, b);
        if (why) return fail("cannot_pen", why);
        task = { kind: "pen", buildingId: b.id };
        break;
      }
      case "repair": {
        const b = this.buildings.get(cmd.buildingId);
        if (!b || b.owner !== playerId) return fail("not_found", "That is not one of your buildings");
        if (!b.complete) return fail("incomplete", "Construction sites are finished with build, not repaired");
        if (!unitDef(u.type).capabilities.includes("build")) return fail("unsupported", `${unitDef(u.type).name}s cannot repair`);
        if (b.hp >= this.buildingMaxHp(b)) return fail("undamaged", "That building is not damaged");
        task = { kind: "repair", buildingId: b.id, hpAcc: 0, costAcc: {} };
        break;
      }
    }
    if (u.program.state === "running" || u.program.state === "paused") {
      this.controlProgramInternal(u, "stop");
      u.program.note = "Stopped by manual command";
    }
    this.setTask(u, task, "manual");
    return ok(u);
  }

  private makeGatherTask(u: UnitState, x: number, y: number): CommandResult<Task> {
    const node = this.chunks.nodeAt(x, y);
    if (!node) return fail("no_resource", `There is no resource at ${x},${y} (it may be exhausted)`);
    if (this.chunks.amountOf(node) <= 0) return fail("no_resource", `The ${NODE_DEFS[node.kind].label.toLowerCase()} at ${x},${y} is empty and regrowing`);
    const def = unitDef(u.type);
    const resource = NODE_DEFS[node.kind].yields;
    if (!def.capabilities.includes("gather") || def.gatherRate[resource] <= 0) {
      return fail("unsupported", `${def.name}s cannot gather ${resource}`);
    }
    if (bagTotal(u.inventory) >= this.capacity(u)) return fail("inventory_full", "Inventory full: deposit cargo first");
    return ok({ kind: "gather", nodeX: x, nodeY: y, resource, gathered: 0, acc: 0, rate: this.gatherRate(u, resource, x, y) });
  }

  /** Units per second for this unit gathering `resource` at (x, y): base x modifiers x building auras. */
  gatherRate(u: UnitState, resource: ResourceType, x: number, y: number): number {
    let aura = 0;
    for (const id of this.buildingsOf(u.owner)) {
      const b = this.buildings.get(id);
      if (!b?.complete) continue;
      const a = buildingDef(b.type).aura;
      if (a && a.resources.includes(resource) && distToRect(x, y, b.x, b.y, b.w, b.h) <= a.radius) aura = Math.max(aura, a.pct);
    }
    const zone = this.contestedZoneAt(x, y) ? BALANCE.contestedGatherBonus : 0;
    return this.stat(u.owner, `gather.${resource}`, unitDef(u.type).gatherRate[resource]) * (1 + aura) * (1 + zone) * Math.max(0.2, 1 + this.unitPct(u, `gather.${resource}`));
  }

  /** Contested zones are in force: combat enabled and zones switched on. */
  get zonesActive(): boolean {
    return this.cfg.combatEnabled && this.cfg.contestedZones;
  }

  /** The active contested zone containing tile (x, y), if any. */
  contestedZoneAt(x: number, y: number): ContestedZone | null {
    return this.zonesActive ? this.zones.at(x, y) : null;
  }

  /** The active contested zone a building touches, if any (any footprint tile inside counts). */
  buildingZone(b: { x: number; y: number; w: number; h: number }): ContestedZone | null {
    return this.zonesActive ? this.zones.touchingRect(b) : null;
  }

  private setTask(u: UnitState, task: Task, source: "script" | "manual"): void {
    u.task = task;
    u.taskSource = source;
    u.path = null;
    u.moveProgress = 0;
    u.blocked = "";
    this.markUnit(u);
  }

  // ------------------------------------------------------------------ programs

  /** Replace a unit's program source. Rejects programs that do not compile. */
  setProgram(
    playerId: number,
    unitId: number,
    source: string,
    version: number,
    library: { id: number; version: number; name: string } | null = null,
  ): CommandResult<UnitState> {
    const r = this.ownUnit(playerId, unitId);
    if (!r.ok) return r;
    const u = r.value;
    const c = compileSource(source, { unlocks: this.mods(playerId).unlocks });
    if (!c.ok) {
      const d = c.diagnostics[0];
      return fail("syntax_error", d ? `Line ${d.line}, col ${d.col}: ${d.message}` : "Syntax error");
    }
    const wasRunning = u.program.state === "running" || u.program.state === "paused";
    u.program.source = source;
    u.program.version = version;
    u.program.library = library;
    u.program.error = null;
    if (wasRunning) {
      this.controlProgramInternal(u, "run");
      u.program.note = `Restarted with version ${version}`;
    } else {
      u.program.state = "stopped";
      u.program.note = `Saved version ${version}`;
    }
    this.markUnit(u);
    return ok(u);
  }

  controlProgram(playerId: number, unitId: number, action: ProgramControl): CommandResult<UnitState> {
    const r = this.ownUnit(playerId, unitId);
    if (!r.ok) return r;
    const u = r.value;
    const st = u.program.state;
    if (action === "pause" && st !== "running") return fail("bad_state", "Program is not running");
    if (action === "resume" && st !== "paused" && st !== "stopped") return fail("bad_state", "Program is not paused");
    const res = this.controlProgramInternal(u, action);
    if (!res.ok) return res;
    return ok(u);
  }

  private controlProgramInternal(u: UnitState, action: ProgramControl): CommandResult<undefined> {
    if (u.pen !== null && (action === "run" || action === "resume")) return fail("penned", "Animals in a paddock do not run programs: release it first");
    const prog = u.program;
    switch (action) {
      case "run": {
        const c = compileSource(prog.source, { unlocks: this.mods(u.owner).unlocks });
        if (!c.ok) {
          const d = c.diagnostics[0] ?? { message: "Syntax error", line: 0, col: 0 };
          prog.state = "error";
          prog.error = { message: d.message, line: d.line, col: d.col };
          prog.note = "Program failed to compile";
          u.vm = null;
          this.markUnit(u);
          return fail("syntax_error", `Line ${d.line}: ${d.message}`);
        }
        this.cancelPendingTrace(u, "cancelled (program restarted)");
        u.vm = new VM(c.program, new UnitScriptHost(this, u));
        prog.state = "running";
        prog.error = null;
        prog.note = "Running";
        if (u.taskSource === "script" || u.task.kind !== "idle") this.setTask(u, { kind: "idle" }, "script");
        break;
      }
      case "pause":
        prog.state = "paused";
        prog.note = "Paused (the current action will finish)";
        break;
      case "resume":
        if (!u.vm || u.vm.state === "done" || u.vm.state === "error") return this.controlProgramInternal(u, "run");
        prog.state = "running";
        prog.note = "Running";
        break;
      case "stop":
        u.vm = null;
        prog.state = "stopped";
        prog.note = "Stopped";
        this.cancelPendingTrace(u, "cancelled (program stopped)");
        if (u.taskSource === "script") this.setTask(u, { kind: "idle" }, "script");
        break;
    }
    this.markUnit(u);
    return ok(undefined);
  }

  /**
   * A bug in one unit's update must not stop the world: cancel that unit's task, tell its
   * owner in the unit log, and report the full error to the server log.
   */
  private containUnitError(u: UnitState, err: unknown): void {
    this.stats.internalErrors++;
    this.onInternalError(`Internal error updating unit #${u.id} (${u.type}, owner ${u.owner}, task ${u.task.kind}) at tick ${this.tick}; task cancelled`, err);
    try {
      u.path = null;
      u.pathFail = null;
      this.finishTask(u, { ok: false, value: null, reason: "Internal server error (reported to the server log); task cancelled" }, u.task.kind);
    } catch (err2) {
      // Last resort: leave the unit idle.
      u.task = { kind: "idle" };
      u.path = null;
      this.onInternalError(`Could not cancel the task of unit #${u.id} cleanly`, err2);
    }
    this.markUnit(u);
  }

  /**
   * Run the program's on_attacked(attacker) handler: the action the unit was doing is
   * abandoned (it returns None to the program after the handler finishes).
   */
  private deliverAttackEvent(u: UnitState): void {
    const by = this.units.get(u.attackedBy as number);
    u.attackedBy = null;
    if (!by || !u.vm || u.program.state !== "running" || u.taskSource !== "script") return;
    if (!u.vm.interrupt("on_attacked", [this.unitRef(by)], null)) return;
    u.lastAttackEvent = this.tick;
    this.cancelPendingTrace(u, "interrupted: attacked");
    u.task = { kind: "idle" };
    u.path = null;
    u.scriptAction = null;
    u.pendingResult = null;
    this.setActivity(u, "idle");
  }

  /** An action still in progress will never report back once its program is gone: close its trace entry. */
  private cancelPendingTrace(u: UnitState, why: string): void {
    const entry = u.trace[u.trace.length - 1];
    if (entry && entry.result === "") {
      entry.ok = false;
      entry.result = why;
      u.detailRev++;
    }
  }

  // ------------------------------------------------------------------ script actions

  /** Translate a script action into a task. Invalid requests become an immediately-failing task. */
  startScriptAction(u: UnitState, a: ActionRequest): void {
    u.scriptAction = a.name;
    u.trace.push({ tick: this.tick, line: a.line, call: `${a.name}(${a.args.map((v) => repr(v, 1)).join(", ")})`, result: "", ok: true });
    if (u.trace.length > TRACE_LIMIT) u.trace.splice(0, u.trace.length - TRACE_LIMIT);
    u.detailRev++;
    const resolveNextTick = (result: TaskResult): void => {
      this.setTask(u, { kind: "wait", until: this.tick }, "script");
      u.pendingResult = result;
    };
    const failTask = (reason: string, value: Value): void => resolveNextTick({ ok: false, value, reason });
    const def = unitDef(u.type);
    switch (a.name) {
      case "move_to": {
        const target = this.resolveTarget(a.args);
        if (!target.ok) return failTask(target.message, false);
        const t = target.value;
        this.setTask(u, { kind: "move", goal: t.rect, range: t.range, label: "move_to" }, "script");
        return;
      }
      case "harvest": {
        const ref = a.args[0];
        if (!(ref instanceof ObjectRef) || !isNodeKind(ref.kind)) return failTask("harvest() needs a resource node from find_nearest()", 0);
        const t = this.makeGatherTask(u, ref.x, ref.y);
        if (!t.ok) return failTask(t.message, 0);
        this.setTask(u, t.value, "script");
        return;
      }
      case "deposit":
      case "deposit_at_nearest_storage": {
        let bid: number | null = null;
        const ref = a.args[0];
        if (ref instanceof ObjectRef) {
          const b = this.buildingFromRef(ref);
          if (!b || b.owner !== u.owner) return failTask("deposit() target is not one of your buildings", false);
          bid = b.id;
        }
        this.setTask(u, { kind: "deposit", buildingId: bid, explicit: bid !== null }, "script");
        return;
      }
      case "build": {
        const ref = a.args[0];
        const b = ref instanceof ObjectRef ? this.buildingFromRef(ref) : undefined;
        if (!b) return failTask("build() needs a construction site from find_nearest(\"construction\")", false);
        if (b.owner !== u.owner) return failTask("Permission denied: that building is not yours", false);
        if (!def.capabilities.includes("build")) return failTask(`${def.name}s cannot build`, false);
        this.setTask(u, { kind: "build", buildingId: b.id, acc: 0 }, "script");
        return;
      }
      case "explore": {
        const dest = this.pickExploreTarget(u);
        if (!dest) return failTask("No reachable place to explore nearby", false);
        this.setTask(u, { kind: "move", goal: { x: dest.x, y: dest.y, w: 1, h: 1 }, range: 0, label: "explore" }, "script");
        return;
      }
      case "wait": {
        const secs = a.args.length > 0 ? (a.args[0] as number) : 1;
        const ticks = Math.max(1, Math.round(Math.min(BALANCE.maxWaitSeconds, Math.max(0, secs)) * this.cfg.tickRate));
        this.setTask(u, { kind: "wait", until: this.tick + ticks }, "script");
        return;
      }
      case "place": {
        const type = a.args[0];
        let x = a.args[1];
        let y = a.args[2];
        if (a.args.length === 2 && x instanceof ListValue) {
          y = x.items[1];
          x = x.items[0];
        }
        if (typeof type !== "string" || typeof x !== "number" || typeof y !== "number" || !Number.isInteger(x) || !Number.isInteger(y)) {
          return failTask("place() needs a building type and whole-number coordinates", null);
        }
        const r = this.placeBuilding(u.owner, type, x, y);
        if (!r.ok) return failTask(r.message, null);
        return resolveNextTick({ ok: true, value: this.buildingRef(r.value), reason: "" });
      }
      case "use_ability": {
        const name = a.args[0];
        if (typeof name !== "string") return failTask('use_ability() needs an ability name such as "rally"', false);
        let target: AbilityTarget = null;
        const t = a.args[1];
        if (t instanceof ObjectRef) {
          const tu = this.unitFromRef(t);
          target = tu ? { unitId: tu.id } : { x: t.x, y: t.y };
        } else if (typeof t === "number" && typeof a.args[2] === "number") {
          target = { x: Math.round(t), y: Math.round(a.args[2]) };
        }
        const r = this.castAbility(u, name, target);
        if (!r.ok) return failTask(r.message, false);
        return resolveNextTick({ ok: true, value: true, reason: "" });
      }
      case "wander": {
        const radius = Math.max(1, Math.min(24, Math.floor(typeof a.args[0] === "number" ? a.args[0] : 8)));
        const base = u.home ?? { x: u.x, y: u.y };
        const rng = new SeededRandom(hashString(`wander:${u.id}:${this.tick}`));
        const spot = this.nearestPassable(base.x + rng.int(radius * 2 + 1) - radius, base.y + rng.int(radius * 2 + 1) - radius, 2);
        if (!spot) return failTask("Nowhere to wander", false);
        this.setTask(u, { kind: "move", goal: { x: spot.x, y: spot.y, w: 1, h: 1 }, range: 0, label: "explore" }, "script");
        return;
      }
      case "observe":
      case "tame": {
        const ref = a.args[0];
        const c = ref instanceof ObjectRef ? this.unitFromRef(ref) : undefined;
        if (!c || !unitDef(c.type).creature) return failTask(`${a.name}() needs a creature from find_nearest("creature")`, false);
        if (c.owner !== NEUTRAL) return failTask("That creature is not wild", false);
        if (a.name === "observe") {
          this.setTask(u, { kind: "observe", targetId: c.id, progress: 0, sawHidden: false }, "script");
          return;
        }
        const check = this.canTame(u, c);
        if (check) return failTask(check, false);
        this.setTask(u, { kind: "tame", targetId: c.id }, "script");
        return;
      }
      case "train_creature": {
        const ref = a.args[0];
        const ability = a.args[1];
        const c = ref instanceof ObjectRef ? this.unitFromRef(ref) : undefined;
        if (!c || typeof ability !== "string") return failTask("train_creature() needs one of your creatures and an ability name", false);
        const check = this.canTrain(u, c, ability);
        if (check) return failTask(check, false);
        this.setTask(u, { kind: "train_creature", targetId: c.id, ability, progress: 0 }, "script");
        return;
      }
      case "investigate": {
        const ref = a.args[0];
        if (!(ref instanceof ObjectRef) || !ref.id.startsWith("ruin:") || !this.chunks.ruinAt(ref.x, ref.y)) return failTask('investigate() needs a ruin from find_nearest("ruin")', null);
        if (!def.capabilities.includes("explore")) return failTask(`${def.name}s cannot investigate`, null);
        this.setTask(u, { kind: "investigate", x: ref.x, y: ref.y, progress: 0 }, "script");
        return;
      }
      case "follow": {
        const ref = a.args[0];
        const target = ref instanceof ObjectRef ? this.unitFromRef(ref) : undefined;
        if (!this.hasAbility(u, "follow")) return failTask(`${def.name}s cannot follow`, false);
        if (!target || target.id === u.id) return failTask("follow() needs another unit or creature", false);
        const secs = Math.max(1, Math.min(120, typeof a.args[1] === "number" ? a.args[1] : 30));
        this.setTask(u, { kind: "follow", targetId: target.id, until: this.tick + Math.round(secs * this.cfg.tickRate) }, "script");
        return;
      }
      case "guard": {
        const [x, y] = a.args;
        if (!this.hasAbility(u, "guard")) return failTask(`${def.name} has not been trained to guard`, false);
        if (typeof x !== "number" || typeof y !== "number" || !Number.isInteger(x) || !Number.isInteger(y)) return failTask("guard(x, y) needs whole numbers", false);
        const c = this.checkCoord(x, y);
        if (!c.ok) return failTask(c.message, false);
        const secs = Math.max(1, Math.min(600, typeof a.args[2] === "number" ? a.args[2] : 60));
        this.setTask(u, { kind: "guard", x, y, until: this.tick + Math.round(secs * this.cfg.tickRate) }, "script");
        return;
      }
      case "attack": {
        const ref = a.args[0];
        if (!(ref instanceof ObjectRef)) return failTask("attack() needs a unit, creature or building object", false);
        const b = this.buildingFromRef(ref);
        if (b) {
          const why = this.buildingAttackBlocker(u, b);
          if (why) return failTask(why, false);
          this.setTask(u, { kind: "attack", targetId: b.id, building: true, nextHit: this.tick }, "script");
          return;
        }
        const t = this.unitFromRef(ref);
        if (!t) return failTask(ref.id.startsWith("u:") ? "The target no longer exists" : "attack() needs a unit, creature or building object", false);
        const why = this.attackBlocker(u, t);
        if (why) return failTask(why, false);
        this.setTask(u, { kind: "attack", targetId: t.id, building: false, nextHit: this.tick }, "script");
        return;
      }
      case "pen": {
        const ref = a.args[0];
        const b = ref instanceof ObjectRef ? this.buildingFromRef(ref) : undefined;
        if (!b || b.owner !== u.owner) return failTask('pen() needs one of your paddocks, e.g. find_nearest("paddock")', false);
        const why = this.penBlocker(u, b);
        if (why) return failTask(why, false);
        this.setTask(u, { kind: "pen", buildingId: b.id }, "script");
        return;
      }
      case "go_home": {
        if (!u.home) return failTask("This unit has no home to go back to", false);
        const spot = this.nearestPassable(u.home.x, u.home.y, 3);
        if (!spot) return failTask("Home is unreachable", false);
        this.setTask(u, { kind: "move", goal: { x: spot.x, y: spot.y, w: 1, h: 1 }, range: 1, label: "go_home" }, "script");
        return;
      }
      case "repair": {
        const ref = a.args[0];
        const b = ref instanceof ObjectRef ? this.buildingFromRef(ref) : undefined;
        if (!b || b.owner !== u.owner) return failTask("repair() needs one of your buildings", false);
        if (!b.complete) return failTask("Use build() to finish a construction site", false);
        if (!def.capabilities.includes("build")) return failTask(`${def.name}s cannot repair`, false);
        this.setTask(u, { kind: "repair", buildingId: b.id, hpAcc: 0, costAcc: {} }, "script");
        return;
      }
      case "flee": {
        const ref = a.args[0];
        if (!(ref instanceof ObjectRef)) return failTask("flee() needs an object to run from", false);
        const from = this.unitFromRef(ref) ?? ref;
        const t = this.fleeTask(u, from);
        if (!t) return failTask("Nowhere to run", false);
        this.setTask(u, t, "script");
        return;
      }
      case "withdraw": {
        const res = a.args[0];
        if (!isResourceType(res)) return failTask("withdraw() needs a resource name", 0);
        const amount = a.args.length > 1 && typeof a.args[1] === "number" ? Math.floor(a.args[1]) : this.capacity(u);
        let from: number | null = null;
        const ref = a.args[2];
        if (ref instanceof ObjectRef) {
          const b = this.buildingFromRef(ref);
          if (!b || b.owner !== u.owner || !b.complete || !buildingDef(b.type).storage) return failTask("withdraw() storage must be one of your completed storage buildings", 0);
          from = b.id;
        }
        this.setTask(u, { kind: "withdraw", buildingId: from, resource: res, amount: Math.max(1, amount), explicit: from !== null }, "script");
        return;
      }
      case "train_unit": {
        const type = a.args[0];
        if (typeof type !== "string") return failTask("train_unit() needs a unit type", false);
        let best: BuildingState | undefined;
        let bestD = Infinity;
        for (const id of this.buildingsOf(u.owner)) {
          const b = this.buildings.get(id);
          if (!b || !b.complete || !buildingDef(b.type).trains.includes(type)) continue;
          const d = distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
          if (d < bestD || (d === bestD && best && b.id < best.id)) {
            best = b;
            bestD = d;
          }
        }
        if (!best) return failTask(`None of your completed buildings can train '${type}'`, false);
        const r = this.trainUnit(u.owner, best.id, type);
        if (!r.ok) return failTask(r.message, false);
        return resolveNextTick({ ok: true, value: true, reason: "" });
      }
      default:
        return failTask(`Unknown action ${a.name}`, null);
    }
  }

  /** Nearest valid placement for a building type around a unit (bounded search, deterministic order). */
  findBuildSpot(u: UnitState, type: string, radius = 10): { x: number; y: number } | null {
    const def = findBuildingDef(type);
    if (!def || !def.placeable) return null;
    const ox = Math.floor((def.width - 1) / 2);
    const oy = Math.floor((def.height - 1) / 2);
    for (let r = 1; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = u.x + dx - ox;
          const y = u.y + dy - oy;
          // Leave a one-tile walkway around footprints so buildings do not wall units in.
          if (this.checkPlacement(u.owner, type, x, y, true).ok && this.footprintClear(x - 1, y - 1, def.width + 2, def.height + 2)) return { x, y };
        }
      }
    }
    return null;
  }

  private footprintClear(x: number, y: number, w: number, h: number): boolean {
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) if (this.buildingTiles.has(tileNum(tx, ty))) return false;
    return true;
  }

  private resolveTarget(args: Value[]): CommandResult<{ rect: Rect; range: number }> {
    if (args.length === 2) {
      const [x, y] = args;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isInteger(x) || !Number.isInteger(y)) {
        return fail("bad_args", "move_to(x, y) needs two whole numbers");
      }
      const c = this.checkCoord(x, y);
      if (!c.ok) return c;
      return ok({ rect: { x, y, w: 1, h: 1 }, range: 0 });
    }
    const ref = args[0];
    if (!(ref instanceof ObjectRef)) return fail("bad_args", "move_to() needs an object or x, y");
    const b = this.buildingFromRef(ref);
    if (b) return ok({ rect: { x: b.x, y: b.y, w: b.w, h: b.h }, range: 1 });
    return ok({ rect: { x: ref.x, y: ref.y, w: 1, h: 1 }, range: this.isPassable(ref.x, ref.y) ? 0 : 1 });
  }

  buildingFromRef(ref: ObjectRef): BuildingState | undefined {
    if (!ref.id.startsWith("b:")) return undefined;
    return this.buildings.get(Number(ref.id.slice(2)));
  }

  private pickExploreTarget(u: UnitState): { x: number; y: number } | null {
    const p = this.players.get(u.owner);
    const rng = new SeededRandom(hashString(`explore:${u.id}:${u.exploreCount++}:${this.tick}`));
    const dirs: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    let best: { x: number; y: number; score: number } | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = dirs[rng.int(8)] as [number, number];
      const dist = BALANCE.exploreMin + rng.int(BALANCE.exploreMax - BALANCE.exploreMin + 1);
      const tx = u.x + d[0] * dist;
      const ty = u.y + d[1] * dist;
      const spot = this.nearestPassable(tx, ty, 3);
      if (!spot) continue;
      const away = p ? chebyshev(spot.x, spot.y, p.spawnX, p.spawnY) : 0;
      const score = away + rng.next() * 12;
      if (!best || score > best.score) best = { ...spot, score };
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private nearestPassable(x: number, y: number, radius: number): { x: number; y: number } | null {
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.isPassable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ queries used by scripts

  /** Nearest object of a kind within the unit's sensing radius (ties broken by y, then x for determinism). */
  /**
   * Regional overview for the minimap: explored chunks only (no hidden information),
   * each as OVERVIEW_SAMPLES x OVERVIEW_SAMPLES samples. A sample is one character:
   * 48 + terrain + 8 * (0 unclaimed, 1 yours, 2 another player's).
   * Terrain comes straight from the deterministic generator (no chunk-cache churn).
   */
  overview(
    playerId: number,
    ccx: number,
    ccy: number,
    radius: number,
  ): { chunks: [number, number, string][]; buildings: [number, number][]; units: [number, number][]; zones: [number, number, number][] } {
    const p = this.players.get(playerId);
    const chunks: [number, number, string][] = [];
    if (!p) return { chunks, buildings: [], units: [], zones: [] };
    const n = OVERVIEW_SAMPLES;
    const step = this.chunks.size / n;
    for (let cy = ccy - radius; cy <= ccy + radius; cy++) {
      for (let cx = ccx - radius; cx <= ccx + radius; cx++) {
        const key = `${cx},${cy}`;
        if (!p.explored.has(key)) continue;
        let terrain = this.overviewCache.get(key);
        if (!terrain) {
          terrain = new Uint8Array(n * n);
          for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) terrain[sy * n + sx] = this.gen.terrainAt(cx * this.chunks.size + Math.floor((sx + 0.5) * step), cy * this.chunks.size + Math.floor((sy + 0.5) * step));
          if (this.overviewCache.size >= 100_000) this.overviewCache.clear();
          this.overviewCache.set(key, terrain);
        }
        let s = "";
        for (let sy = 0; sy < n; sy++) {
          for (let sx = 0; sx < n; sx++) {
            const o = this.territory.ownerAt(cx * this.chunks.size + Math.floor((sx + 0.5) * step), cy * this.chunks.size + Math.floor((sy + 0.5) * step));
            s += String.fromCharCode(48 + (terrain[sy * n + sx] as number) + 8 * (o === 0 ? 0 : o === playerId ? 1 : 2));
          }
        }
        chunks.push([cx, cy, s]);
      }
    }
    const buildings: [number, number][] = [];
    for (const id of this.buildingsOf(playerId)) {
      const b = this.buildings.get(id);
      if (b) buildings.push([b.x, b.y]);
    }
    const units: [number, number][] = [];
    for (const id of this.unitsOf(playerId)) {
      const u = this.units.get(id);
      if (u) units.push([u.x, u.y]);
    }
    // Contested zones the player has seen (touching an explored chunk).
    const zones: [number, number, number][] = [];
    if (this.zonesActive) {
      const s = this.chunks.size;
      for (const z of this.zones.inRect((ccx - radius) * s, (ccy - radius) * s, (ccx + radius + 1) * s - 1, (ccy + radius + 1) * s - 1)) {
        const seen = chunks.some(([cx, cy]) => this.zones.inRect(cx * s, cy * s, cx * s + s - 1, cy * s + s - 1).some((o) => o.id === z.id));
        if (seen) zones.push([z.x, z.y, z.r]);
      }
    }
    return { chunks, buildings, units, zones };
  }

  findNearest(u: UnitState, kind: string): ObjectRef | null {
    if (kind === "ruin" || kind === "creature" || kind === "unit" || kind === "enemy" || kind === "enemy_building" || kind === "monster" || kind === "boss" || kind === "paddock" || CREATURE_TYPES.includes(kind) || MONSTER_TYPES.includes(kind)) return this.scan(u, kind, 1)[0] ?? null;
    if (isNodeKind(kind) && u.owner === NEUTRAL && this.guardZones.length > 0) return this.scan(u, kind, 1)[0] ?? null;
    const radius = Math.round(this.stat(u.owner, "senseRadius", unitDef(u.type).senseRadius));
    if (kind === "storage" || kind === "construction") {
      let best: BuildingState | null = null;
      let bestD = Infinity;
      for (const id of this.buildingsOf(u.owner)) {
        const b = this.buildings.get(id);
        if (!b) continue;
        const want = kind === "storage" ? b.complete && buildingDef(b.type).storage : !b.complete;
        if (!want) continue;
        const d = distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
        if (d <= radius * 3 && (d < bestD || (d === bestD && best && b.id < best.id))) {
          best = b;
          bestD = d;
        }
      }
      return best ? this.buildingRef(best) : null;
    }
    if (!isNodeKind(kind)) return null;
    for (let r = 1; r <= radius; r++) {
      let found: { x: number; y: number } | null = null;
      for (let dy = -r; dy <= r; dy++) {
        const step = Math.abs(dy) === r ? 1 : 2 * r;
        for (let dx = -r; dx <= r; dx += step) {
          const x = u.x + dx;
          const y = u.y + dy;
          const n = this.chunks.nodeAt(x, y);
          if (!n || n.kind !== kind || this.chunks.amountOf(n) <= 0) continue;
          const avoidUntil = u.avoid.get(`node:${x}:${y}`);
          if (avoidUntil !== undefined && avoidUntil > this.tick) continue;
          if (!this.hasOpenNeighbour(x, y)) continue;
          if (!found || y < found.y || (y === found.y && x < found.x)) found = { x, y };
        }
      }
      if (found) {
        const n = this.chunks.nodeAt(found.x, found.y);
        return new ObjectRef(`node:${found.x}:${found.y}`, kind, found.x, found.y, n ? this.chunks.amountOf(n) : 0);
      }
    }
    return null;
  }

  /** Up to `limit` objects of a kind within sensing range, nearest first (deterministic tie-breaks). */
  scan(u: UnitState, kind: string, limit: number): ObjectRef[] {
    const radius = Math.round(this.stat(u.owner, "senseRadius", unitDef(u.type).senseRadius));
    const out: { ref: ObjectRef; d: number }[] = [];
    const push = (ref: ObjectRef, d: number): void => {
      out.push({ ref, d });
    };
    if (kind === "storage" || kind === "construction" || kind === "paddock") {
      for (const id of this.buildingsOf(u.owner)) {
        const b = this.buildings.get(id);
        if (!b) continue;
        const want = kind === "storage" ? b.complete && buildingDef(b.type).storage : kind === "paddock" ? b.complete && this.penBlocker(u, b) === null : !b.complete;
        const d = distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
        if (want && d <= radius * 3) push(this.buildingRef(b), d);
      }
    } else if (kind === "ruin") {
      for (const r of this.chunks.ruinsNear(u.x, u.y, radius)) {
        push(new ObjectRef(`ruin:${r.x}:${r.y}`, "ruin", r.x, r.y, this.lootedRuins.has(`${r.x},${r.y}`) ? 0 : 1), chebyshev(u.x, u.y, r.x, r.y));
      }
    } else if (kind === "enemy_building") {
      // Other players' buildings this unit may attack right now (PvP, both opted in).
      if (!this.cfg.combatEnabled) return [];
      const s = this.chunks.size;
      const seen = new Set<number>();
      for (let cy = floorDiv(u.y - radius, s); cy <= floorDiv(u.y + radius, s); cy++) {
        for (let cx = floorDiv(u.x - radius, s); cx <= floorDiv(u.x + radius, s); cx++) {
          for (const id of this.buildingsInChunk(chunkKey(cx, cy))) {
            if (seen.has(id)) continue;
            seen.add(id);
            const b = this.buildings.get(id);
            if (!b || this.buildingAttackBlocker(u, b) !== null) continue;
            const d = distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
            if (d <= radius) push(this.buildingRef(b), d);
          }
        }
      }
    } else if (kind === "creature" || kind === "unit" || kind === "enemy" || kind === "monster" || kind === "boss" || CREATURE_TYPES.includes(kind) || MONSTER_TYPES.includes(kind)) {
      if ((kind === "enemy" || kind === "monster" || kind === "boss") && !this.fightingEnabled) return [];
      const s = this.chunks.size;
      for (let cy = floorDiv(u.y - radius, s); cy <= floorDiv(u.y + radius, s); cy++) {
        for (let cx = floorDiv(u.x - radius, s); cx <= floorDiv(u.x + radius, s); cx++) {
          for (const id of this.unitsInChunk(chunkKey(cx, cy))) {
            const o = this.units.get(id);
            if (!o || o.id === u.id) continue;
            if (o.pen !== null && kind !== "unit") continue;
            const ok =
              kind === "unit"
                ? o.owner === u.owner
                : kind === "creature"
                  ? o.owner === NEUTRAL && !!unitDef(o.type).creature
                  : kind === "enemy"
                    ? o.owner !== NEUTRAL && this.attackBlocker(u, o) === null
                    : kind === "monster" || kind === "boss"
                      ? this.isMonster(o) && (kind === "monster" || !!unitDef(o.type).monster?.boss) && this.attackBlocker(u, o) === null
                      : o.type === kind && o.owner === NEUTRAL;
            const d = chebyshev(u.x, u.y, o.x, o.y);
            if (ok && d <= radius) push(this.unitRef(o), d);
          }
        }
      }
    } else if (isNodeKind(kind)) {
      for (let r = 1; r <= radius && out.length < limit; r++) {
        for (let dy = -r; dy <= r; dy++) {
          const step = Math.abs(dy) === r ? 1 : 2 * r;
          for (let dx = -r; dx <= r; dx += step) {
            const x = u.x + dx;
            const y = u.y + dy;
            const n = this.chunks.nodeAt(x, y);
            if (!n || n.kind !== kind) continue;
            const amount = this.chunks.amountOf(n);
            if (amount <= 0) continue;
            const avoidUntil = u.avoid.get(`node:${x}:${y}`);
            if (avoidUntil !== undefined && avoidUntil > this.tick) continue;
            if (!this.hasOpenNeighbour(x, y)) continue;
            // Wild creatures keep away from resources near a guarding (tamed) creature.
            if (u.owner === NEUTRAL && this.guardZones.some((g) => chebyshev(g.x, g.y, x, y) <= 8)) continue;
            push(new ObjectRef(`node:${x}:${y}`, kind, x, y, amount), r);
          }
        }
      }
    } else {
      return [];
    }
    out.sort((a, b) => a.d - b.d || a.ref.y - b.ref.y || a.ref.x - b.ref.x || (a.ref.id < b.ref.id ? -1 : 1));
    return out.slice(0, limit).map((o) => o.ref);
  }

  unitRef(o: UnitState): ObjectRef {
    return new ObjectRef(`u:${o.id}`, o.type, o.x, o.y, null);
  }

  unitFromRef(ref: ObjectRef): UnitState | undefined {
    if (!ref.id.startsWith("u:")) return undefined;
    return this.units.get(Number(ref.id.slice(2)));
  }

  // ------------------------------------------------------------------ wildlife and discovery

  /** Wildlife only acts near players (bounded cost on an infinite map). */
  private isAwake(u: UnitState): boolean {
    if (u.owner !== NEUTRAL) return true;
    return this.activeChunks.has(chunkKey(floorDiv(u.x, this.chunks.size), floorDiv(u.y, this.chunks.size)));
  }

  private refreshActiveChunks(): void {
    const set = new Set<string>();
    for (const pid of this.players.keys()) {
      for (const key of this.presenceChunks(pid)) {
        const [cx, cy] = key.split(",").map(Number) as [number, number];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set.add(chunkKey(cx + dx, cy + dy));
      }
    }
    this.renewList = [...set];
    // Newly active chunks get their wildlife the first time a player comes near.
    for (const key of set) if (!this.activeChunks.has(key) && !this.populated.has(key)) this.pendingSpawns.push(key);
    this.activeChunks = set;
  }

  /**
   * Spawn wildlife in chunks that have become active (near a player), at most
   * SPAWN_CHUNKS_PER_TICK per tick so a player arriving in a new region never stalls a tick.
   * Runs at the start of a tick, never during iteration.
   */
  private processSpawns(): void {
    if (this.pendingSpawns.length === 0) return;
    const batch = this.pendingSpawns.splice(0, SPAWN_CHUNKS_PER_TICK);
    let wild = this.unitsOf(NEUTRAL).size;
    for (const key of batch) {
      if (this.populated.has(key)) continue;
      const [cx, cy] = key.split(",").map(Number) as [number, number];
      let creatures = this.spawnLists.get(key);
      if (!creatures) {
        this.chunks.getChunk(cx, cy); // generates it if needed, which records its spawn list
        creatures = this.spawnLists.get(key) ?? this.gen.generateChunk(cx, cy).creatures;
      }
      this.spawnLists.delete(key);
      this.populated.add(key);
      this.populatedNew.push(key);
      for (const c of creatures) {
        if (wild >= MAX_WILDLIFE) break;
        if (!this.isPassable(c.x, c.y) || !findUnitDef(c.type)?.creature) continue;
        this.spawnCreature(c.type, c.x, c.y);
        wild++;
      }
    }
  }

  /**
   * Wildlife renewal: once per second, look at one active, already-populated chunk (round
   * robin). If fewer of its creatures are alive (hunted or tamed) than it started with, one
   * returns, at most one per chunk every WILDLIFE_RENEW_SECONDS, and only on unclaimed land.
   */
  private renewWildlife(): void {
    if (this.renewList.length === 0) return;
    const key = this.renewList[this.renewCursor++ % this.renewList.length] as string;
    if (!this.populated.has(key) || !this.activeChunks.has(key)) return;
    const last = this.lastRenewal.get(key);
    if (last !== undefined && this.tick - last < WILDLIFE_RENEW_SECONDS * this.cfg.tickRate) return;
    if (this.unitsOf(NEUTRAL).size >= MAX_WILDLIFE) return;
    const [cx, cy] = key.split(",").map(Number) as [number, number];
    let template = this.spawnTemplates.get(key);
    if (!template) {
      template = this.gen.generateChunk(cx, cy).creatures;
      if (this.spawnTemplates.size >= 5000) this.spawnTemplates.clear();
      this.spawnTemplates.set(key, template);
    }
    if (template.length === 0) return;
    const size = this.chunks.size;
    const alive = new Map<string, number>();
    for (const id of this.unitsOf(NEUTRAL)) {
      const c = this.units.get(id);
      if (c?.home && floorDiv(c.home.x, size) === cx && floorDiv(c.home.y, size) === cy) alive.set(c.type, (alive.get(c.type) ?? 0) + 1);
    }
    const wanted = new Map<string, number>();
    for (const t of template) {
      const n = (wanted.get(t.type) ?? 0) + 1;
      wanted.set(t.type, n);
      if (n <= (alive.get(t.type) ?? 0)) continue;
      // This creature is missing: bring it back at its original spot if that is still wild land.
      if (!this.isPassable(t.x, t.y) || this.territory.ownerAt(t.x, t.y) !== 0 || !findUnitDef(t.type)?.creature) continue;
      this.spawnCreature(t.type, t.x, t.y);
      this.lastRenewal.set(key, this.tick);
      return;
    }
  }

  spawnCreature(type: string, x: number, y: number): UnitState {
    const u = this.newUnitState(this.allocId(), NEUTRAL, type, x, y);
    const def = unitDef(type);
    u.program.source = def.creature?.wildProgram ?? def.defaultProgram;
    u.home = { x, y };
    this.units.set(u.id, u);
    this.indexUnit(u);
    this.markUnit(u);
    this.controlProgramInternal(u, "run");
    return u;
  }

  private grantDiscovery(p: PlayerState, id: string, source: string): boolean {
    const d = findDiscoveryDef(id);
    if (!d || p.discoveries.includes(id)) return false;
    p.discoveries.push(id);
    this.invalidateMods(p.id);
    this.markPlayer(p);
    this.audit.push({ tick: this.tick, playerId: p.id, action: "discovery", detail: `${id} (${source})` });
    this.awardXp(p, XP_AWARDS.perDiscovery, "discovery");
    this.onModifiersChanged(p);
    for (const uid of this.unitsOf(p.id)) {
      const unit = this.units.get(uid);
      if (unit) this.log(unit, `Discovery: ${d.name} - ${d.description}`);
      break;
    }
    return true;
  }

  private hasOpenNeighbour(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && this.isPassable(x + dx, y + dy)) return true;
    return false;
  }

  buildingRef(b: BuildingState): ObjectRef {
    return new ObjectRef(`b:${b.id}`, b.complete ? b.type : "construction", b.x, b.y, null);
  }

  /** Does the object referenced still exist? */
  refExists(ref: ObjectRef): boolean {
    if (ref.id.startsWith("b:")) return this.buildingFromRef(ref) !== undefined;
    if (ref.id.startsWith("u:")) return this.unitFromRef(ref) !== undefined;
    if (ref.id.startsWith("ruin:")) return this.chunks.ruinAt(ref.x, ref.y) !== undefined;
    return this.chunks.nodeAt(ref.x, ref.y)?.kind === ref.kind;
  }

  // ------------------------------------------------------------------ storage (shared stock or storage networks)


  // ------------------------------------------------------------------ coding lessons

  /** Program features per unit, recomputed only when its source changes. */
  private readonly featureCache = new Map<number, { source: string; f: SourceFeatures }>();

  /** Something a unit's program did: complete any lessons it satisfies (experience, notice, audit). */
  lessonEvent(u: UnitState, ev: LessonEvent): void {
    const p = this.players.get(u.owner);
    if (!p || p.lessons.length >= LESSONS.length) return;
    // Only code the player saved counts, never a unit's built-in default program.
    if (u.program.version <= 0 || u.program.source === unitDef(u.type).defaultProgram) return;
    let c = this.featureCache.get(u.id);
    if (!c || c.source !== u.program.source) {
      c = { source: u.program.source, f: sourceFeatures(u.program.source) };
      this.featureCache.set(u.id, c);
    }
    for (const l of LESSONS) {
      if (p.lessons.includes(l.id) || !l.check(ev, c.f)) continue;
      p.lessons.push(l.id);
      this.markPlayer(p);
      this.awardXp(p, l.xp, "lesson");
      this.notice(p.id, "success", `Lesson complete: ${l.title} (+${l.xp} XP)`);
      this.audit.push({ tick: this.tick, playerId: p.id, action: "lesson", detail: l.id });
    }
  }

  // ------------------------------------------------------------------ heroes

  /** The player's living hero, if any. */
  heroOf(playerId: number): UnitState | undefined {
    const id = this.players.get(playerId)?.hero.unitId;
    return id === null || id === undefined ? undefined : this.units.get(id);
  }

  isHero(u: UnitState): boolean {
    return unitDef(u.type).hero === true;
  }

  /** Heroes grow with the player's level. */
  private heroScale(owner: number): number {
    const p = this.players.get(owner);
    return p ? 1 + HERO_LEVEL_SCALING * (this.level(p) - 1) : 1;
  }

  unitMaxHp(u: UnitState): number {
    const base = unitDef(u.type).maxHp;
    if (!this.isHero(u)) return base;
    return Math.round(base * this.heroScale(u.owner) * this.mods(u.owner).factor("heroHp"));
  }

  unitDamage(u: UnitState): number {
    const atk = unitDef(u.type).attack;
    if (!atk) return 0;
    const own = u.owner !== NEUTRAL ? this.mods(u.owner).pct.damage : 0;
    let d = atk.damage * Math.max(0.2, 1 + this.unitPct(u, "damage") + own);
    if (this.isHero(u)) d *= this.heroScale(u.owner) * this.mods(u.owner).factor("heroDamage");
    return Math.max(1, Math.round(d));
  }

  /** Fraction of incoming damage absorbed (hero armor plus auras and shields), at most 80%. */
  unitArmor(u: UnitState): number {
    const own = u.owner !== NEUTRAL ? this.mods(u.owner).pct.armor : 0;
    return Math.min(0.8, Math.max(0, (heroDefForType(u.type)?.armor ?? 0) + this.unitPct(u, "armor") + own));
  }

  hasBuff(e: { buffs: Buff[] }, stat: string): boolean {
    for (const b of e.buffs) if (b.stat === stat && b.until > this.tick) return true;
    return false;
  }

  /** Radius after the player's aura research. */
  heroRadius(owner: number, base: number): number {
    return Math.round(base * this.mods(owner).factor("heroAura"));
  }

  /** Sum of active ability effects and the owner's hero aura on one stat of a unit. */
  unitPct(u: UnitState, stat: string): number {
    let pct = 0;
    for (const b of u.buffs) if (b.stat === stat && b.until > this.tick) pct += b.pct;
    if (u.owner !== NEUTRAL) {
      const hid = this.players.get(u.owner)?.hero.unitId;
      if (hid !== null && hid !== undefined) {
        const h = this.units.get(hid);
        const aura = h ? heroDefForType(h.type)?.aura : null;
        if (h && aura) {
          let match = false;
          for (const e of aura.effects) if (e.stat === stat) match = true;
          if (match && chebyshev(h.x, h.y, u.x, u.y) <= this.heroRadius(u.owner, aura.radius)) for (const e of aura.effects) if (e.stat === stat) pct += e.pct;
        }
      }
    }
    return pct;
  }

  /** Training and research speed multiplier at a building (Muster, Inspiration). */
  private orderSpeed(b: BuildingState, order: TrainOrder): number {
    if (b.buffs.length === 0) return 1;
    const stat = order.kind === "tech" ? "researchTime" : "trainTime";
    let pct = 0;
    for (const x of b.buffs) if (x.stat === stat && x.until > this.tick) pct += x.pct;
    return 1 / Math.max(0.2, 1 + pct);
  }

  private addBuff(target: { buffs: Buff[] }, spec: BuffSpec, seconds: number, source: string): void {
    const until = this.tick + Math.round(seconds * this.cfg.tickRate);
    const i = target.buffs.findIndex((b) => b.stat === spec.stat && b.source === source);
    if (i >= 0) target.buffs[i] = { stat: spec.stat, pct: spec.pct, until, source };
    else target.buffs.push({ stat: spec.stat, pct: spec.pct, until, source });
  }

  /** Once a second: drop ended ability effects and Farsight reveals. */
  private expireBuffs(): void {
    for (const id of this.buffedUnits) {
      const u = this.units.get(id);
      if (!u) {
        this.buffedUnits.delete(id);
        continue;
      }
      const before = u.buffs.length;
      u.buffs = u.buffs.filter((b) => b.until > this.tick);
      if (u.buffs.length !== before) this.markUnit(u);
      if (u.buffs.length === 0) this.buffedUnits.delete(id);
    }
    for (const id of this.buffedBuildings) {
      const b = this.buildings.get(id);
      if (!b) {
        this.buffedBuildings.delete(id);
        continue;
      }
      const before = b.buffs.length;
      b.buffs = b.buffs.filter((x) => x.until > this.tick);
      if (b.buffs.length !== before) this.markBuilding(b);
      if (b.buffs.length === 0) this.buffedBuildings.delete(id);
    }
    if (this.reveals.length) this.reveals = this.reveals.filter((r) => r.until > this.tick);
  }

  /** Without combat nothing can hurt a hero, so it simply stays at full health as its maximum grows. */
  private keepHeroesHealthy(): void {
    for (const p of this.players.values()) {
      const h = this.heroOf(p.id);
      if (!h) continue;
      const max = this.unitMaxHp(h);
      if (h.hp !== max) {
        h.hp = max;
        this.markUnit(h);
      }
    }
  }

  /** Cost and seconds to recruit (first time) or revive the player's hero. */
  heroOrderCost(playerId: number): { cost: ResourceBag; time: number; revive: boolean } {
    const p = this.players.get(playerId);
    if (!p || !p.hero.recruited) {
      const cost = emptyBag();
      for (const r of RESOURCE_TYPES) cost[r] = HERO_RECRUIT_COST[r] ?? 0;
      return { cost, time: HERO_RECRUIT_SECONDS, revive: false };
    }
    const base = heroReviveBase(this.level(p));
    const f = (heroDefForRace(p.race)?.reviveFactor ?? 1) * this.mods(playerId).factor("heroRevive");
    const cost = emptyBag();
    for (const r of RESOURCE_TYPES) cost[r] = Math.ceil(base.cost[r] * f);
    return { cost, time: Math.max(5, Math.round(base.time * f)), revive: true };
  }

  /** Queue recruiting (or reviving) the player's hero at a Town Hall (or, to revive, a Barracks). */
  recruitHero(playerId: number, buildingId: number): CommandResult<BuildingState> {
    const r = this.ownBuilding(playerId, buildingId);
    if (!r.ok) return r;
    const b = r.value;
    const p = this.players.get(playerId) as PlayerState;
    const hd = heroDefForRace(p.race);
    if (!hd) return fail("no_hero", "Your race has no hero");
    if (!HERO_BUILDINGS.includes(b.type)) return fail("cannot_train", "Heroes are recruited at a Town Hall and revived at a Town Hall or Barracks");
    if (b.type !== "town_hall" && !p.hero.recruited) return fail("cannot_train", `Recruit your ${hd.name} at a Town Hall first; a Barracks can revive them later`);
    if (!b.complete) return fail("incomplete", `${buildingDef(b.type).name} is still under construction`);
    if (this.heroOf(playerId)) return fail("hero_alive", `Your ${hd.name} is alive: each player has one hero`);
    for (const id of this.buildingsOf(playerId)) {
      if (this.buildings.get(id)?.queue.some((q) => q.kind === "hero")) return fail("already_queued", `Your ${hd.name} is already being ${p.hero.recruited ? "revived" : "recruited"}`);
    }
    if (b.queue.length >= BALANCE.maxTrainQueue) return fail("queue_full", "Training queue is full");
    // The hero does not count toward (and is never blocked by) the unit limit.
    const o = this.heroOrderCost(playerId);
    const paid = this.payAt(playerId, b, o.cost, `${o.revive ? "reviving" : "recruiting"} your ${hd.name}`);
    if (!paid.ok) return paid;
    b.queue.push({ kind: "hero", revive: o.revive, progress: 0, time: o.time });
    this.markPlayer(p);
    this.markBuilding(b);
    this.audit.push({ tick: this.tick, playerId, action: o.revive ? "hero_revive" : "hero_recruit", detail: `at #${b.id} cost ${formatCost(o.cost)}` });
    return ok(b);
  }

  /** Queue one rank of Barracks battle training. Ranks are kept when the hero falls. */
  trainHero(playerId: number, buildingId: number, track: string): CommandResult<BuildingState> {
    const r = this.ownBuilding(playerId, buildingId);
    if (!r.ok) return r;
    const b = r.value;
    const p = this.players.get(playerId) as PlayerState;
    const td = Object.hasOwn(HERO_TRAINING, track) ? HERO_TRAINING[track] : undefined;
    if (!td) return fail("bad_type", `Unknown battle training '${track}'. Choose ${Object.keys(HERO_TRAINING).join(", ")}`);
    if (b.type !== "barracks") return fail("cannot_train", "Battle training happens at a Barracks");
    if (!b.complete) return fail("incomplete", "Barracks is still under construction");
    const hd = heroDefForRace(p.race);
    if (!hd || !p.hero.recruited) return fail("no_hero", "Recruit your hero at a Town Hall first");
    let queued = 0;
    for (const id of this.buildingsOf(playerId)) for (const q of this.buildings.get(id)?.queue ?? []) if (q.kind === "hero_training" && q.track === track) queued++;
    const next = (p.hero.ranks[track] ?? 0) + queued + 1;
    if (next > td.maxRank) return fail("max_rank", `${td.name} training is already at (or queued to) its highest rank, ${td.maxRank}`);
    if (b.queue.length >= BALANCE.maxTrainQueue) return fail("queue_full", "Training queue is full");
    const c = heroTrainingCost(next);
    const paid = this.payAt(playerId, b, c.cost, `${td.name} training rank ${next}`);
    if (!paid.ok) return paid;
    b.queue.push({ kind: "hero_training", track, rank: next, progress: 0, time: c.time });
    this.markPlayer(p);
    this.markBuilding(b);
    this.audit.push({ tick: this.tick, playerId, action: "hero_training", detail: `${track} rank ${next} at #${b.id} cost ${formatCost(c.cost)}` });
    return ok(b);
  }

  private spawnHero(playerId: number, x: number, y: number): void {
    const p = this.players.get(playerId);
    const hd = p ? heroDefForRace(p.race) : undefined;
    if (!p || !hd || this.heroOf(playerId)) return;
    const revive = p.hero.recruited;
    const u = this.addUnit(playerId, hd.type, x, y, true);
    p.hero.unitId = u.id;
    p.hero.recruited = true;
    this.markPlayer(p);
    this.notice(playerId, "success", revive ? `Your ${hd.name} has returned.` : `Your ${hd.name} has arrived! Select them to see their abilities.`);
    this.audit.push({ tick: this.tick, playerId, action: revive ? "hero_revived" : "hero_recruited", detail: `${u.type} #${u.id}` });
  }

  private completeHeroTraining(playerId: number, track: string, rank: number): void {
    const p = this.players.get(playerId);
    const td = HERO_TRAINING[track];
    if (!p || !td) return;
    const hero = this.heroOf(playerId);
    const before = hero ? this.unitMaxHp(hero) : 0;
    p.hero.ranks[track] = Math.max(p.hero.ranks[track] ?? 0, rank);
    this.invalidateMods(playerId);
    this.markPlayer(p);
    if (hero) {
      // Vitality raises current health along with the maximum.
      hero.hp = Math.min(this.unitMaxHp(hero), hero.hp + Math.max(0, this.unitMaxHp(hero) - before));
      this.markUnit(hero);
    }
    this.notice(playerId, "success", `Battle training complete: ${td.name} rank ${rank}.`);
    this.audit.push({ tick: this.tick, playerId, action: "hero_trained", detail: `${track} rank ${rank}` });
  }

  /** Seconds until an ability can be used again (0 = ready). */
  abilityReadyIn(u: UnitState, abilityId: string): number {
    const at = u.cooldowns[abilityId] ?? 0;
    return at > this.tick ? Math.ceil((at - this.tick) / this.cfg.tickRate) : 0;
  }

  /** A player uses their hero's ability (UI). */
  useAbility(playerId: number, unitId: number, abilityId: string, target: AbilityTarget): CommandResult<string> {
    const r = this.ownUnit(playerId, unitId);
    if (!r.ok) return r;
    return this.castAbility(r.value, abilityId, target);
  }

  /** Validate and apply an ability, then start its cooldown. Nothing changes when it fails. */
  castAbility(u: UnitState, abilityId: string, target: AbilityTarget): CommandResult<string> {
    const hd = heroDefForType(u.type);
    if (!hd) return fail("not_hero", "Only your hero has abilities");
    const ab = findAbility(hd, abilityId);
    if (!ab) return fail("bad_ability", `The ${hd.name} has no ability '${abilityId}'. Abilities: ${hd.abilities.map((a) => a.id).join(", ")}`);
    if (ab.combat && !this.fightingEnabled) return fail("combat_disabled", `${ab.name} needs combat or PvE, which are disabled on this server`);
    const wait = this.abilityReadyIn(u, ab.id);
    if (wait > 0) return fail("cooldown", `${ab.name} is ready again in ${wait} s`);
    const res = this.applyAbility(u, hd, ab, target);
    if (!res.ok) return res;
    u.cooldowns[ab.id] = this.tick + Math.max(1, Math.round(ab.cooldown * this.mods(u.owner).factor("heroCooldown") * this.cfg.tickRate));
    this.log(u, `${ab.name}: ${res.value}`);
    this.markUnit(u);
    this.audit.push({ tick: this.tick, playerId: u.owner, action: "ability", detail: `${ab.id} by #${u.id}: ${res.value}` });
    return res;
  }

  private ownUnitsNear(owner: number, x: number, y: number, radius: number): UnitState[] {
    const out: UnitState[] = [];
    for (const id of this.unitsOf(owner)) {
      const o = this.units.get(id);
      if (o && chebyshev(o.x, o.y, x, y) <= radius) out.push(o);
    }
    return out;
  }

  private ownBuildingsNear(owner: number, x: number, y: number, radius: number): BuildingState[] {
    const out: BuildingState[] = [];
    for (const id of this.buildingsOf(owner)) {
      const b = this.buildings.get(id);
      if (b && distToRect(x, y, b.x, b.y, b.w, b.h) <= radius) out.push(b);
    }
    return out;
  }

  /** Units of any owner near a point (chunk index, bounded by the radius). */
  private unitsNear(x: number, y: number, radius: number): UnitState[] {
    const s = this.chunks.size;
    const out: UnitState[] = [];
    for (let cy = floorDiv(y - radius, s); cy <= floorDiv(y + radius, s); cy++) {
      for (let cx = floorDiv(x - radius, s); cx <= floorDiv(x + radius, s); cx++) {
        for (const id of this.unitsInChunk(chunkKey(cx, cy))) {
          const o = this.units.get(id);
          if (o && chebyshev(o.x, o.y, x, y) <= radius) out.push(o);
        }
      }
    }
    return out;
  }

  private targetUnit(target: AbilityTarget): UnitState | undefined {
    return target && "unitId" in target ? this.units.get(target.unitId) : undefined;
  }

  private targetPoint(target: AbilityTarget): { x: number; y: number } | null {
    if (!target) return null;
    if ("unitId" in target) {
      const t = this.units.get(target.unitId);
      return t ? { x: t.x, y: t.y } : null;
    }
    return { x: target.x, y: target.y };
  }

  private applyAbility(u: UnitState, hd: HeroDef, ab: AbilityDef, target: AbilityTarget): CommandResult<string> {
    const e = ab.effect;
    const radius = (base: number): number => this.heroRadius(u.owner, base);
    const power = this.heroScale(u.owner) * this.mods(u.owner).factor("heroDamage");
    switch (e.kind) {
      case "heal_area": {
        const r = radius(e.radius);
        let healed = 0;
        for (const o of this.ownUnitsNear(u.owner, u.x, u.y, r)) {
          const max = this.unitMaxHp(o);
          if (o.hp >= max) continue;
          o.hp = Math.min(max, o.hp + e.amount);
          this.markUnit(o);
          healed++;
        }
        if (healed === 0) return fail("no_effect", `No wounded units of yours within ${r} tiles`);
        return ok(`healed ${healed} unit${healed === 1 ? "" : "s"}`);
      }
      case "buff_units": {
        const r = radius(e.radius);
        const units = this.ownUnitsNear(u.owner, u.x, u.y, r);
        for (const o of units) {
          for (const spec of e.buffs) this.addBuff(o, spec, e.duration, ab.id);
          this.buffedUnits.add(o.id);
          this.markUnit(o);
        }
        return ok(`${units.length} unit${units.length === 1 ? "" : "s"} affected for ${e.duration} s`);
      }
      case "buff_buildings": {
        const r = radius(e.radius);
        const bs = this.ownBuildingsNear(u.owner, u.x, u.y, r).filter((b) => b.complete);
        if (bs.length === 0) return fail("no_effect", `No completed buildings of yours within ${r} tiles`);
        for (const b of bs) {
          for (const spec of e.buffs) this.addBuff(b, spec, e.duration, ab.id);
          this.buffedBuildings.add(b.id);
          this.markBuilding(b);
        }
        return ok(`${bs.length} building${bs.length === 1 ? "" : "s"} affected for ${e.duration} s`);
      }
      case "self_buff": {
        for (const spec of e.buffs) this.addBuff(u, spec, e.duration, ab.id);
        this.buffedUnits.add(u.id);
        return ok(`active for ${e.duration} s`);
      }
      case "construct": {
        const r = radius(e.radius);
        const sites = this.ownBuildingsNear(u.owner, u.x, u.y, r).filter((b) => !b.complete);
        if (sites.length === 0) return fail("no_effect", `No construction sites of yours within ${r} tiles`);
        let done = 0;
        for (const b of sites) if (this.addConstruction(b, buildingDef(b.type).buildTime * e.fraction)) done++;
        return ok(`${sites.length} site${sites.length === 1 ? "" : "s"} advanced${done ? `, ${done} completed` : ""}`);
      }
      case "convert": {
        const paid = this.payAt(u.owner, { x: u.x, y: u.y, w: 1, h: 1 }, e.from, ab.name);
        if (!paid.ok) return paid;
        if (!this.deliver(u.owner, u.x, u.y, e.to)) {
          // No storage with room: give the payment back (nothing may be lost).
          this.deliver(u.owner, u.x, u.y, e.from);
          return fail("storage_full", "No storage with room for the result");
        }
        const p = this.players.get(u.owner);
        if (p) this.markPlayer(p);
        return ok(`turned ${formatCost(e.from)} into ${formatCost(e.to)}`);
      }
      case "tame_nearest": {
        const r = radius(e.radius);
        let best: UnitState | undefined;
        let bestD = Infinity;
        for (const c of this.unitsNear(u.x, u.y, r)) {
          if (c.owner !== NEUTRAL || (unitDef(c.type).creature?.tameCost ?? 0) <= 0) continue;
          const d = chebyshev(c.x, c.y, u.x, u.y);
          if (d < bestD) {
            best = c;
            bestD = d;
          }
        }
        if (!best) return fail("no_effect", `No tameable wild animal within ${r} tiles`);
        const cap = this.unitCap(u.owner);
        if (this.limitedUnits(u.owner) >= cap) return fail("limit", `Unit limit (${cap}) reached: research Administration at a Library to raise it`);
        this.adoptCreature(best, u.owner);
        return ok(`tamed a ${unitDef(best.type).name.toLowerCase()} (#${best.id})`);
      }
      case "teleport": {
        const pt = this.targetPoint(target);
        if (!pt) return fail("no_target", `${ab.name} needs a destination`);
        const max = e.range;
        if (chebyshev(pt.x, pt.y, u.x, u.y) > max) return fail("out_of_range", `${ab.name} reaches at most ${max} tiles`);
        const spot = this.nearestPassable(pt.x, pt.y, 2);
        if (!spot || chebyshev(spot.x, spot.y, u.x, u.y) > max + 2) return fail("blocked", "No open ground there");
        this.moveUnitTo(u, spot.x, spot.y);
        u.path = null;
        this.noteExplored(u);
        this.markUnit(u);
        return ok(`stepped to ${spot.x}, ${spot.y}`);
      }
      case "reveal": {
        const pt = this.targetPoint(target);
        if (!pt) return fail("no_target", `${ab.name} needs a point to reveal`);
        if (chebyshev(pt.x, pt.y, u.x, u.y) > e.range) return fail("out_of_range", `${ab.name} reaches at most ${e.range} tiles`);
        const r = radius(e.radius);
        this.reveals.push({ owner: u.owner, x: pt.x, y: pt.y, radius: r, until: this.tick + e.duration * this.cfg.tickRate });
        return ok(`revealing ${pt.x}, ${pt.y} for ${e.duration} s`);
      }
      case "strike": {
        const t = this.targetUnit(target);
        if (!t) return fail("no_target", `${ab.name} needs a target unit`);
        const why = this.attackBlocker(u, t);
        if (why) return fail("cannot_attack", why);
        if (chebyshev(t.x, t.y, u.x, u.y) > e.range) return fail("out_of_range", `${ab.name} reaches at most ${e.range} tile${e.range === 1 ? "" : "s"}`);
        const bonus = e.hiddenBonus && this.isStealthy(u) ? 1 + e.hiddenBonus : 1;
        const dealt = this.damageUnit(t, e.damage * power * bonus, u);
        if (e.lifesteal && dealt > 0) {
          u.hp = Math.min(this.unitMaxHp(u), u.hp + Math.round(dealt * e.lifesteal));
          this.markUnit(u);
        }
        return ok(`${dealt} damage to ${this.ownerLabel(t.owner)}'s ${unitDef(t.type).name.toLowerCase()}${bonus > 1 ? " (from hiding)" : ""}`);
      }
      case "area_damage": {
        const r = radius(e.radius);
        const victims = this.unitsNear(u.x, u.y, r).filter((t) => t.id !== u.id && this.attackBlocker(u, t) === null);
        if (victims.length === 0) return fail("no_effect", `No units you may attack within ${r} tiles`);
        let total = 0;
        for (const t of victims) {
          if (!this.units.has(t.id)) continue;
          if (e.slow && this.units.has(t.id)) {
            this.addBuff(t, { stat: "moveSpeed", pct: -e.slow }, e.slowDuration ?? 5, ab.id);
            this.buffedUnits.add(t.id);
          }
          total += this.damageUnit(t, e.damage * power, u);
        }
        return ok(`${total} damage to ${victims.length} unit${victims.length === 1 ? "" : "s"}`);
      }
      case "debuff": {
        const t = this.targetUnit(target);
        if (!t) return fail("no_target", `${ab.name} needs a target unit`);
        const why = this.attackBlocker(u, t);
        if (why) return fail("cannot_attack", why);
        if (chebyshev(t.x, t.y, u.x, u.y) > e.range) return fail("out_of_range", `${ab.name} reaches at most ${e.range} tiles`);
        this.addBuff(t, { stat: "vulnerable", pct: e.vulnerable }, e.duration, ab.id);
        this.addBuff(t, { stat: "moveSpeed", pct: -e.slow }, e.duration, ab.id);
        this.buffedUnits.add(t.id);
        this.markUnit(t);
        // Cursing counts as an attack: it reveals both and lets the target fight back.
        t.revealedUntil = u.revealedUntil = this.tick + REVEAL_SECONDS * this.cfg.tickRate;
        t.lastHit = { by: u.id, owner: u.owner, tick: this.tick };
        if (t.owner === NEUTRAL) (t.provokedBy ??= new Map()).set(u.owner, this.tick);
        return ok(`hexed ${this.ownerLabel(t.owner)}'s ${unitDef(t.type).name.toLowerCase()} for ${e.duration} s`);
      }
    }
  }

  get networksMode(): boolean {
    return this.cfg.storageMode === "networks";
  }

  /** Unit limit: the base plus research (Administration and successors), capped by the server ceiling. */
  /** Units that count toward the unit limit (everything except the hero). */
  limitedUnits(playerId: number): number {
    let penned = 0;
    for (const id of this.unitsOf(playerId)) {
      const u = this.units.get(id);
      if (u && u.pen !== null) penned++;
    }
    return this.unitsOf(playerId).size - (this.heroOf(playerId) ? 1 : 0) - penned;
  }

  unitCap(playerId: number): number {
    return Math.min(this.cfg.unitLimitCeiling, Math.round(this.stat(playerId, "unitCap", BALANCE.maxUnitsPerPlayer)));
  }

  buildingCap(playerId: number): number {
    return Math.min(this.cfg.buildingLimitCeiling, Math.round(this.stat(playerId, "buildingCap", BALANCE.maxBuildingsPerPlayer)));
  }

  /** Items a storage building can hold (0 for other buildings and construction sites; unlimited in shared mode). */
  storageCapacityOf(b: BuildingState): number {
    const def = buildingDef(b.type);
    if (!def.storage || !b.complete) return 0;
    if (!this.networksMode) return Number.POSITIVE_INFINITY;
    return Math.round(this.stat(b.owner, "storageCapacity", def.storageCapacity));
  }

  storageFree(b: BuildingState): number {
    return Math.max(0, this.storageCapacityOf(b) - bagTotal(b.stock));
  }

  /** Completed storage buildings of a player. */
  storagesOf(playerId: number): BuildingState[] {
    const out: BuildingState[] = [];
    for (const id of this.buildingsOf(playerId)) {
      const b = this.buildings.get(id);
      if (b?.complete && buildingDef(b.type).storage) out.push(b);
    }
    return out;
  }

  /** Networks mode: move `n` of `res` into a building's stock (n may be negative), keeping the player's total in step. */
  private changeStock(b: BuildingState, res: ResourceType, n: number): void {
    if (n === 0) return;
    b.stock[res] += n;
    const p = this.players.get(b.owner);
    if (p) {
      p.resources[res] += n;
      this.markPlayer(p);
    }
    this.markBuilding(b);
  }

  /** Give resources to a building's owner: into that building in networks mode, the shared stock otherwise. */
  private grantAt(b: BuildingState, bag: Partial<ResourceBag>): void {
    const p = this.players.get(b.owner);
    if (!p) return;
    for (const r of RESOURCE_TYPES) {
      const n = bag[r] ?? 0;
      if (n <= 0) continue;
      if (this.networksMode) this.changeStock(b, r, n);
      else p.resources[r] += n;
    }
    this.markPlayer(p);
  }

  /**
   * Storage networks: completed storage buildings within `storageLinkRange` tiles of each
   * other (transitively). Each network pools its stock for spending.
   */
  storageNetworks(playerId: number): BuildingState[][] {
    const all = this.storagesOf(playerId);
    const seen = new Set<number>();
    const nets: BuildingState[][] = [];
    for (const start of all) {
      if (seen.has(start.id)) continue;
      const net: BuildingState[] = [start];
      seen.add(start.id);
      for (let i = 0; i < net.length; i++) {
        const a = net[i] as BuildingState;
        for (const b of all) {
          if (seen.has(b.id) || rectGap(a, b) > BALANCE.storageLinkRange) continue;
          seen.add(b.id);
          net.push(b);
        }
      }
      nets.push(net);
    }
    return nets;
  }

  /** The network serving a place: the one with the storage nearest to it, if within supply range. */
  networkFor(playerId: number, rect: Rect): BuildingState[] | null {
    let best: BuildingState[] | null = null;
    let bestD = Infinity;
    for (const net of this.storageNetworks(playerId)) {
      for (const b of net) {
        const d = rectGap(b, rect);
        if (d <= BALANCE.supplyRange && d < bestD) {
          best = net;
          bestD = d;
        }
      }
    }
    return best;
  }

  networkStock(net: BuildingState[]): ResourceBag {
    const bag = emptyBag();
    for (const b of net) for (const r of RESOURCE_TYPES) bag[r] += b.stock[r];
    return bag;
  }

  /** Why the network cannot pay `cost`, or null. */
  private shortfall(net: BuildingState[], cost: Partial<ResourceBag>, what: string): string | null {
    const have = this.networkStock(net);
    const missing = RESOURCE_TYPES.filter((r) => have[r] < (cost[r] ?? 0));
    if (missing.length === 0) return null;
    return `Insufficient resources: ${what} costs ${formatCost(cost)}, but the storage here has ${missing.map((r) => `${have[r]} ${r}`).join(", ")} (resources in other storage networks must be hauled here)`;
  }

  /** Take `cost` from a network, emptying the fullest storages first. Caller has checked it can pay. */
  private takeFromNetwork(net: BuildingState[], cost: Partial<ResourceBag>): void {
    for (const r of RESOURCE_TYPES) {
      let need = cost[r] ?? 0;
      if (need <= 0) continue;
      const order = [...net].sort((a, b) => b.stock[r] - a.stock[r] || a.id - b.id);
      for (const b of order) {
        if (need <= 0) break;
        const n = Math.min(need, b.stock[r]);
        if (n > 0) {
          this.changeStock(b, r, -n);
          need -= n;
        }
      }
    }
  }

  private sharedShortfall(playerId: number, cost: Partial<ResourceBag>, what: string): string | null {
    const p = this.players.get(playerId);
    if (!p) return "Player not found";
    const r = RESOURCE_TYPES.find((x) => p.resources[x] < (cost[x] ?? 0));
    return r ? `Insufficient resources: ${what} costs ${formatCost(cost)} (you have ${p.resources[r]} ${r})` : null;
  }

  /**
   * Pay for something at a place. Shared mode: from the player's stock. Networks mode: from the
   * storage network serving the place. Fails (charging nothing) when it cannot be paid.
   */
  payAt(playerId: number, rect: Rect, cost: Partial<ResourceBag>, what: string): CommandResult<undefined> {
    const check = this.canPayAt(playerId, rect, cost, what);
    if (!check.ok) return check;
    const total = RESOURCE_TYPES.reduce((a, r) => a + (cost[r] ?? 0), 0);
    if (total === 0) return ok(undefined);
    if (!this.networksMode) {
      const p = this.players.get(playerId) as PlayerState;
      for (const r of RESOURCE_TYPES) p.resources[r] -= cost[r] ?? 0;
      this.markPlayer(p);
      return ok(undefined);
    }
    this.takeFromNetwork(this.networkFor(playerId, rect) as BuildingState[], cost);
    return ok(undefined);
  }

  /** Can a place be paid for (same rules as payAt, without paying)? */
  canPayAt(playerId: number, rect: Rect, cost: Partial<ResourceBag>, what: string): CommandResult<undefined> {
    const total = RESOURCE_TYPES.reduce((a, r) => a + (cost[r] ?? 0), 0);
    if (total === 0) return ok(undefined);
    if (!this.networksMode) {
      const why = this.sharedShortfall(playerId, cost, what);
      return why ? fail("insufficient_resources", why) : ok(undefined);
    }
    const net = this.networkFor(playerId, rect);
    if (!net) return fail("no_storage", `No storage building within ${BALANCE.supplyRange} tiles to pay for ${what}: build a Stockpile or Outpost nearby, or haul resources to one`);
    const why = this.shortfall(net, cost, what);
    return why ? fail("insufficient_resources", why) : ok(undefined);
  }

  /** Pay from anywhere (player-wide fees such as resetting talents). */
  payAnywhere(playerId: number, cost: Partial<ResourceBag>): boolean {
    if (!this.networksMode) {
      if (this.sharedShortfall(playerId, cost, "it")) return false;
      const p = this.players.get(playerId) as PlayerState;
      for (const r of RESOURCE_TYPES) p.resources[r] -= cost[r] ?? 0;
      this.markPlayer(p);
      return true;
    }
    const all = this.storagesOf(playerId);
    const have = this.networkStock(all);
    if (RESOURCE_TYPES.some((r) => have[r] < (cost[r] ?? 0))) return false;
    this.takeFromNetwork(all, cost);
    return true;
  }

  /**
   * Deliver resources that do not travel in a unit (salvage, plunder, reclaiming): to the shared
   * stock, or in networks mode into the storages nearest (x, y) that have room. Whatever does not
   * fit goes into the nearest storage anyway (over capacity) so nothing earned is lost; returns
   * false only if the player has no storage at all in networks mode.
   */
  deliver(playerId: number, x: number, y: number, bag: Partial<ResourceBag>): boolean {
    const p = this.players.get(playerId);
    if (!p) return false;
    if (!this.networksMode) {
      for (const r of RESOURCE_TYPES) p.resources[r] += bag[r] ?? 0;
      this.markPlayer(p);
      return true;
    }
    const all = this.storagesOf(playerId).sort((a, b) => distToRect(x, y, a.x, a.y, a.w, a.h) - distToRect(x, y, b.x, b.y, b.w, b.h) || a.id - b.id);
    if (all.length === 0) return false;
    for (const r of RESOURCE_TYPES) {
      let left = bag[r] ?? 0;
      for (const b of all) {
        if (left <= 0) break;
        const n = Math.min(left, this.storageFree(b));
        if (n > 0) {
          this.changeStock(b, r, n);
          left -= n;
        }
      }
      if (left > 0) this.changeStock(all[0] as BuildingState, r, left);
    }
    return true;
  }

  /** Set a player's totals (tools, tests and admin use): the shared stock, or the main storage in networks mode. */
  setStock(playerId: number, bag: Partial<ResourceBag>): void {
    const p = this.players.get(playerId);
    if (!p) return;
    if (!this.networksMode) {
      for (const r of RESOURCE_TYPES) if (bag[r] !== undefined) p.resources[r] = bag[r] as number;
      this.markPlayer(p);
      return;
    }
    const all = this.storagesOf(playerId);
    const main = all.find((b) => b.type === "town_hall") ?? all[0];
    if (!main) return;
    for (const r of RESOURCE_TYPES) {
      const want = bag[r];
      if (want === undefined) continue;
      const others = p.resources[r] - main.stock[r];
      if (want >= others) {
        this.changeStock(main, r, want - others - main.stock[r]);
      } else {
        this.changeStock(main, r, -main.stock[r]);
        let excess = others - want;
        for (const b of all) {
          if (b === main || excess <= 0) continue;
          const n = Math.min(excess, b.stock[r]);
          this.changeStock(b, r, -n);
          excess -= n;
        }
      }
    }
  }

  /**
   * After loading: make the stored state match the configured storage mode, losslessly.
   * Shared -> networks: each player's stock moves into their Town Hall (or first storage).
   * Networks -> shared: all building stock moves back into the player's stock.
   * Returns the number of players converted.
   */
  applyStorageMode(): number {
    let converted = 0;
    for (const p of this.players.values()) {
      const held = emptyBag();
      for (const id of this.buildingsOf(p.id)) {
        const b = this.buildings.get(id);
        if (b) for (const r of RESOURCE_TYPES) held[r] += b.stock[r];
      }
      if (this.networksMode) {
        // p.resources is the total; anything not yet held by a building came from shared mode.
        const loose = RESOURCE_TYPES.some((r) => p.resources[r] !== held[r]);
        if (!loose) continue;
        const all = this.storagesOf(p.id);
        const main = all.find((b) => b.type === "town_hall") ?? all[0];
        if (!main) continue; // no storage yet: kept as the total until one exists
        for (const r of RESOURCE_TYPES) {
          main.stock[r] += Math.max(0, p.resources[r] - held[r]);
          p.resources[r] = held[r] + Math.max(0, p.resources[r] - held[r]);
        }
        this.markBuilding(main);
        this.markPlayer(p);
        converted++;
      } else if (RESOURCE_TYPES.some((r) => held[r] > 0)) {
        for (const id of this.buildingsOf(p.id)) {
          const b = this.buildings.get(id);
          if (!b || bagTotal(b.stock) === 0) continue;
          b.stock = emptyBag();
          this.markBuilding(b);
        }
        // p.resources already includes what the buildings held (it is the total in networks mode).
        this.markPlayer(p);
        converted++;
      }
    }
    return converted;
  }

  /** The nearest of the player's storages with room for at least one item. */
  private storageForDeposit(u: UnitState, exclude: Set<number> | null = null): BuildingState | undefined {
    let best: BuildingState | undefined;
    let bestD = Infinity;
    for (const b of this.storagesOf(u.owner)) {
      if (exclude?.has(b.id) || this.storageFree(b) <= 0) continue;
      const d = distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
      if (d < bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  }

  /** Networks mode: the nearest storage holding some of `res`. Shared mode: the nearest storage. */
  private nearestStorageWith(u: UnitState, res: ResourceType): BuildingState | undefined {
    if (!this.networksMode) {
      const p = this.players.get(u.owner);
      return p && p.resources[res] > 0 ? this.nearestStorage(u) : undefined;
    }
    let best: BuildingState | undefined;
    let bestD = Infinity;
    for (const b of this.storagesOf(u.owner)) {
      if (b.stock[res] <= 0) continue;
      const d = distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
      if (d < bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  }

  /** Where a producing building's output goes in networks mode: nearest storage with room within supply range. */
  private supplyTarget(b: BuildingState): BuildingState | undefined {
    let best: BuildingState | undefined;
    let bestD = Infinity;
    for (const s of this.storagesOf(b.owner)) {
      if (this.storageFree(s) <= 0) continue;
      const d = rectGap(s, b);
      if (d <= BALANCE.supplyRange && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ combat (optional)

  // ------------------------------------------------------------------ stealth

  /** Can this unit hide right now (ignoring detection)? Scouts always; Dark Elf units in forest. */
  isStealthy(u: UnitState): boolean {
    if (u.owner === NEUTRAL || this.tick < u.revealedUntil) return false;
    if (unitDef(u.type).capabilities.includes("stealth") || this.hasBuff(u, "stealth")) return true;
    return this.mods(u.owner).has("ability:forest_stealth") && this.chunks.terrainAt(u.x, u.y) === Tile.Forest;
  }

  /** Could this unit ever be hidden (used to re-check visibility regularly)? */
  private canEverHide(u: UnitState): boolean {
    if (u.owner === NEUTRAL) return false;
    return unitDef(u.type).capabilities.includes("stealth") || u.buffs.length > 0 || this.mods(u.owner).has("ability:forest_stealth");
  }

  /** Is `u` hidden from player `viewer` (stealthy and no unit or building of the viewer close enough)? */
  isHiddenFrom(u: UnitState, viewer: number): boolean {
    if (u.owner === viewer || viewer === NEUTRAL || !this.isStealthy(u)) return false;
    return !this.detects(viewer, u.x, u.y);
  }

  /** Does player `viewer` have a unit within DETECT_RADIUS, or a building within its detection range, of (x, y)? */
  private detects(viewer: number, x: number, y: number): boolean {
    for (const r of this.reveals) if (r.owner === viewer && r.until > this.tick && chebyshev(r.x, r.y, x, y) <= r.radius) return true;
    const s = this.chunks.size;
    const r = WATCHTOWER_DETECT_RADIUS;
    for (let cy = floorDiv(y - r, s); cy <= floorDiv(y + r, s); cy++) {
      for (let cx = floorDiv(x - r, s); cx <= floorDiv(x + r, s); cx++) {
        const key = chunkKey(cx, cy);
        for (const id of this.unitsInChunk(key)) {
          const o = this.units.get(id);
          if (o && o.owner === viewer && chebyshev(o.x, o.y, x, y) <= DETECT_RADIUS) return true;
        }
        for (const id of this.buildingsInChunk(key)) {
          const b = this.buildings.get(id);
          if (!b || b.owner !== viewer || !b.complete) continue;
          const range = b.type === "watchtower" ? WATCHTOWER_DETECT_RADIUS : DETECT_RADIUS;
          if (distToRect(x, y, b.x, b.y, b.w, b.h) <= range) return true;
        }
      }
    }
    return false;
  }

  /** Once a second, stealth-capable units are re-checked by the broadcaster (detection depends on others moving). */
  private refreshStealthVisibility(): void {
    if (this.tick % this.cfg.tickRate !== 3) return;
    for (const u of this.units.values()) {
      if (!this.canEverHide(u)) continue;
      const st = this.isStealthy(u);
      if (st !== u.wasStealthy) {
        u.wasStealthy = st;
        this.markUnit(u); // the owner's view shows whether the unit is hidden
      } else {
        this.net.units.add(u.id);
      }
    }
  }

  /** Is this player attackable (and able to attack other players) right now? */
  pvpActive(playerId: number): boolean {
    if (!this.cfg.combatEnabled || playerId === NEUTRAL) return false;
    const p = this.players.get(playerId);
    if (!p) return false;
    return p.pvp || (p.pvpUntil !== null && this.tick < p.pvpUntil);
  }

  /**
   * Opt in to or out of PvP. Opting in is immediate. Opting out takes effect after
   * `pvpOptOutSeconds`, extended by any fighting in the meantime, so nobody can leave mid-battle.
   */
  setPvp(playerId: number, on: boolean): CommandResult<PlayerState> {
    if (!this.cfg.combatEnabled) return fail("combat_disabled", "Combat is disabled on this server");
    const p = this.players.get(playerId);
    if (!p) return fail("not_found", "Player not found");
    if (on) {
      if (p.pvp) return ok(p);
      p.pvp = true;
      p.pvpUntil = null;
    } else {
      if (!p.pvp) return ok(p);
      p.pvp = false;
      p.pvpUntil = this.tick + this.cfg.pvpOptOutSeconds * this.cfg.tickRate;
    }
    this.markPlayer(p);
    this.ownersChanged.add(p.id);
    this.audit.push({ tick: this.tick, playerId, action: on ? "pvp_on" : "pvp_off", detail: on ? "opted in" : `leaves PvP at tick ${p.pvpUntil}` });
    return ok(p);
  }

  /** Called once per tick: players whose opt-out delay has passed stop being attackable. */
  private updatePvpTimers(): void {
    for (const p of this.players.values()) {
      if (p.pvpUntil !== null && this.tick >= p.pvpUntil) {
        p.pvpUntil = null;
        this.markPlayer(p);
        this.ownersChanged.add(p.id);
        this.notice(p.id, "info", "You have left PvP combat. Other players can no longer attack you.");
      }
    }
  }

  /** Fighting keeps a player who is leaving PvP attackable for another full delay. */
  private noteFight(playerId: number): void {
    const p = this.players.get(playerId);
    if (!p || p.pvp || p.pvpUntil === null) return;
    const until = this.tick + this.cfg.pvpOptOutSeconds * this.cfg.tickRate;
    if (until > p.pvpUntil) {
      p.pvpUntil = until;
      this.markPlayer(p);
    }
  }

  private ownerLabel(owner: number): string {
    return owner === NEUTRAL ? "Wildlife" : (this.players.get(owner)?.name ?? `player ${owner}`);
  }

  /** Why `a` may not attack unit `t` right now, or null if it may. */
  attackBlocker(a: UnitState, t: UnitState): string | null {
    const pve = this.isMonster(a) || this.isMonster(t);
    if (!this.cfg.combatEnabled && !(pve && this.cfg.pveEnabled)) return pve ? "Fighting monsters (PvE) is disabled on this server" : "Combat is disabled on this server (only lair monsters can be fought)";
    const def = unitDef(a.type);
    if (!def.attack) return `${def.name}s cannot fight`;
    if (a.id === t.id) return "A unit cannot attack itself";
    if (t.pen !== null) return "Animals in a paddock cannot be attacked";
    if (t.owner === a.owner) return a.owner === NEUTRAL ? "Wild creatures do not fight each other" : "You cannot attack your own units";
    // Monsters attack anyone inside (or just outside) their lair, and anyone who hit them.
    if (this.isMonster(a)) {
      const at = a.provokedBy?.get(t.owner);
      if (at !== undefined && this.tick - at <= PROVOKE_SECONDS * this.cfg.tickRate) return null;
      const lair = this.lairOf(a);
      if (lair && Math.hypot(t.x - lair.x, t.y - lair.y) <= lair.r + 1) return null;
      return "Monsters only attack intruders in their lair";
    }
    if (this.isMonster(t)) return a.owner !== NEUTRAL ? null : "Wild creatures do not fight monsters";
    if (a.owner !== NEUTRAL && this.isHiddenFrom(t, a.owner)) return "No such target in sight";
    if (t.owner === NEUTRAL) return null; // hunting needs no opt-in; animals only fight back
    // Contested zones: anyone standing inside can be attacked by any player, opted in or not.
    if (a.owner !== NEUTRAL && this.contestedZoneAt(t.x, t.y)) return null;
    if (a.owner === NEUTRAL) {
      const at = a.provokedBy?.get(t.owner);
      return at !== undefined && this.tick - at <= PROVOKE_SECONDS * this.cfg.tickRate ? null : "Wild creatures only fight back against those who attack them";
    }
    if (!this.pvpActive(a.owner)) return "You have not opted in to PvP combat";
    if (!this.pvpActive(t.owner)) return `${this.ownerLabel(t.owner)} has not opted in to PvP combat`;
    return null;
  }

  isMonster(u: UnitState): boolean {
    return u.owner === NEUTRAL && !!unitDef(u.type).monster;
  }

  /** The lair a monster belongs to (the one around its home). */
  lairOf(u: UnitState): Lair | null {
    return u.home ? this.lairs.at(u.home.x, u.home.y) : null;
  }

  /** Why `a` may not attack building `b` right now, or null if it may. */
  buildingAttackBlocker(a: UnitState, b: BuildingState): string | null {
    if (!this.cfg.combatEnabled) return "Combat is disabled on this server";
    const def = unitDef(a.type);
    if (!def.attack) return `${def.name}s cannot fight`;
    if (a.owner === NEUTRAL) return "Wild creatures do not attack buildings";
    if (def.attack.buildingFactor <= 0) return `${def.name}s cannot damage buildings`;
    if (b.owner === a.owner) return "You cannot attack your own buildings";
    // Anything built in (or reaching into) a contested zone is fair game for every player.
    if (this.buildingZone(b)) return null;
    if (!this.pvpActive(a.owner)) return "You have not opted in to PvP combat";
    if (!this.pvpActive(b.owner)) return `${this.ownerLabel(b.owner)} has not opted in to PvP combat`;
    return null;
  }

  /** The unit that hit `u` most recently (within the last 10 s) if `u` may still fight back. */
  lastAttacker(u: UnitState): UnitState | undefined {
    if (!u.lastHit || this.tick - u.lastHit.tick > LAST_HIT_SECONDS * this.cfg.tickRate) return undefined;
    const a = this.units.get(u.lastHit.by);
    if (!a || this.attackBlocker(u, a) !== null) return undefined;
    return a;
  }

  private notice(playerId: number, kind: "info" | "error" | "success", text: string): void {
    if (playerId === NEUTRAL || !this.players.has(playerId)) return;
    // Drained by the server every tick; bounded in case nothing drains it (bare simulations).
    if (this.notices.length >= 1000) this.notices.shift();
    this.notices.push({ playerId, kind, text });
  }

  /** Apply a hit; returns the damage actually dealt (after armor, shields and curses). */
  private damageUnit(t: UnitState, raw: number, a: UnitState): number {
    if (this.hasBuff(t, "invulnerable")) {
      t.lastHit = { by: a.id, owner: a.owner, tick: this.tick };
      return 0;
    }
    const damage = Math.min(t.hp, Math.max(1, Math.round(raw * (1 - this.unitArmor(t)) * Math.max(0, 1 + this.unitPct(t, "vulnerable")))));
    t.hp = Math.max(0, t.hp - damage);
    // Fighting gives away a hidden unit's position, attacker and target alike.
    t.revealedUntil = a.revealedUntil = this.tick + REVEAL_SECONDS * this.cfg.tickRate;
    t.lastHit = { by: a.id, owner: a.owner, tick: this.tick };
    if (t.owner === NEUTRAL && a.owner !== NEUTRAL) {
      if (!t.provokedBy) t.provokedBy = new Map();
      t.provokedBy.set(a.owner, this.tick);
    }
    if (t.owner !== NEUTRAL && a.owner !== NEUTRAL) {
      this.noteFight(t.owner);
      this.noteFight(a.owner);
    }
    if (t.owner !== NEUTRAL && t.hp > 0) this.warnAttacked(t.owner, `Your ${unitDef(t.type).name.toLowerCase()}`, t.x, t.y);
    // A program with on_attacked(attacker) is told on its next update (not while it is already fighting back).
    if (t.hp > 0 && t.vm && t.task.kind !== "attack" && this.tick - t.lastAttackEvent >= ATTACK_EVENT_TICKS * (this.cfg.tickRate / 10) && t.vm.hasHandler("on_attacked", 1)) {
      t.attackedBy = a.id;
    }
    this.markUnit(t);
    if (t.hp <= 0) this.killUnit(t, a);
    return damage;
  }

  private killUnit(t: UnitState, killer: UnitState): void {
    const def = unitDef(t.type);
    const kp = this.players.get(killer.owner);
    const tname = def.name.toLowerCase();
    if (this.isMonster(t)) {
      this.audit.push({ tick: this.tick, playerId: t.owner, action: "unit_killed", detail: `${t.type} #${t.id} by ${killer.type} #${killer.id} (player ${killer.owner})` });
      const lair = this.lairOf(t);
      this.removeUnit(t);
      this.onMonsterKilled(t, killer, lair);
      return;
    }
    if (t.owner === NEUTRAL) {
      // Hunting: the hunter takes what meat it can carry.
      const meat = def.creature?.meat ?? 0;
      const room = Math.max(0, this.capacity(killer) - bagTotal(killer.inventory));
      const got = Math.min(meat, room);
      if (got > 0) {
        killer.inventory.food += got;
        this.markUnit(killer);
      }
      this.log(killer, `Hunted a ${tname}${meat > 0 ? `: ${got} food${got < meat ? ` (${meat - got} left behind, no room to carry it)` : ""}` : ""}.`);
      if (kp) this.awardXp(kp, XP_AWARDS.perHunt, "hunting");
    } else {
      this.notice(t.owner, "error", `Your ${tname} #${t.id} was killed by ${this.ownerLabel(killer.owner)}'s ${unitDef(killer.type).name.toLowerCase()}.`);
      if (killer.owner !== NEUTRAL) {
        this.notice(killer.owner, "success", `Your ${unitDef(killer.type).name.toLowerCase()} defeated ${this.ownerLabel(t.owner)}'s ${tname}.`);
        let cost = def.hero ? HERO_KILL_VALUE : 0;
        for (const r of RESOURCE_TYPES) cost += def.cost?.[r] ?? 0;
        if (kp && cost > 0) this.awardXp(kp, cost * XP_AWARDS.killCostFraction, "combat");
        // Undead: reuse the defeated (part of what the unit cost its owner).
        if (kp && def.cost && this.mods(kp.id).has("ability:reuse_defeated")) {
          const f = REUSE_DEFEATED_FRACTION * this.mods(kp.id).factor("salvage");
          const parts: string[] = [];
          const bag: Partial<ResourceBag> = {};
          for (const r of RESOURCE_TYPES) {
            const n = Math.floor((def.cost[r] ?? 0) * f);
            if (n > 0) {
              bag[r] = n;
              parts.push(`${n} ${r}`);
            }
          }
          if (parts.length && this.deliver(kp.id, killer.x, killer.y, bag)) this.log(killer, `Reclaimed ${parts.join(" and ")} from the fallen ${tname}.`);
        }
      }
      this.log(killer, `Defeated ${this.ownerLabel(t.owner)}'s ${tname} #${t.id}.`);
    }
    this.audit.push({ tick: this.tick, playerId: t.owner, action: "unit_killed", detail: `${t.type} #${t.id} by ${killer.type} #${killer.id} (player ${killer.owner})` });
    this.removeUnit(t);
  }

  /** Remove a unit from the world (death). Other units' tasks that refer to it fail on their next update. */
  private removeUnit(u: UnitState): void {
    this.units.delete(u.id);
    this.unindexUnitChunk(u);
    this.unitsByOwner.get(u.owner)?.delete(u.id);
    u.vm = null;
    u.path = null;
    this.chaseAim.delete(u.id);
    this.net.units.delete(u.id);
    this.persist.units.delete(u.id);
    this.net.removedUnits.add(u.id);
    this.persist.removedUnits.add(u.id);
    this.buffedUnits.delete(u.id);
    this.featureCache.delete(u.id);
    if (u.owner !== NEUTRAL) this.eliminationCheck.add(u.owner);
    const owner = this.players.get(u.owner);
    if (owner && owner.hero.unitId === u.id) {
      owner.hero.unitId = null;
      owner.hero.deaths++;
      this.markPlayer(owner);
      const name = unitDef(u.type).name;
      this.notice(owner.id, "error", `Your ${name} has fallen. Revive them at a Town Hall or Barracks; their training is kept.`);
      this.audit.push({ tick: this.tick, playerId: owner.id, action: "hero_fallen", detail: `${u.type} #${u.id}` });
    }
  }

  /** Tell a player their things are under attack, at most once per 30 s. */
  private warnAttacked(owner: number, what: string, x: number, y: number): void {
    if (owner === NEUTRAL) return;
    const last = this.attackWarned.get(owner);
    if (last !== undefined && this.tick - last < 30 * this.cfg.tickRate) return;
    this.attackWarned.set(owner, this.tick);
    this.notice(owner, "error", `${what} at ${x}, ${y} is under attack${this.contestedZoneAt(x, y) ? " in a contested zone" : ""}!`);
  }

  private damageBuilding(b: BuildingState, damage: number, a: UnitState): void {
    b.hp = Math.max(0, b.hp - damage);
    a.revealedUntil = this.tick + REVEAL_SECONDS * this.cfg.tickRate;
    this.warnAttacked(b.owner, `Your ${buildingDef(b.type).name}`, b.x, b.y);
    this.noteFight(b.owner);
    this.noteFight(a.owner);
    this.markBuilding(b);
    if (b.hp <= 0) this.destroyBuilding(b, a);
  }

  private destroyBuilding(b: BuildingState, by: UnitState): void {
    const def = buildingDef(b.type);
    this.notice(b.owner, "error", `Your ${def.name} #${b.id} was destroyed by ${this.ownerLabel(by.owner)}.`);
    this.notice(by.owner, "success", `You destroyed ${this.ownerLabel(b.owner)}'s ${def.name}.`);
    this.log(by, `Destroyed ${this.ownerLabel(b.owner)}'s ${def.name} #${b.id}.`);
    const kp = this.players.get(by.owner);
    if (kp && b.complete && b.type !== "town_hall") {
      let cost = 0;
      for (const r of RESOURCE_TYPES) cost += def.cost[r] ?? 0;
      this.awardXp(kp, cost * XP_AWARDS.destroyCostFraction, "combat");
    }
    // Networks mode: what the building held is lost; the attacker carries off a share (plunder).
    if (this.networksMode && bagTotal(b.stock) > 0) {
      const loot: Partial<ResourceBag> = {};
      const parts: string[] = [];
      for (const r of RESOURCE_TYPES) {
        const n = Math.floor(b.stock[r] * BALANCE.plunderFraction);
        if (n > 0) {
          loot[r] = n;
          parts.push(`${n} ${r}`);
        }
      }
      if (parts.length && by.owner !== NEUTRAL && this.deliver(by.owner, by.x, by.y, loot)) {
        this.log(by, `Plundered ${parts.join(", ")}.`);
        this.notice(by.owner, "success", `Plundered ${parts.join(", ")} from ${this.ownerLabel(b.owner)}'s ${def.name}.`);
      }
      this.notice(b.owner, "error", `The ${formatCost(b.stock)} stored in your ${def.name} was lost.`);
    }
    this.audit.push({ tick: this.tick, playerId: b.owner, action: "building_destroyed", detail: `${b.type} #${b.id} by ${by.type} #${by.id} (player ${by.owner})` });
    this.removeBuilding(b);
  }

  /** Remove a building; its territory is released and re-derived from the remaining buildings. */
  private removeBuilding(b: BuildingState): void {
    // A paddock's animals escape when it is lost.
    if (buildingDef(b.type).pen) {
      for (const a of this.pennedIn(b)) {
        if (!this.letOut(a, b)) {
          a.pen = null;
          this.markUnit(a);
        }
      }
    }
    // Whatever it held leaves the owner's totals with it.
    const owner = this.players.get(b.owner);
    if (owner && bagTotal(b.stock) > 0) {
      for (const r of RESOURCE_TYPES) owner.resources[r] -= b.stock[r];
      b.stock = emptyBag();
      this.markPlayer(owner);
    }
    this.buildings.delete(b.id);
    const size = this.chunks.size;
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (this.buildingTiles.get(tileNum(x, y)) === b.id) this.buildingTiles.delete(tileNum(x, y));
        const k = chunkKey(floorDiv(x, size), floorDiv(y, size));
        const set = this.buildingsByChunk.get(k);
        if (set) {
          set.delete(b.id);
          if (set.size === 0) this.buildingsByChunk.delete(k);
        }
      }
    }
    this.buildingsByOwner.get(b.owner)?.delete(b.id);
    this.net.buildings.delete(b.id);
    this.persist.buildings.delete(b.id);
    this.net.removedBuildings.add(b.id);
    this.persist.removedBuildings.add(b.id);
    if (b.complete && buildingDef(b.type).influence > 0) this.recomputeTerritory();
    this.eliminationCheck.add(b.owner);
  }

  /** Re-derive ownership from the remaining completed buildings after a loss (claims history is kept). */
  private recomputeTerritory(): void {
    const before = new Map<number, number>(this.territory.counts);
    const pendingClaims = this.territory.claims;
    const pendingDirty = [...this.territory.dirty];
    const oldKeys = this.territory.reset();
    this.rebuildTerritory();
    this.territory.claims = pendingClaims;
    for (const k of [...pendingDirty, ...oldKeys]) this.territory.dirty.add(k);
    for (const k of this.territory.ownedChunkKeys()) this.territory.dirty.add(k);
    const owners = new Set<number>([...before.keys(), ...this.territory.counts.keys()]);
    for (const id of owners) {
      if ((before.get(id) ?? 0) !== this.territory.countOf(id)) {
        const p = this.players.get(id);
        if (p) this.markPlayer(p);
      }
    }
  }

  /**
   * A player left with no units and no buildings gets a new settlement (Town Hall and the
   * three starting units). Experience, research, talents and discoveries are kept.
   */
  private checkEliminations(): void {
    if (this.eliminationCheck.size === 0) return;
    const ids = [...this.eliminationCheck];
    this.eliminationCheck.clear();
    for (const id of ids) {
      const p = this.players.get(id);
      if (!p || this.unitsOf(id).size > 0 || this.buildingsOf(id).size > 0) continue;
      const spawn = this.findSpawn(id + this.tick);
      if (!spawn) continue;
      for (let y = spawn.y - 2; y <= spawn.y + 2; y++) for (let x = spawn.x - 2; x <= spawn.x + 2; x++) this.chunks.clearNode(x, y);
      const hall = this.addBuilding(id, "town_hall", spawn.x - 1, spawn.y - 1, true);
      this.claimTerritory(hall, true);
      this.territory.dirty.add(chunkKey(floorDiv(hall.x, this.chunks.size), floorDiv(hall.y, this.chunks.size)));
      STARTING_UNITS.forEach((type, i) => this.addUnit(id, type, spawn.x - 1 + i, spawn.y + 2, true));
      p.spawnX = spawn.x;
      p.spawnY = spawn.y;
      // Starting supplies: in networks mode they sit in the new Town Hall (stock held elsewhere was
      // lost with those buildings); in shared mode the stock is topped up to the starting amounts.
      if (this.networksMode) this.grantAt(hall, BALANCE.startingResources);
      else for (const r of RESOURCE_TYPES) p.resources[r] = Math.max(p.resources[r], BALANCE.startingResources[r]);
      this.markPlayer(p);
      this.notice(id, "info", `Your settlement was destroyed. A new one has been founded at ${spawn.x}, ${spawn.y}.`);
      this.audit.push({ tick: this.tick, playerId: id, action: "refounded", detail: `spawn ${spawn.x},${spawn.y} hall ${hall.id}` });
    }
  }

  /** Damaged units slowly heal once they have not been hit for a while (checked once per second). */
  private regenerate(): void {
    if (this.tick % this.cfg.tickRate !== 0) return;
    const calm = REGEN_DELAY_SECONDS * this.cfg.tickRate;
    for (const u of this.units.values()) {
      const max = this.unitMaxHp(u);
      if (u.hp >= max || u.pen !== null || !this.isAwake(u)) continue;
      if (u.lastHit && this.tick - u.lastHit.tick < calm) continue;
      const rate = REGEN_FRACTION_PER_SECOND * (u.owner === NEUTRAL ? 1 : this.mods(u.owner).factor("regeneration") * Math.max(0.2, 1 + this.unitPct(u, "regeneration")));
      u.hp = Math.min(max, u.hp + Math.max(1, Math.round(max * rate)));
      this.markUnit(u);
    }
  }

  private updateAttack(u: UnitState, task: Extract<Task, { kind: "attack" }>): void {
    const atk = unitDef(u.type).attack;
    const fin = (okRes: boolean, reason: string): void => this.finishTask(u, { ok: okRes, value: okRes, reason }, "attack");
    if (!atk) return fin(false, `${unitDef(u.type).name}s cannot fight`);
    let rect: Rect;
    if (task.building) {
      const b = this.buildings.get(task.targetId);
      if (!b) return fin(true, ""); // destroyed
      const why = this.buildingAttackBlocker(u, b);
      if (why) return fin(false, why);
      rect = { x: b.x, y: b.y, w: b.w, h: b.h };
      if (distToRect(u.x, u.y, b.x, b.y, b.w, b.h) > atk.range) {
        const r = this.approach(u, rect, atk.range);
        if (r === "moving") return;
        if (r !== "arrived") return fin(false, `Target unreachable: ${r.fail}`);
      }
    } else {
      const t = this.units.get(task.targetId);
      if (!t) return fin(true, ""); // defeated (by us or someone else)
      const why = this.attackBlocker(u, t);
      if (why) return fin(false, why);
      // Monsters never chase far from their lair.
      if (this.isMonster(u)) {
        const lair = this.lairOf(u);
        if (lair && Math.hypot(u.x - lair.x, u.y - lair.y) > lair.r + LAIR_LEASH) return fin(false, "Too far from its lair");
      }
      const d = chebyshev(u.x, u.y, t.x, t.y);
      if (d > this.stat(u.owner, "senseRadius", unitDef(u.type).senseRadius) + CHASE_EXTRA_TILES) return fin(false, "The target got away");
      rect = { x: t.x, y: t.y, w: 1, h: 1 };
      if (d > atk.range) {
        const r = this.chase(u, t, atk.range);
        if (r === "moving") return;
        if (r !== "arrived") return fin(false, `Target unreachable: ${r.fail}`);
      }
    }
    u.path = null;
    this.setActivity(u, "attacking");
    const fx = rect.x + Math.floor((rect.w - 1) / 2) - u.x;
    const fy = rect.y + Math.floor((rect.h - 1) / 2) - u.y;
    if (fx || fy) {
      const f = facingFromDelta(Math.sign(fx), Math.sign(fy));
      if (f !== u.facing) {
        u.facing = f;
        this.markUnit(u);
      }
    }
    if (this.tick < task.nextHit) return;
    task.nextHit = this.tick + Math.max(1, Math.round(atk.cooldown * this.cfg.tickRate));
    if (task.building) {
      const b = this.buildings.get(task.targetId) as BuildingState;
      this.damageBuilding(b, Math.max(1, Math.round(this.unitDamage(u) * atk.buildingFactor)), u);
      if (!this.buildings.has(b.id)) fin(true, "");
    } else {
      const t = this.units.get(task.targetId) as UnitState;
      this.damageUnit(t, this.unitDamage(u), u);
      if (!this.units.has(t.id)) fin(true, "");
    }
  }

  private updateRepair(u: UnitState, task: Extract<Task, { kind: "repair" }>): void {
    const fin = (okRes: boolean, reason: string): void => this.finishTask(u, { ok: okRes, value: okRes, reason }, "repair");
    const b = this.buildings.get(task.buildingId);
    if (!b || b.owner !== u.owner) return fin(false, "The building no longer exists");
    if (!b.complete) return fin(false, "Use build() to finish a construction site");
    const maxHp = this.buildingMaxHp(b);
    if (b.hp >= maxHp) return fin(true, "");
    const r = this.approach(u, { x: b.x, y: b.y, w: b.w, h: b.h }, 1);
    if (r === "moving") return;
    if (r !== "arrived") return fin(false, `Building unreachable: ${r.fail}`);
    this.setActivity(u, "repairing");
    const def = buildingDef(b.type);
    // Same pace as construction: a full repair takes as long as building it did.
    task.hpAcc += (this.stat(u.owner, "buildRate", unitDef(u.type).buildRate) * Math.max(0.2, 1 + this.unitPct(u, "buildRate")) * maxHp) / def.buildTime / this.cfg.tickRate;
    const amount = Math.min(Math.floor(task.hpAcc), maxHp - b.hp);
    if (amount <= 0) return;
    // A full repair costs REPAIR_COST_FRACTION of the building's cost, paid as the work is done,
    // from the storage network serving the building.
    const pay: Partial<Record<ResourceType, number>> = {};
    const owedNext: Partial<Record<ResourceType, number>> = {};
    for (const res of RESOURCE_TYPES) {
      const owed = (task.costAcc[res] ?? 0) + ((def.cost[res] ?? 0) * REPAIR_COST_FRACTION * amount) / maxHp;
      pay[res] = Math.floor(owed);
      owedNext[res] = owed - Math.floor(owed);
    }
    const paid = this.payAt(u.owner, b, pay, "repairs");
    if (!paid.ok) {
      const net = this.networkFor(u.owner, b);
      const short = net ? RESOURCE_TYPES.find((r) => this.networkStock(net)[r] < (pay[r] ?? 0)) : undefined;
      return fin(false, short ? `Not enough ${short} to continue repairs` : paid.message);
    }
    task.costAcc = owedNext;
    task.hpAcc -= amount;
    b.hp += amount;
    this.markBuilding(b);
    if (b.hp >= maxHp) fin(true, "");
  }

  /** A move task directly away from `t` (used by flee()). */
  private fleeTask(u: UnitState, t: { x: number; y: number }): Task | null {
    let dx = u.x - t.x;
    let dy = u.y - t.y;
    if (dx === 0 && dy === 0) dx = 1;
    const len = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.round((dx / len) * FLEE_TILES);
    dy = Math.round((dy / len) * FLEE_TILES);
    const spot = this.nearestPassable(u.x + dx, u.y + dy, 4);
    if (!spot) return null;
    return { kind: "move", goal: { x: spot.x, y: spot.y, w: 1, h: 1 }, range: 0, label: "flee" };
  }

  // ------------------------------------------------------------------ simulation step

  step(): void {
    // The previous tick's record is complete (the server adds network and persistence time to it).
    this.tickPhases.endTick();
    const t0 = performance.now();
    this.tick++;
    this.wideSearchesThisTick = 0;
    this.wideMsThisTick = 0;
    this.pathMsThisTick = 0;
    // Experience changes are broadcast at most once per second per player.
    if (this.tick % this.cfg.tickRate === 0 && this.xpDirty.size > 0) {
      for (const id of this.xpDirty) this.net.players.add(id);
      this.xpDirty.clear();
    }
    let tp = t0;
    const phase = (name: string): void => {
      const n = performance.now();
      this.tickPhases.add(name, n - tp);
      tp = n;
    };
    this.chunks.processRegrowth();
    this.processSpawns();
    if (this.tick % this.cfg.tickRate === 2) this.renewWildlife();
    this.refreshStealthVisibility();
    if (this.tick % this.cfg.tickRate === 4) this.expireBuffs();
    if (this.cfg.combatEnabled) this.updatePvpTimers();
    if (this.fightingEnabled) {
      this.regenerate();
      this.healAuras();
    } else if (this.tick % this.cfg.tickRate === 0) {
      this.keepHeroesHealthy();
    }
    this.updateLairs();
    phase("world");
    if (this.tick % this.cfg.tickRate === 1 || this.activeChunks.size === 0) this.refreshActiveChunks();
    phase("activeChunks");
    this.guardZones = [];
    for (const u of this.units.values()) {
      if (u.owner !== NEUTRAL && u.task.kind === "guard" && u.activity === "guarding") this.guardZones.push({ x: u.task.x, y: u.task.y });
    }
    this.runScripts();
    phase("scripts");
    for (const u of this.units.values()) {
      if (u.pen !== null || !this.isAwake(u)) continue;
      try {
        this.updateUnit(u);
      } catch (err) {
        this.containUnitError(u, err);
      }
    }
    phase("units");
    for (const b of this.buildings.values()) {
      if (!b.complete) continue;
      try {
        this.updateBuilding(b);
      } catch (err) {
        this.stats.internalErrors++;
        this.onInternalError(`Internal error updating building #${b.id} (${b.type}) at tick ${this.tick}; skipped this tick`, err);
      }
    }
    phase("buildings");
    this.checkEliminations();
    const dt = performance.now() - t0;
    this.stats.lastTickMs = dt;
    this.stats.maxTickMs = Math.max(this.stats.maxTickMs, dt);
    this.tickPhases.add("simulation", dt);
  }

  private runScripts(): void {
    const ids = [...this.units.keys()];
    if (ids.length === 0) return;
    let budget = this.cfg.scriptOpsPerTick;
    let ran = 0;
    let deferred = 0;
    let ops = 0;
    const start = this.scriptCursor % ids.length;
    for (let k = 0; k < ids.length; k++) {
      const idx = (start + k) % ids.length;
      const u = this.units.get(ids[idx] as number);
      if (!u || u.program.state !== "running" || !u.vm || u.vm.state !== "ready" || !this.isAwake(u)) continue;
      if (budget <= 0) {
        deferred++;
        continue;
      }
      const perUnit = Math.round(this.cfg.scriptOpsPerUnitTick * this.mods(u.owner).factor("scriptOps") * Math.max(0.2, 1 + this.unitPct(u, "scriptOps")));
      if (deferred === 0 && budget < perUnit) this.scriptCursor = idx;
      const res = u.vm.run(Math.min(perUnit, budget));
      budget -= res.ops;
      ops += res.ops;
      ran++;
      switch (res.status) {
        case "action":
          this.startScriptAction(u, res.action);
          break;
        case "done":
          u.program.state = "finished";
          u.program.note = "Program finished (reached the end)";
          u.vm = null;
          this.markUnit(u);
          break;
        case "error":
          u.program.state = "error";
          u.program.error = res.error;
          u.program.note = "Program stopped by an error";
          u.vm = null;
          this.log(u, `Error on line ${res.error.line}: ${res.error.message}`);
          this.setTask(u, { kind: "idle" }, "script");
          break;
        case "budget":
          break;
      }
    }
    if (deferred > 0) this.scriptCursor = (this.scriptCursor + ran) % ids.length;
    this.stats.scriptOps = ops;
    this.stats.scriptUnitsRun = ran;
    this.stats.scriptUnitsDeferred = deferred;
  }

  private finishTask(u: UnitState, result: TaskResult, actionLabel: string): void {
    const source = u.taskSource;
    u.task = { kind: "idle" };
    u.path = null;
    u.moveProgress = 0;
    u.blocked = result.ok ? "" : result.reason;
    const label = source === "script" && u.scriptAction ? u.scriptAction : actionLabel;
    if (!result.ok) this.log(u, `${label} failed: ${result.reason}`);
    if (source === "script" && u.owner !== NEUTRAL) {
      this.lessonEvent(u, { kind: "action", name: label, ok: result.ok });
      if (!result.ok && u.vm?.hasHandler("on_action_failed", 2)) this.lessonEvent(u, { kind: "handler" });
    }
    if (source === "script") {
      const entry = u.trace[u.trace.length - 1];
      if (entry && entry.result === "") {
        entry.ok = result.ok;
        entry.result = result.ok ? repr(result.value, 1) : `failed: ${result.reason}`;
        u.detailRev++;
      }
    }
    if (source === "script" && u.vm && u.vm.state === "waiting") {
      u.vm.resume(result.value, result.ok ? undefined : { action: label, reason: result.reason });
    }
    u.scriptAction = null;
    // Wild creatures eat what they forage.
    if (u.owner === NEUTRAL && bagTotal(u.inventory) > 0) u.inventory = emptyBag();
    this.setActivity(u, "idle");
    this.markUnit(u);
  }

  private setActivity(u: UnitState, a: Activity): void {
    if (u.activity !== a) {
      u.activity = a;
      this.markUnit(u);
    }
  }

  /**
   * Plan the next stretch of movement within the per-tick pathfinding time budget; once it
   * is spent, units wait for the next tick ("retry") instead of stalling the simulation.
   */
  private planPath(
    u: UnitState,
    goal: Rect,
    range: number,
    allowWide: boolean,
    skipNarrow: boolean,
  ): { ok: true; path: { x: number; y: number }[]; leg: boolean } | { ok: false; reason: string; retry?: boolean } {
    if (this.pathMsThisTick >= PATH_MS_PER_TICK) return { ok: false, reason: "Waiting for route planning", retry: true };
    const t0 = performance.now();
    try {
      return this.planPathNow(u, goal, range, allowWide, skipNarrow);
    } finally {
      this.pathMsThisTick += performance.now() - t0;
    }
  }

  /**
   * Destinations within the search radius get a direct path; longer journeys follow a coarse
   * corridor (CoarseMap) in exact legs, so units can always return from distant exploration.
   */
  private planPathNow(
    u: UnitState,
    goal: Rect,
    range: number,
    allowWide: boolean,
    skipNarrow: boolean,
  ): { ok: true; path: { x: number; y: number }[]; leg: boolean } | { ok: false; reason: string; retry?: boolean } {
    const R = this.cfg.pathRadius;
    const passable = (x: number, y: number): boolean => this.isPassable(x, y);
    const d = distToRect(u.x, u.y, goal.x, goal.y, goal.w, goal.h);
    let direct: { ok: false; reason: string } | null = null;
    if (d <= R - 2 && !skipNarrow) {
      this.stats.pathSearches++;
      const res = findPath({ sx: u.x, sy: u.y, goal, range, radius: R, passable });
      if (res.ok) return { ok: true, path: res.path, leg: false };
      this.stats.pathFailures++;
      direct = res;
      u.pathNarrowFailed = this.pathGoalKey(goal, range);
    }
    if (!allowWide) return direct ?? { ok: false, reason: `Destination is too far away (more than ${R} tiles)` };
    // Long or obstructed journey: coarse corridor over 8x8 cells, then an exact leg along it.
    // Coarse plans are rationed per tick so a crowd of stuck units cannot stall the server.
    if (this.wideSearchesThisTick >= WIDE_SEARCHES_PER_TICK || this.wideMsThisTick >= WIDE_MS_PER_TICK) return { ok: false, reason: "Waiting for route planning", retry: true };
    this.wideSearchesThisTick++;
    const wideStart = performance.now();
    const gx = goal.x + Math.floor((goal.w - 1) / 2);
    const gy = goal.y + Math.floor((goal.h - 1) / 2);
    this.stats.coarseSearches++;
    const route = this.coarse.route(u.x, u.y, gx, gy, this.tick);
    this.wideMsThisTick += performance.now() - wideStart;
    if (!route) {
      this.stats.pathFailures++;
      return { ok: false, reason: "No route found within the search limit (the way may be blocked)" };
    }
    // Aim for the furthest corridor waypoint within reach of one exact search; fall back to nearer ones.
    const reach = R * 0.75;
    let last = -1;
    for (let i = 0; i < route.length; i++) {
      const wp = route[i] as { x: number; y: number };
      if (Math.max(Math.abs(wp.x - u.x), Math.abs(wp.y - u.y)) <= reach) last = i;
      else break;
    }
    if (route.length === 0 || last === route.length - 1) {
      // The goal is near (an empty route means the same coarse cell) but the direct search failed
      // or was skipped after failing before: one wider exact search finds local detours.
      if (route.length === 0 && d === 0) return { ok: true, path: [], leg: false };
      this.stats.pathSearches++;
      const res = findPath({ sx: u.x, sy: u.y, goal, range, radius: R * 2, passable, maxExpansions: 40_000 });
      if (res.ok) return { ok: true, path: res.path, leg: false };
      this.stats.pathFailures++;
      return { ok: false, reason: "No route found within the search limit (the way may be blocked)" };
    }
    for (let i = Math.max(last, 0); i >= 0; i--) {
      const wp = route[i];
      if (!wp) break;
      this.stats.pathSearches++;
      const res = findPath({ sx: u.x, sy: u.y, goal: { x: wp.x - 3, y: wp.y - 3, w: 7, h: 7 }, range: 0, radius: R, passable });
      if (res.ok && res.path.length > 0) return { ok: true, path: res.path, leg: true };
      this.stats.pathFailures++;
      if (i < last - 3) break;
    }
    return { ok: false, reason: "No route found within the search limit (the way may be blocked)" };
  }

  private pathGoalKey(goal: Rect, range: number): string {
    return `${goal.x},${goal.y},${goal.w},${goal.h},${range}`;
  }

  /**
   * Move toward a moving unit. The path is re-planned when the target drifts from where
   * it was when the path was planned; the tolerance grows with distance so long chases do
   * not search every tick. Long-range (hierarchical) routing is used only when far away.
   */
  private chase(u: UnitState, t: { x: number; y: number }, range: number): "arrived" | "moving" | { fail: string } {
    const d = chebyshev(u.x, u.y, t.x, t.y);
    const aim = this.chaseAim.get(u.id);
    const slack = Math.max(range, Math.floor(d / 4));
    if (u.path && (!aim || chebyshev(aim.x, aim.y, t.x, t.y) > slack)) u.path = null;
    if (!u.path) this.chaseAim.set(u.id, { x: t.x, y: t.y });
    const r = this.approach(u, { x: t.x, y: t.y, w: 1, h: 1 }, range, d > this.cfg.pathRadius * 0.75);
    if (r !== "moving") this.chaseAim.delete(u.id);
    return r;
  }

  private approach(u: UnitState, goal: Rect, range: number, allowWide = true): "arrived" | "moving" | { fail: string } {
    const at = distToRect(u.x, u.y, goal.x, goal.y, goal.w, goal.h);
    if (at <= range && (range > 0 || this.isPassable(u.x, u.y) || (u.x === goal.x && u.y === goal.y))) {
      u.path = null;
      return "arrived";
    }
    if (range === 0 && !this.isPassable(goal.x, goal.y)) return { fail: `Destination ${goal.x},${goal.y} is blocked` };
    if (!u.path) {
      // Back off briefly after a failed search for the same goal (keeps failing loops cheap).
      const key = this.pathGoalKey(goal, range);
      if (u.pathFail && u.pathFail.key === key && u.pathFail.until > this.tick) return { fail: u.pathFail.reason };
      const res = this.planPath(u, goal, range, allowWide, u.pathNarrowFailed === key);
      if (!res.ok) {
        if (res.retry) return "moving";
        // A failed wide search is expensive: back off longer before trying the same goal again.
        const wide = /search limit/.test(res.reason);
        // Jitter (by unit id) spreads retries so many stuck units do not all search on the same tick.
        const base = (wide ? 20 : 5) * this.cfg.tickRate;
        u.pathFail = { key, until: this.tick + base + ((u.id * 7) % (wide ? 10 * this.cfg.tickRate : this.cfg.tickRate)), reason: res.reason };
        return { fail: res.reason };
      }
      u.pathFail = null;
      u.pathNarrowFailed = null;
      u.path = res.path;
      if (u.path.length === 0) return "arrived";
    }
    const def = unitDef(u.type);
    this.setActivity(u, bagTotal(u.inventory) > 0 ? "carrying" : "walking");
    u.moveProgress += (this.stat(u.owner, "moveSpeed", def.speed) * Math.max(0.2, 1 + this.unitPct(u, "moveSpeed"))) / this.cfg.tickRate;
    let repathed = false;
    for (;;) {
      const next = u.path[0];
      if (!next) break;
      const cost = next.x !== u.x && next.y !== u.y ? Math.SQRT2 : 1;
      if (u.moveProgress < cost) break;
      if (!this.isPassable(next.x, next.y)) {
        if (repathed) return { fail: "Path became blocked" };
        repathed = true;
        const res = this.planPath(u, goal, range, allowWide, false);
        if (!res.ok) {
          if (res.retry) {
            u.path = null;
            return "moving";
          }
          return { fail: res.reason };
        }
        u.path = res.path;
        continue;
      }
      u.moveProgress -= cost;
      this.moveUnitTo(u, next.x, next.y);
      u.path.shift();
      this.markUnit(u);
    }
    if (u.path.length === 0) {
      u.path = null;
      u.moveProgress = 0;
      const d = distToRect(u.x, u.y, goal.x, goal.y, goal.w, goal.h);
      return d <= range ? "arrived" : "moving";
    }
    return "moving";
  }

  private updateUnit(u: UnitState): void {
    if (u.attackedBy !== null) this.deliverAttackEvent(u);
    if (u.pendingResult) {
      const f = u.pendingResult;
      u.pendingResult = null;
      this.finishTask(u, f, "Action");
      return;
    }
    const task = u.task;
    switch (task.kind) {
      case "idle":
        this.setActivity(u, "idle");
        return;
      case "wait":
        this.setActivity(u, "waiting");
        if (this.tick >= task.until) this.finishTask(u, { ok: true, value: null, reason: "" }, "wait");
        return;
      case "move": {
        // Exploration legs are short; they never use the expensive wide search.
        const r = this.approach(u, task.goal, task.range, task.label !== "explore" && task.label !== "flee");
        if (r === "arrived") this.finishTask(u, { ok: true, value: true, reason: "" }, task.label);
        else if (r !== "moving") this.finishTask(u, { ok: false, value: false, reason: r.fail }, task.label);
        return;
      }
      case "gather":
        this.updateGather(u, task);
        return;
      case "deposit":
        this.updateDeposit(u, task);
        return;
      case "build":
        this.updateBuild(u, task);
        return;
      case "withdraw":
        this.updateWithdraw(u, task);
        return;
      case "observe":
        this.updateObserve(u, task);
        return;
      case "tame":
        this.updateTame(u, task);
        return;
      case "train_creature":
        this.updateTrain(u, task);
        return;
      case "investigate":
        this.updateInvestigate(u, task);
        return;
      case "follow":
        this.updateFollow(u, task);
        return;
      case "guard":
        this.updateGuard(u, task);
        return;
      case "attack":
        this.updateAttack(u, task);
        return;
      case "repair":
        this.updateRepair(u, task);
        return;
      case "pen":
        this.updatePen(u, task);
        return;
    }
  }

  hasAbility(u: UnitState, cap: string): boolean {
    return (unitDef(u.type).capabilities as string[]).includes(cap) || u.learned.some((l) => unitDef(u.type).creature?.trainable[l]?.capability === cap);
  }

  /** Why a unit cannot tame a creature right now, or null. */
  private canTame(u: UnitState, c: UnitState): string | null {
    const info = unitDef(c.type).creature;
    const p = this.players.get(u.owner);
    if (!info || !p) return "Not a creature";
    if (c.owner !== NEUTRAL) return "That creature is not wild";
    if (info.tameCost <= 0) return `A ${unitDef(c.type).name.toLowerCase()} cannot be tamed`;
    if (!p.observed.includes(c.type)) return `Observe a ${unitDef(c.type).name.toLowerCase()} first to understand its behaviour`;
    const cost = this.tameCost(u, c);
    if (u.inventory.food < cost) return `Taming a ${unitDef(c.type).name.toLowerCase()} needs ${cost} food carried by this unit (use withdraw("food"))`;
    if (this.limitedUnits(u.owner) >= this.unitCap(u.owner)) return `Unit limit (${this.unitCap(u.owner)}) reached: research Administration at a Library to raise it`;
    return null;
  }

  /** Food this unit needs to tame creature `c` (Rangers need less). */
  tameCost(u: UnitState, c: UnitState): number {
    const base = unitDef(c.type).creature?.tameCost ?? 0;
    return Math.ceil(base * (unitDef(u.type).tamer?.costFactor ?? 1));
  }

  private canTrain(u: UnitState, c: UnitState, ability: string): string | null {
    const info = unitDef(c.type).creature;
    if (!info) return "Only creatures can be trained";
    if (c.owner !== u.owner) return "Permission denied: you can only train your own creatures";
    const t = Object.hasOwn(info.trainable, ability) ? info.trainable[ability] : undefined;
    if (!t) return `${unitDef(c.type).name}s cannot learn '${ability}'`;
    if (c.learned.includes(ability)) return `This ${unitDef(c.type).name.toLowerCase()} already knows '${ability}'`;
    if (u.inventory.food < t.cost) return `Training needs ${t.cost} food carried by this unit (use withdraw("food"))`;
    return null;
  }

  private updateObserve(u: UnitState, task: Extract<Task, { kind: "observe" }>): void {
    const c = this.units.get(task.targetId);
    const p = this.players.get(u.owner);
    const fin = (okRes: boolean, reason: string): void => this.finishTask(u, { ok: okRes, value: okRes, reason }, "observe");
    if (!c || c.owner !== NEUTRAL || !p) return fin(false, "The creature is gone");
    const info = unitDef(c.type).creature;
    if (!info) return fin(false, "Not a creature");
    const d = chebyshev(u.x, u.y, c.x, c.y);
    if (d > OBSERVE_RANGE) {
      const r = this.chase(u, c, 3);
      if (typeof r === "object") return fin(false, `Lost sight of the creature: ${r.fail}`);
      return;
    }
    u.path = null;
    this.setActivity(u, "observing");
    u.facing = facingFromDelta(c.x - u.x, c.y - u.y);
    task.progress += 1 / this.cfg.tickRate / (unitDef(u.type).tamer?.observeFactor ?? 1);
    if (info.hidden && c.activity === info.hidden.whileActivity) task.sawHidden = true;
    if (task.progress < info.observeSeconds) return;
    let learned = false;
    if (!p.observed.includes(c.type)) {
      p.observed.push(c.type);
      this.markPlayer(p);
      this.awardXp(p, XP_AWARDS.perObservation, "observation");
      this.audit.push({ tick: this.tick, playerId: p.id, action: "observed", detail: c.type });
      this.log(u, `Observed a ${unitDef(c.type).name.toLowerCase()}: its behaviour can now be inspected${info.tameCost > 0 ? " and it can be tamed" : ""}.`);
      learned = true;
    }
    if (info.hidden && task.sawHidden) this.grantDiscovery(p, info.hidden.discovery, `observing a ${c.type}`);
    void learned;
    fin(true, "");
  }

  private updateTame(u: UnitState, task: Extract<Task, { kind: "tame" }>): void {
    const c = this.units.get(task.targetId);
    const fin = (okRes: boolean, reason: string): void => this.finishTask(u, { ok: okRes, value: okRes, reason }, "tame");
    if (!c) return fin(false, "The creature is gone");
    const why = this.canTame(u, c);
    if (why) return fin(false, why);
    const r = this.chase(u, c, 1);
    if (r === "moving") return;
    if (r !== "arrived") return fin(false, `Could not reach the creature: ${r.fail}`);
    // Atomic: food is consumed and ownership changes in the same step.
    u.inventory.food -= this.tameCost(u, c);
    this.adoptCreature(c, u.owner);
    this.log(u, `Tamed a ${unitDef(c.type).name.toLowerCase()} (#${c.id}).`);
    fin(true, "");
  }

  /** A wild creature joins a player (taming, Wild Call). */
  private adoptCreature(c: UnitState, owner: number): void {
    const p = this.players.get(owner);
    if (!p) return;
    this.transferUnit(c, p.id);
    c.program = { source: unitDef(c.type).defaultProgram, version: 0, state: "stopped", error: null, note: "Tamed", library: null };
    c.home = { x: c.x, y: c.y };
    c.provokedBy = null;
    this.controlProgramInternal(c, "run");
    this.awardXp(p, XP_AWARDS.perTame, "taming");
    this.audit.push({ tick: this.tick, playerId: p.id, action: "tamed", detail: `${c.type} #${c.id}` });
  }

  /** Change a unit's owner, keeping owner indices consistent. */
  private transferUnit(u: UnitState, owner: number): void {
    this.unitsByOwner.get(u.owner)?.delete(u.id);
    u.owner = owner;
    let s = this.unitsByOwner.get(owner);
    if (!s) this.unitsByOwner.set(owner, (s = new Set()));
    s.add(u.id);
    u.vm = null;
    u.task = { kind: "idle" };
    u.inventory = emptyBag();
    this.markUnit(u);
  }

  private updateTrain(u: UnitState, task: Extract<Task, { kind: "train_creature" }>): void {
    const c = this.units.get(task.targetId);
    const fin = (okRes: boolean, reason: string): void => this.finishTask(u, { ok: okRes, value: okRes, reason }, "train_creature");
    if (!c) return fin(false, "The creature is gone");
    const why = this.canTrain(u, c, task.ability);
    if (why) return fin(false, why);
    const r = this.chase(u, c, 2);
    if (r === "moving") return;
    if (r !== "arrived") return fin(false, `Could not reach the creature: ${r.fail}`);
    this.setActivity(u, "taming");
    const t = unitDef(c.type).creature!.trainable[task.ability]!;
    task.progress += 1 / this.cfg.tickRate;
    if (task.progress < t.seconds) return;
    const p = this.players.get(u.owner)!;
    u.inventory.food -= t.cost;
    c.learned.push(task.ability);
    this.markUnit(c);
    this.awardXp(p, XP_AWARDS.perTraining, "training");
    this.audit.push({ tick: this.tick, playerId: p.id, action: "trained", detail: `${c.type} #${c.id} ${task.ability}` });
    if (c.type === "wolf" && task.ability === "guard") this.grantDiscovery(p, "pack_discipline", "training a wolf");
    fin(true, "");
  }

  private updateInvestigate(u: UnitState, task: Extract<Task, { kind: "investigate" }>): void {
    const ruin = this.chunks.ruinAt(task.x, task.y);
    const fin = (okRes: boolean, value: Value, reason: string): void => this.finishTask(u, { ok: okRes, value, reason }, "investigate");
    if (!ruin) return fin(false, null, "There is no ruin there");
    const r = this.approach(u, { x: ruin.x, y: ruin.y, w: 1, h: 1 }, 1);
    if (r === "moving") return;
    if (r !== "arrived") return fin(false, null, `Ruin unreachable: ${r.fail}`);
    this.setActivity(u, "investigating");
    const loot = RUIN_LOOT[ruin.tier];
    task.progress += 1 / this.cfg.tickRate;
    if (task.progress < loot.seconds) return;
    const p = this.players.get(u.owner);
    if (!p) return fin(false, null, "Owner missing");
    const key = `${ruin.x},${ruin.y}`;
    const salvaged = !this.lootedRuins.has(key);
    if (salvaged) {
      // Salvage goes once to whoever finishes first; Undead and talents increase it.
      this.lootedRuins.add(key);
      this.lootedNew.push({ x: ruin.x, y: ruin.y, playerId: p.id });
      this.ruinChanges.push({ x: ruin.x, y: ruin.y });
      const f = this.mods(p.id).factor("salvage");
      const parts: string[] = [];
      const bag: Partial<ResourceBag> = {};
      for (const [res, n] of Object.entries(loot.salvage) as [ResourceType, number][]) {
        const amount = Math.round(n * f);
        bag[res] = amount;
        parts.push(`${amount} ${res}`);
      }
      // Salvage is carried to your nearest storage.
      this.deliver(p.id, ruin.x, ruin.y, bag);
      this.audit.push({ tick: this.tick, playerId: p.id, action: "salvage", detail: `ruin ${key}: ${parts.join(", ")}` });
      this.log(u, `Salvaged ${parts.join(" and ")} from the ruins.`);
    }
    const disc = findDiscoveryDef(loot.fragment);
    const isNew = this.grantDiscovery(p, loot.fragment, `ruin at ${key}`);
    // Experience only for something gained (salvage or new knowledge), so re-reading a ruin cannot be farmed.
    if (salvaged || isNew) this.awardXp(p, XP_AWARDS.perInvestigation, "investigation");
    fin(true, disc ? disc.name : null, "");
  }

  private updateFollow(u: UnitState, task: Extract<Task, { kind: "follow" }>): void {
    const t = this.units.get(task.targetId);
    if (!t) return this.finishTask(u, { ok: false, value: false, reason: "Target is gone" }, "follow");
    if (this.tick >= task.until) return this.finishTask(u, { ok: true, value: true, reason: "" }, "follow");
    if (chebyshev(u.x, u.y, t.x, t.y) <= 2) {
      u.path = null;
      this.setActivity(u, "idle");
      return;
    }
    const r = this.chase(u, t, 2);
    if (typeof r === "object") this.finishTask(u, { ok: false, value: false, reason: `Lost track: ${r.fail}` }, "follow");
  }

  private updateGuard(u: UnitState, task: Extract<Task, { kind: "guard" }>): void {
    if (this.tick >= task.until) return this.finishTask(u, { ok: true, value: true, reason: "" }, "guard");
    const r = this.approach(u, { x: task.x, y: task.y, w: 1, h: 1 }, 2);
    if (r === "moving") return;
    if (r !== "arrived") return this.finishTask(u, { ok: false, value: false, reason: `Cannot reach the post: ${r.fail}` }, "guard");
    this.setActivity(u, "guarding");
  }

  private updateGather(u: UnitState, task: Extract<Task, { kind: "gather" }>): void {
    const node = this.chunks.nodeAt(task.nodeX, task.nodeY);
    const cap = this.capacity(u);
    const free = cap - bagTotal(u.inventory);
    const done = (okRes: boolean, reason: string): void =>
      this.finishTask(u, { ok: okRes, value: task.gathered, reason }, "harvest");
    if (!node || this.chunks.amountOf(node) <= 0) return done(task.gathered > 0, "Resource exhausted");
    if (free <= 0) return done(task.gathered > 0, "Inventory full");
    const r = this.approach(u, { x: task.nodeX, y: task.nodeY, w: 1, h: 1 }, 1);
    if (r === "moving") return;
    if (r !== "arrived") {
      u.avoid.set(`node:${task.nodeX}:${task.nodeY}`, this.tick + AVOID_TICKS_SECONDS * this.cfg.tickRate);
      return done(false, `Target out of reach: ${r.fail}`);
    }
    u.facing = facingFromDelta(task.nodeX - u.x, task.nodeY - u.y);
    this.setActivity(u, task.resource === "wood" ? "harvesting" : task.resource === "food" ? "foraging" : "mining");
    task.acc += task.rate / this.cfg.tickRate;
    const want = Math.min(Math.floor(task.acc), free);
    if (want > 0) {
      const taken = this.chunks.takeFromNode(task.nodeX, task.nodeY, want);
      task.acc -= want;
      u.inventory[task.resource] += taken;
      task.gathered += taken;
      this.markUnit(u);
      this.onGathered(u, task.resource, taken);
      if (bagTotal(u.inventory) >= cap) return done(true, "");
      if (this.chunks.amountAt(task.nodeX, task.nodeY) <= 0) return done(true, "");
    }
  }

  private onGathered(u: UnitState, _resource: ResourceType, amount: number): void {
    const p = this.players.get(u.owner);
    if (p) this.awardXp(p, amount * XP_AWARDS.perResourceGathered, "gathering");
  }

  private updateWithdraw(u: UnitState, task: Extract<Task, { kind: "withdraw" }>): void {
    const fin = (okRes: boolean, value: Value, reason: string): void => this.finishTask(u, { ok: okRes, value, reason }, "withdraw");
    const free = this.capacity(u) - bagTotal(u.inventory);
    if (free <= 0) return fin(false, 0, "Inventory full");
    let b = task.buildingId !== null ? this.buildings.get(task.buildingId) : undefined;
    if (task.explicit) {
      if (!b || b.owner !== u.owner || !b.complete) return fin(false, 0, "That storage building no longer exists");
      if (this.networksMode && b.stock[task.resource] <= 0) return fin(false, 0, `${buildingDef(b.type).name} #${b.id} holds no ${task.resource}`);
    } else if (!b || b.owner !== u.owner || !b.complete || !buildingDef(b.type).storage || (this.networksMode && b.stock[task.resource] <= 0)) b = this.nearestStorageWith(u, task.resource);
    if (!b) return fin(false, 0, this.networksMode ? `None of your storage buildings holds any ${task.resource}` : `No ${task.resource} in stock`);
    task.buildingId = b.id;
    const r = this.approach(u, { x: b.x, y: b.y, w: b.w, h: b.h }, 1);
    if (r === "moving") return;
    if (r !== "arrived") return fin(false, 0, `Storage is inaccessible: ${r.fail}`);
    // Atomic transfer: the stock (that building's in networks mode) -> inventory, bounded by stock and free capacity.
    const available = this.networksMode ? b.stock[task.resource] : (this.players.get(u.owner)?.resources[task.resource] ?? 0);
    const n = Math.min(task.amount, free, available);
    if (n <= 0) {
      task.buildingId = null; // emptied meanwhile: try another storage next tick
      if (!this.nearestStorageWith(u, task.resource)) return fin(false, 0, `None of your storage buildings holds any ${task.resource}`);
      return;
    }
    if (this.networksMode) this.changeStock(b, task.resource, -n);
    else {
      const p = this.players.get(u.owner) as PlayerState;
      p.resources[task.resource] -= n;
      this.markPlayer(p);
    }
    u.inventory[task.resource] += n;
    this.markUnit(u);
    this.audit.push({ tick: this.tick, playerId: u.owner, action: "withdraw", detail: `unit #${u.id} took ${n} ${task.resource} at #${b.id}` });
    fin(true, n, "");
  }

  private updateDeposit(u: UnitState, task: Extract<Task, { kind: "deposit" }>): void {
    if (bagTotal(u.inventory) === 0) return this.finishTask(u, { ok: false, value: false, reason: "Nothing to deposit" }, "deposit");
    const fail = (reason: string): void => this.finishTask(u, { ok: false, value: false, reason }, "deposit");
    let b = task.buildingId !== null ? this.buildings.get(task.buildingId) : this.storageForDeposit(u);
    if (!b || b.owner !== u.owner || !b.complete || !buildingDef(b.type).storage) {
      if (task.explicit) return fail("That storage building no longer exists");
      task.buildingId = null;
      b = this.storageForDeposit(u);
    }
    if (!b) return fail(this.storagesOf(u.owner).length ? "All your storage buildings are full: build or research more storage" : "No completed storage building available");
    if (!task.explicit && this.storageFree(b) <= 0) {
      // Filled up while we walked: pick the next storage with room.
      const next = this.storageForDeposit(u);
      if (!next) return fail("All your storage buildings are full: build or research more storage");
      b = next;
    }
    task.buildingId = b.id;
    const r = this.approach(u, { x: b.x, y: b.y, w: b.w, h: b.h }, 1);
    if (r === "moving") return;
    if (r !== "arrived") return fail(`Storage is inaccessible: ${r.fail}`);
    // Atomic transfer: inventory -> this building's stock, as much as fits.
    let room = this.storageFree(b);
    const p = this.players.get(u.owner);
    for (const res of RESOURCE_TYPES) {
      const n = Math.min(room, u.inventory[res]);
      if (n <= 0) continue;
      if (this.networksMode) this.changeStock(b, res, n);
      else if (p) {
        p.resources[res] += n;
        this.markPlayer(p);
      }
      u.inventory[res] -= n;
      room -= n;
    }
    this.markUnit(u);
    if (bagTotal(u.inventory) === 0) return this.finishTask(u, { ok: true, value: true, reason: "" }, "deposit");
    if (task.explicit) return fail(`${buildingDef(b.type).name} #${b.id} is full`);
    // Partly stored: carry the rest to the next storage with room.
    const next = this.storageForDeposit(u, new Set([b.id]));
    if (!next) return fail("All your storage buildings are full: build or research more storage");
    task.buildingId = next.id;
  }

  private nearestStorage(u: UnitState): BuildingState | undefined {
    let best: BuildingState | undefined;
    let bestD = Infinity;
    for (const id of this.buildingsOf(u.owner)) {
      const b = this.buildings.get(id);
      if (!b || !b.complete || !buildingDef(b.type).storage) continue;
      const d = distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
      if (d < bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  }

  private updateBuild(u: UnitState, task: Extract<Task, { kind: "build" }>): void {
    const b = this.buildings.get(task.buildingId);
    if (!b || b.owner !== u.owner) return this.finishTask(u, { ok: false, value: false, reason: "Construction site no longer exists" }, "build");
    if (b.complete) return this.finishTask(u, { ok: true, value: true, reason: "" }, "build");
    const r = this.approach(u, { x: b.x, y: b.y, w: b.w, h: b.h }, 1);
    if (r === "moving") return;
    if (r !== "arrived") return this.finishTask(u, { ok: false, value: false, reason: `Construction site unreachable: ${r.fail}` }, "build");
    this.setActivity(u, "building");
    if (this.addConstruction(b, (this.stat(u.owner, "buildRate", unitDef(u.type).buildRate) * Math.max(0.2, 1 + this.unitPct(u, "buildRate"))) / this.cfg.tickRate)) {
      return this.finishTask(u, { ok: true, value: true, reason: "" }, "build");
    }
  }

  /** Advance a construction site; completes it (territory, experience) when done. Returns true when complete. */
  private addConstruction(b: BuildingState, points: number): boolean {
    const def = buildingDef(b.type);
    const maxHp = this.buildingMaxHp(b);
    b.progress = Math.min(def.buildTime, b.progress + points);
    b.hp = Math.max(b.hp, Math.ceil(maxHp * (0.1 + 0.9 * (b.progress / def.buildTime))));
    if (b.progress >= def.buildTime - 1e-9) {
      b.complete = true;
      b.progress = def.buildTime;
      b.hp = maxHp;
      b.completedTick = this.tick;
      this.audit.push({ tick: this.tick, playerId: b.owner, action: "building_complete", detail: `${b.type} #${b.id}` });
      this.markBuilding(b);
      this.claimTerritory(b);
      this.onBuildingCompleted(b);
      return true;
    }
    this.markBuilding(b);
    return false;
  }

  private onBuildingCompleted(b: BuildingState): void {
    const p = this.players.get(b.owner);
    if (!p) return;
    const cost = buildingDef(b.type).cost;
    let total = 0;
    for (const r of RESOURCE_TYPES) total += cost[r] ?? 0;
    this.awardXp(p, total * XP_AWARDS.constructionFraction, "construction");
  }

  private updateBuilding(b: BuildingState): void {
    const def = buildingDef(b.type);
    if (def.pen) this.updatePaddock(b);
    const order = b.queue[0];
    if (order) {
      const total = this.orderTime(b.owner, order);
      if (order.progress < total) {
        order.progress = Math.min(total, order.progress + this.orderSpeed(b, order) / this.cfg.tickRate);
        if (Math.round(order.progress * this.cfg.tickRate) % this.cfg.tickRate === 0) this.markBuilding(b);
      }
      if (order.progress >= total) {
        if (order.kind === "hero") {
          const spot = this.spawnSpotNear(b);
          if (spot) {
            b.queue.shift();
            this.spawnHero(b.owner, spot.x, spot.y);
            this.markBuilding(b);
          }
        } else if (order.kind === "hero_training") {
          b.queue.shift();
          this.completeHeroTraining(b.owner, order.track, order.rank);
          this.markBuilding(b);
        } else if (order.kind === "unit") {
          const spot = this.spawnSpotNear(b);
          if (spot) {
            b.queue.shift();
            const u = this.addUnit(b.owner, order.unitType, spot.x, spot.y, true);
            this.audit.push({ tick: this.tick, playerId: b.owner, action: "unit_trained", detail: `${u.type} #${u.id}` });
            this.markBuilding(b);
          }
        } else {
          b.queue.shift();
          const p = this.players.get(b.owner);
          if (p && !p.techs.includes(order.techId)) {
            p.techs.push(order.techId);
            this.invalidateMods(p.id);
            this.markPlayer(p);
            this.audit.push({ tick: this.tick, playerId: p.id, action: "research_complete", detail: order.techId });
            this.onResearchCompleted(p, order.techId);
          }
          this.markBuilding(b);
        }
      }
    }
    if (def.produces) {
      const p = this.players.get(b.owner);
      if (!p) return;
      const mult = (1 + FERTILE_BONUS * b.fertility) * this.mods(b.owner).factor("production");
      for (const res of RESOURCE_TYPES) {
        const rate = def.produces[res];
        if (!rate) continue;
        b.prodAcc += (rate * mult) / this.cfg.tickRate;
        const whole = Math.floor(b.prodAcc);
        if (whole > 0 && !this.networksMode) {
          b.prodAcc -= whole;
          p.resources[res] += whole;
          this.markPlayer(p);
          this.persist.buildings.add(b.id);
          continue;
        }
        if (whole > 0) {
          // Delivered to the nearest storage with room within supply range; held (up to 10) otherwise.
          const target = this.supplyTarget(b);
          if (!target) {
            b.prodAcc = Math.min(b.prodAcc, 10);
            if (!b.prodBlocked) {
              b.prodBlocked = true;
              this.markBuilding(b);
            }
            continue;
          }
          if (b.prodBlocked) {
            b.prodBlocked = false;
            this.markBuilding(b);
          }
          b.prodAcc -= whole;
          this.changeStock(target, res, Math.min(whole, this.storageFree(target)));
          this.persist.buildings.add(b.id);
        }
      }
    }
  }

  private onResearchCompleted(p: PlayerState, techId: string): void {
    this.onModifiersChanged(p);
    const cost = findTechDef(techId)?.cost ?? {};
    let total = 0;
    for (const r of RESOURCE_TYPES) total += cost[r] ?? 0;
    this.awardXp(p, total * XP_AWARDS.researchFraction, "research");
  }

  private spawnSpotNear(b: BuildingState): { x: number; y: number } | null {
    for (let r = 1; r <= 4; r++) {
      for (let y = b.y - r; y < b.y + b.h + r; y++) {
        for (let x = b.x - r; x < b.x + b.w + r; x++) {
          if (distToRect(x, y, b.x, b.y, b.w, b.h) !== r) continue;
          if (this.isPassable(x, y)) return { x, y };
        }
      }
    }
    return null;
  }



  // ------------------------------------------------------------------ removing your own units and buildings

  /**
   * Dismiss some of your units. Tamed animals go back to the wild where they stand; other
   * units (and anything they carry) are gone. Heroes cannot be dismissed. All or nothing:
   * if any id is invalid nothing changes.
   */
  dismissUnits(playerId: number, unitIds: number[]): CommandResult<number> {
    const list: UnitState[] = [];
    for (const id of new Set(unitIds)) {
      const r = this.ownUnit(playerId, id);
      if (!r.ok) return r;
      if (this.isHero(r.value)) return fail("hero", "Heroes cannot be dismissed");
      list.push(r.value);
    }
    if (list.length === 0) return fail("empty", "No units to dismiss");
    for (const u of list) {
      const def = unitDef(u.type);
      if (def.creature) {
        // Back to the wild: it runs its species' wild program around where it was let go.
        if (u.pen !== null) {
          const b = this.buildings.get(u.pen);
          if (b) this.letOut(u, b);
          u.pen = null;
        }
        this.transferUnit(u, NEUTRAL);
        u.program = { source: def.creature.wildProgram, version: 0, state: "stopped", error: null, note: "", library: null };
        u.home = { x: u.x, y: u.y };
        u.learned = [];
        this.controlProgramInternal(u, "run");
        this.invalidateMods(playerId);
        this.eliminationCheck.add(playerId);
      } else {
        this.removeUnit(u);
      }
      this.audit.push({ tick: this.tick, playerId, action: "unit_dismissed", detail: `${u.type} #${u.id}${def.creature ? " (released to the wild)" : ""}` });
    }
    const p = this.players.get(playerId);
    if (p) this.markPlayer(p);
    return ok(list.length);
  }

  /**
   * Demolish one of your buildings. A construction site refunds half of what was paid;
   * a completed building refunds nothing, and (storage networks) whatever it held is lost.
   * Its territory is released and a paddock's animals are let out.
   */
  demolishBuilding(playerId: number, buildingId: number): CommandResult<{ refund: Partial<ResourceBag> }> {
    const r = this.ownBuilding(playerId, buildingId);
    if (!r.ok) return r;
    const b = r.value;
    const def = buildingDef(b.type);
    const refund: Partial<ResourceBag> = {};
    if (!b.complete) {
      const paid = this.scaledCost(playerId, def.cost, "buildingCost");
      for (const res of RESOURCE_TYPES) if (paid[res] > 0) refund[res] = Math.floor(paid[res] * DEMOLISH_SITE_REFUND);
    }
    // Queued training and research are cancelled without refund (as when a building is destroyed).
    this.audit.push({ tick: this.tick, playerId, action: "building_demolished", detail: `${b.type} #${b.id}${b.complete ? "" : " (site)"} refund ${formatCost(refund)}` });
    this.removeBuilding(b);
    if (RESOURCE_TYPES.some((res) => (refund[res] ?? 0) > 0)) this.deliver(playerId, b.x, b.y, refund);
    const p = this.players.get(playerId);
    if (p) this.markPlayer(p);
    return ok({ refund });
  }

  // ------------------------------------------------------------------ PvE lairs

  /**
   * Once a second: lairs in chunks near players come alive (their monsters appear) when
   * dormant, or when cleared and their respawn time has passed (unless someone's territory
   * now covers the lair's centre: a claimed lair stays clear).
   */
  private updateLairs(): void {
    if (this.tick % this.cfg.tickRate !== 6) return;
    const size = this.chunks.size;
    for (const key of this.activeChunks) {
      const [cx, cy] = key.split(",").map(Number) as [number, number];
      for (const l of this.lairs.centredIn(cx * size, cy * size, cx * size + size - 1, cy * size + size - 1)) {
        const st = this.lairState.get(l.id);
        if (st?.status === "active") continue;
        if (st?.status === "cleared" && (st.respawnTick === null || this.tick < st.respawnTick)) continue;
        if (this.territory.ownerAt(l.x, l.y) !== 0) continue;
        this.spawnLair(l);
      }
    }
  }

  private spawnLair(l: Lair): void {
    const def = LAIR_DEFS[l.kind];
    if (!def) return;
    const rng = new SeededRandom(hashString(`lair:${l.id}:${this.tick}`));
    const place = (type: string, dist: number): void => {
      const a = rng.next() * Math.PI * 2;
      const spot = this.nearestPassable(Math.round(l.x + Math.cos(a) * dist), Math.round(l.y + Math.sin(a) * dist), 3);
      if (spot) this.spawnCreature(type, spot.x, spot.y);
    };
    place(def.boss, 0);
    for (const p of def.pack) for (let i = 0; i < p.count; i++) place(p.type, 1.5 + rng.next() * Math.max(1, l.r / 2));
    const prev = this.lairState.get(l.id);
    this.lairState.set(l.id, { id: l.id, status: "active", clearedBy: prev?.clearedBy ?? null, clearedTick: prev?.clearedTick ?? null, respawnTick: null, claimUntil: null });
    this.lairNet.add(l.id);
    this.lairDirty.add(l.id);
    this.audit.push({ tick: this.tick, playerId: NEUTRAL, action: "lair_spawned", detail: `${l.kind} ${l.id} at ${l.x},${l.y}` });
  }

  /** Living monsters of a lair. */
  lairMonsters(l: Lair): UnitState[] {
    const out: UnitState[] = [];
    for (const id of this.unitsOf(NEUTRAL)) {
      const u = this.units.get(id);
      if (u && u.home && unitDef(u.type).monster && Math.hypot(u.home.x - l.x, u.home.y - l.y) <= l.r) out.push(u);
    }
    return out;
  }

  /** Rewards for a kill, and clearing the lair when its last monster falls. */
  private onMonsterKilled(t: UnitState, killer: UnitState, lair: Lair | null): void {
    const def = unitDef(t.type);
    const m = def.monster;
    const p = this.players.get(killer.owner);
    if (!m || !p) return;
    const ld = lair ? LAIR_DEFS[lair.kind] : undefined;
    const loot: Partial<ResourceBag> = { ...(m.boss && ld ? ld.bossLoot : m.loot) };
    const parts = RESOURCE_TYPES.filter((r) => (loot[r] ?? 0) > 0).map((r) => `${loot[r]} ${r}`);
    if (parts.length) this.deliver(p.id, killer.x, killer.y, loot);
    this.awardXp(p, m.xp, "monsters");
    this.log(killer, `Defeated a ${def.name.toLowerCase()}${parts.length ? `: ${parts.join(", ")}` : ""}.`);
    if (m.boss) {
      this.notice(p.id, "success", `Your ${unitDef(killer.type).name.toLowerCase()} slew the ${def.name}!${parts.length ? ` Loot: ${parts.join(", ")}.` : ""}`);
      if (ld && !p.trophies.includes(ld.trophy.id)) {
        p.trophies.push(ld.trophy.id);
        this.invalidateMods(p.id);
        this.onModifiersChanged(p);
        this.markPlayer(p);
        this.notice(p.id, "success", `Trophy: ${ld.trophy.name}. ${ld.trophy.description}`);
        this.audit.push({ tick: this.tick, playerId: p.id, action: "trophy", detail: ld.trophy.id });
      }
      if (ld) this.grantDiscovery(p, ld.discovery, `defeating a ${def.name}`);
    }
    if (!lair || !ld) return;
    const st = this.lairState.get(lair.id);
    if (st?.status !== "active" || this.lairMonsters(lair).length > 0) return;
    const minute = 60 * this.cfg.tickRate;
    this.lairState.set(lair.id, {
      id: lair.id,
      status: "cleared",
      clearedBy: p.id,
      clearedTick: this.tick,
      respawnTick: this.tick + ld.respawnMinutes * minute,
      claimUntil: this.tick + LAIR_CLAIM_MINUTES * minute,
    });
    this.lairNet.add(lair.id);
    this.lairDirty.add(lair.id);
    this.awardXp(p, ld.clearXp, "monsters");
    this.notice(p.id, "success", `You cleared the ${ld.name} at ${lair.x}, ${lair.y}! For ${LAIR_CLAIM_MINUTES} minutes only you may build there: an Outpost in it claims the land (however far from your territory). Unclaimed, it is reoccupied in ${ld.respawnMinutes} minutes.`);
    this.audit.push({ tick: this.tick, playerId: p.id, action: "lair_cleared", detail: `${lair.kind} ${lair.id}` });
  }

  /** Restore a lair's saved state (bootstrap). */
  restoreLair(st: LairState): void {
    if (this.lairs.byId(st.id)) this.lairState.set(st.id, st);
  }

  /** Clerics heal your units nearby (once a second). */
  private healAuras(): void {
    if (this.tick % this.cfg.tickRate !== 7) return;
    for (const u of this.units.values()) {
      const h = u.owner !== NEUTRAL ? unitDef(u.type).healer : undefined;
      if (!h || u.pen !== null) continue;
      for (const t of this.ownUnitsNear(u.owner, u.x, u.y, h.radius)) {
        const max = this.unitMaxHp(t);
        if (t.hp >= max || t.pen !== null) continue;
        t.hp = Math.min(max, t.hp + h.hpPerSecond);
        this.markUnit(t);
      }
    }
  }

  // ------------------------------------------------------------------ paddocks

  /** Animals currently in a paddock. */
  pennedIn(b: BuildingState): UnitState[] {
    const out: UnitState[] = [];
    for (const id of this.unitsOf(b.owner)) {
      const u = this.units.get(id);
      if (u?.pen === b.id) out.push(u);
    }
    return out;
  }

  /** Penned animals of a player by species (for paddock bonuses). */
  pennedCounts(playerId: number): Map<string, number> {
    const m = new Map<string, number>();
    for (const id of this.unitsOf(playerId)) {
      const u = this.units.get(id);
      if (u && u.pen !== null) m.set(u.type, (m.get(u.type) ?? 0) + 1);
    }
    return m;
  }

  /** Why animal `u` cannot go into paddock `b`, or null. */
  penBlocker(u: UnitState, b: BuildingState): string | null {
    const def = buildingDef(b.type);
    const info = unitDef(u.type).creature?.paddock;
    if (!def.pen) return `A ${def.name} is not a paddock`;
    if (b.owner !== u.owner) return "Permission denied: not your paddock";
    if (!b.complete) return "The paddock is still under construction";
    if (!info) return `${unitDef(u.type).name}s cannot be kept in a paddock`;
    if (u.pen === b.id) return "Already in this paddock";
    if (this.pennedIn(b).length >= def.pen) return `The paddock is full (${def.pen} animals)`;
    return null;
  }

  private updatePen(u: UnitState, task: Extract<Task, { kind: "pen" }>): void {
    const fin = (okRes: boolean, reason: string): void => this.finishTask(u, { ok: okRes, value: okRes, reason }, "pen");
    const b = this.buildings.get(task.buildingId);
    if (!b) return fin(false, "The paddock no longer exists");
    const why = this.penBlocker(u, b);
    if (why) return fin(false, why);
    const r = this.approach(u, { x: b.x, y: b.y, w: b.w, h: b.h }, 1);
    if (r === "moving") return;
    if (r !== "arrived") return fin(false, `Paddock unreachable: ${r.fail}`);
    fin(true, "");
    this.enterPen(u, b);
  }

  /** Put an animal into a paddock: it stops its program and lives inside the fence. */
  private enterPen(u: UnitState, b: BuildingState): void {
    const p = this.players.get(u.owner);
    u.pen = b.id;
    u.vm = null;
    u.path = null;
    u.task = { kind: "idle" };
    u.pendingResult = null;
    u.scriptAction = null;
    u.program.state = "stopped";
    u.program.note = `Living in paddock #${b.id}`;
    this.setActivity(u, "idle");
    const spot = this.penSpot(b, u.id + this.tick);
    this.moveUnitTo(u, spot.x, spot.y);
    this.markUnit(u);
    this.markBuilding(b);
    this.log(u, `Entered paddock #${b.id}.`);
    if (p) {
      this.invalidateMods(p.id);
      this.markPlayer(p);
    }
  }

  /** A tile inside the paddock's fence (deterministic for a given salt). */
  private penSpot(b: BuildingState, salt: number): { x: number; y: number } {
    const rng = new SeededRandom(hashString(`pen:${b.id}:${salt}`));
    return { x: b.x + rng.int(b.w), y: b.y + rng.int(b.h) };
  }

  /** Let an animal out of its paddock. Its program stays stopped until you run it. */
  releaseAnimal(playerId: number, buildingId: number, unitId: number): CommandResult<UnitState> {
    const r = this.ownBuilding(playerId, buildingId);
    if (!r.ok) return r;
    const b = r.value;
    const u = this.units.get(unitId);
    if (!u || u.owner !== playerId || u.pen !== b.id) return fail("not_found", "That animal is not in this paddock");
    if (this.limitedUnits(playerId) >= this.unitCap(playerId)) return fail("limit", `Unit limit (${this.unitCap(playerId)}) reached: an animal outside a paddock counts toward it`);
    if (!this.letOut(u, b)) return fail("blocked", "There is no free ground next to the paddock");
    this.audit.push({ tick: this.tick, playerId, action: "released", detail: `${u.type} #${u.id} from #${b.id}` });
    return ok(u);
  }

  private letOut(u: UnitState, b: BuildingState): boolean {
    const spot = this.spawnSpotNear(b);
    if (!spot) return false;
    u.pen = null;
    u.home = { x: spot.x, y: spot.y };
    u.program.state = "stopped";
    u.program.note = "Released from the paddock: run its program, or give it orders";
    this.moveUnitTo(u, spot.x, spot.y);
    this.markUnit(u);
    this.markBuilding(b);
    const p = this.players.get(u.owner);
    if (p) {
      this.invalidateMods(p.id);
      this.markPlayer(p);
    }
    return true;
  }

  /** Paddock upkeep, every tick: production, breeding, and animals shuffling about inside. */
  private updatePaddock(b: BuildingState): void {
    const def = buildingDef(b.type);
    if (!def.pen || !b.pen) return;
    const animals = this.pennedIn(b);
    if (animals.length === 0) return;
    const st = b.pen;
    const rate = this.cfg.tickRate;
    // Production: per animal per minute, delivered to your stock like farm output.
    const mult = this.mods(b.owner).factor("production");
    const due: Partial<ResourceBag> = {};
    let any = false;
    for (const a of animals) {
      const prod = unitDef(a.type).creature?.paddock?.produces ?? {};
      for (const res of RESOURCE_TYPES) {
        const n = prod[res];
        if (!n) continue;
        const acc = (st.acc[res] ?? 0) + (n * mult) / 60 / rate;
        const whole = Math.floor(acc);
        st.acc[res] = acc - whole;
        if (whole > 0) {
          due[res] = (due[res] ?? 0) + whole;
          any = true;
        }
      }
    }
    if (any) {
      this.deliverProduction(b, due);
      this.persist.buildings.add(b.id);
    }
    // Breeding: a pair of a species raises a young one over its breeding time, while there is room.
    if (this.tick % rate === 0) {
      const counts = new Map<string, number>();
      for (const a of animals) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
      const room = (def.pen ?? 0) - animals.length;
      for (const [type, n] of counts) {
        const info = unitDef(type).creature?.paddock;
        if (!info || n < 2) {
          if (st.breed[type] !== undefined) delete st.breed[type];
          continue;
        }
        const before = st.breed[type] ?? 0;
        if (room <= 0 || before >= 1) {
          if (before >= 1 && room > 0) this.tryBirth(b, type, info.breedCost);
          continue;
        }
        st.breed[type] = Math.min(1, before + 1 / info.breedSeconds);
        if (Math.floor(before * 10) !== Math.floor((st.breed[type] as number) * 10)) this.markBuilding(b);
        if ((st.breed[type] as number) >= 1) this.tryBirth(b, type, info.breedCost);
      }
      this.persist.buildings.add(b.id);
    }
    // Every few seconds one animal ambles to another spot inside the fence.
    if (this.tick % (3 * rate) === b.id % (3 * rate)) {
      const a = animals[Math.floor(this.tick / (3 * rate)) % animals.length] as UnitState;
      const spot = this.penSpot(b, this.tick);
      if (spot.x !== a.x || spot.y !== a.y) {
        const f = facingFromDelta(Math.sign(spot.x - a.x), Math.sign(spot.y - a.y));
        a.facing = f;
        this.moveUnitTo(a, spot.x, spot.y);
        this.markUnit(a);
      }
    }
  }

  /** A young animal is born if its food can be paid; otherwise breeding waits until it can. */
  private tryBirth(b: BuildingState, type: string, cost: number): void {
    if (!b.pen) return;
    const paid = this.payAt(b.owner, b, { food: cost }, "raising a young animal");
    if (!paid.ok) return;
    b.pen.breed[type] = 0;
    const spot = this.penSpot(b, this.tick + 7);
    const u = this.addUnit(b.owner, type, spot.x, spot.y, false);
    u.pen = b.id;
    u.home = { x: spot.x, y: spot.y };
    u.program.note = `Born in paddock #${b.id}`;
    this.markUnit(u);
    this.markBuilding(b);
    const p = this.players.get(b.owner);
    if (p) {
      this.invalidateMods(p.id);
      this.markPlayer(p);
    }
    this.notice(b.owner, "success", `A young ${unitDef(type).name.toLowerCase()} was born in your paddock (${cost} food).`);
    this.audit.push({ tick: this.tick, playerId: b.owner, action: "animal_born", detail: `${type} #${u.id} in #${b.id}` });
  }

  /** Deliver building output (farm, paddock) to the owner's stock, or (storage networks) to nearby storage. */
  private deliverProduction(b: BuildingState, bag: Partial<ResourceBag>): void {
    const p = this.players.get(b.owner);
    if (!p) return;
    if (!this.networksMode) {
      for (const res of RESOURCE_TYPES) p.resources[res] += bag[res] ?? 0;
      this.markPlayer(p);
      return;
    }
    const target = this.supplyTarget(b);
    if (!target) {
      if (!b.prodBlocked) {
        b.prodBlocked = true;
        this.markBuilding(b);
      }
      return;
    }
    if (b.prodBlocked) {
      b.prodBlocked = false;
      this.markBuilding(b);
    }
    for (const res of RESOURCE_TYPES) {
      const n = bag[res] ?? 0;
      if (n > 0) this.changeStock(target, res, Math.min(n, this.storageFree(target)));
    }
  }

  // ------------------------------------------------------------------ misc helpers for views

  nodeKindAt(x: number, y: number): NodeKind | null {
    return this.chunks.nodeAt(x, y)?.kind ?? null;
  }
}

const EMPTY: ReadonlySet<number> = new Set();

/** Upper bound on wild creatures in the world. */
const MAX_WILDLIFE = 3000;
/** Combat tuning (only used when combat is enabled). */
const PROVOKE_SECONDS = 30;
const LAST_HIT_SECONDS = 10;
const CHASE_EXTRA_TILES = 10;
const FLEE_TILES = 10;
const REGEN_DELAY_SECONDS = 10;
const REGEN_FRACTION_PER_SECOND = 0.02;
const REPAIR_COST_FRACTION = 0.5;
/** Share of a construction site's cost given back when it is demolished. */
const DEMOLISH_SITE_REFUND = 0.5;
/** Minimum gap between two on_attacked calls for one unit (ticks at 10 ticks/s). */
const ATTACK_EVENT_TICKS = 20;
/** Stealth: other players' units or buildings this close notice a hidden unit (Watchtowers further). */
const DETECT_RADIUS = 5;
const WATCHTOWER_DETECT_RADIUS = 12;
/** Seconds a hidden unit stays visible after fighting. */
const REVEAL_SECONDS = 10;
/** Experience value of defeating a hero (as if it had cost this much). */
const HERO_KILL_VALUE = 300;
/** Undead "reuse the defeated": share of a defeated unit's cost reclaimed (before salvage bonuses). */
const REUSE_DEFEATED_FRACTION = 0.3;
const SPAWN_CHUNKS_PER_TICK = 4;
/** One creature returns to a depleted chunk at most this often. */
const WILDLIFE_RENEW_SECONDS = 300;
/** Observation range (tiles). */
const OBSERVE_RANGE = 6;

/** Numeric tile key (coordinates are bounded by maxCoordinate <= 1,000,000). */
function tileNum(x: number, y: number): number {
  return (x + 1_048_576) * 2_097_152 + (y + 1_048_576);
}

/** Coarse route plans allowed per tick (long journeys); further requests wait a tick. */
const WIDE_SEARCHES_PER_TICK = 4;
/** Long-range planning time budget per tick (ms); further searches wait for the next tick. */
const WIDE_MS_PER_TICK = 15;
/** All pathfinding per tick (ms). At 10 ticks/s this keeps a tick well inside its 100 ms slot. */
const PATH_MS_PER_TICK = 30;


/** Technologies whose effects include an unlock, indexed for prerequisite messages. */
const TECHS_BY_UNLOCK: Record<string, { name: string; unlock: string }> = Object.fromEntries(
  Object.values(TECH_DEFS).flatMap((t) => t.effects.flatMap((e) => ("unlock" in e ? [[t.id, { name: t.name, unlock: e.unlock }]] : []))),
);

/** The durable part of a unit; everything else is reconstructed on load. */
/** Where an ability is aimed: a unit, a tile, or nothing (abilities centred on the hero). */
export type AbilityTarget = { unitId: number } | { x: number; y: number } | null;

export type PersistedUnit = Omit<UnitState, "vm" | "path" | "moveProgress" | "log" | "exploreCount" | "avoid" | "activity" | "pendingResult" | "scriptAction" | "trace" | "detailRev" | "pathFail" | "pathNarrowFailed" | "rev" | "lastHit" | "provokedBy" | "attackedBy" | "lastAttackEvent" | "revealedUntil" | "wasStealthy" | "buffs" | "cooldowns">;

function rectGap(a: Rect, b: Rect): number {
  const gx = Math.max(0, Math.max(a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1)));
  const gy = Math.max(0, Math.max(a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1)));
  return Math.max(gx, gy);
}

export function formatCost(cost: Partial<ResourceBag>): string {
  const parts = RESOURCE_TYPES.filter((r) => (cost[r] ?? 0) > 0).map((r) => `${cost[r]} ${r}`);
  return parts.length ? parts.join(", ") : "nothing";
}

export function validateSimConfig(c: SimConfig): void {
  if (!Number.isInteger(c.tickRate) || c.tickRate < 1 || c.tickRate > 60) throw new Error("simulation.tickRate must be an integer between 1 and 60");
  if (!(c.scriptOpsPerUnitTick >= 10 && c.scriptOpsPerUnitTick <= 100_000)) throw new Error("simulation.scriptOpsPerUnitTick must be between 10 and 100000");
  if (!(c.scriptOpsPerTick >= 100 && c.scriptOpsPerTick <= 10_000_000)) throw new Error("simulation.scriptOpsPerTick must be between 100 and 10000000");
  if (!(c.pathRadius >= 8 && c.pathRadius <= 256)) throw new Error("simulation.pathRadius must be between 8 and 256");
  if (!(c.maxCachedChunks >= 16 && c.maxCachedChunks <= 100_000)) throw new Error("simulation.maxCachedChunks must be between 16 and 100000");
  if (typeof c.combatEnabled !== "boolean") throw new Error("combat.enabled must be true or false");
  if (!(c.pvpOptOutSeconds >= 10 && c.pvpOptOutSeconds <= 3600)) throw new Error("combat.optOutDelaySeconds must be between 10 and 3600");
  if (typeof c.contestedZones !== "boolean") throw new Error("combat.contestedZones must be true or false");
  if (typeof c.pveEnabled !== "boolean") throw new Error("combat.pve must be true or false");
  if (c.storageMode !== "shared" && c.storageMode !== "networks") throw new Error('economy.storage must be "shared" or "networks"');
  if (!(Number.isInteger(c.unitLimitCeiling) && c.unitLimitCeiling >= 10 && c.unitLimitCeiling <= 5000)) throw new Error("economy.unitLimitCeiling must be a whole number between 10 and 5000");
  if (!(Number.isInteger(c.buildingLimitCeiling) && c.buildingLimitCeiling >= 10 && c.buildingLimitCeiling <= 5000)) throw new Error("economy.buildingLimitCeiling must be a whole number between 10 and 5000");
}
