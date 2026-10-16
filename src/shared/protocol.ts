/**
 * Network protocol between browser clients and the authoritative server.
 * JSON text frames; every message has a `t` discriminator. All client messages
 * are validated by parseClientMessage() before the server acts on them.
 * See docs/ARCHITECTURE.md#network-protocol.
 */
import type { ResourceBag } from "./defs/resources.ts";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- client -> server

export type UnitCommand =
  | { kind: "move"; x: number; y: number }
  | { kind: "gather"; x: number; y: number }
  | { kind: "build"; buildingId: number }
  | { kind: "deposit" }
  | { kind: "stop" }
  | { kind: "investigate"; x: number; y: number }
  | { kind: "observe" | "tame"; targetId: number }
  | { kind: "attack"; targetId: number }
  | { kind: "attack_building" | "repair" | "pen"; buildingId: number };

export type ProgramAction = "run" | "pause" | "resume" | "stop";

export type AbilityTargetMsg = { unitId: number } | { x: number; y: number } | null;

/** A timed ability effect, as shown to the owner. */
export interface BuffView {
  stat: string;
  pct: number;
  seconds: number;
  source: string;
}

export type ClientMessage =
  | { t: "hello"; v: number; name: string; token?: string; race?: string }
  | { t: "subscribe"; chunks: [number, number][] }
  | { t: "unit_cmd"; reqId: number; unitId: number; cmd: UnitCommand }
  | { t: "place_building"; reqId: number; type: string; x: number; y: number }
  | { t: "train"; reqId: number; buildingId: number; unitType: string }
  | { t: "research"; reqId: number; buildingId: number; techId: string }
  /** Recruit (or revive) your hero at a Town Hall (or Barracks). */
  | { t: "hero_recruit"; reqId: number; buildingId: number }
  /** Queue one rank of Barracks battle training. */
  | { t: "hero_train"; reqId: number; buildingId: number; track: string }
  /** Let an animal out of your paddock. */
  | { t: "paddock_release"; reqId: number; buildingId: number; unitId: number }
  /** Use one of your hero's abilities, optionally aimed at a unit or a tile. */
  | { t: "ability"; reqId: number; unitId: number; ability: string; target: AbilityTargetMsg }
  | { t: "stats_get"; reqId: number }
  | { t: "overview_get"; reqId: number; cx: number; cy: number; radius: number }
  | { t: "talent_allocate"; reqId: number; talentId: string }
  | { t: "talent_reset"; reqId: number }
  | { t: "combat_optin"; reqId: number; enabled: boolean }
  | { t: "inspect_species"; reqId: number; type: string }
  | { t: "program_save"; reqId: number; unitId: number; source: string; run: boolean }
  | { t: "program_control"; reqId: number; unitId: number; action: ProgramAction }
  | { t: "program_get"; reqId: number; unitId: number }
  | { t: "program_restore"; reqId: number; unitId: number; version: number }
  | { t: "ping"; reqId: number }
  | { t: "units_control"; reqId: number; unitIds: number[]; action: ProgramAction }
  /** Remove some of your units (tamed animals go back to the wild; heroes cannot be dismissed). */
  | { t: "unit_dismiss"; reqId: number; unitIds: number[] }
  /** Remove one of your buildings (construction sites refund half their cost). */
  | { t: "building_demolish"; reqId: number; buildingId: number }
  | { t: "lib_list"; reqId: number }
  | { t: "lib_get"; reqId: number; programId: number; version?: number }
  | { t: "lib_save"; reqId: number; programId?: number; name: string; description: string; unitTypes: string[]; shared: boolean; source: string }
  | { t: "lib_delete"; reqId: number; programId: number }
  | { t: "lib_copy"; reqId: number; programId: number }
  | { t: "lib_assign"; reqId: number; programId: number; version?: number; unitIds?: number[]; unitType?: string; run: boolean }
  | { t: "lib_export"; reqId: number; programId: number; version?: number }
  | { t: "lib_import"; reqId: number; text: string };

export interface LibraryProgramInfo {
  id: number;
  ownerId: number;
  ownerName: string;
  own: boolean;
  name: string;
  description: string;
  unitTypes: string[];
  shared: boolean;
  latestVersion: number;
  updatedAt: string;
}

// ---------------------------------------------------------------- server -> client

export interface UnitOwnView {
  hp: number;
  maxHp: number;
  inventory: ResourceBag;
  capacity: number;
  task: string;
  target: string;
  program: {
    state: string;
    version: number;
    error: { message: string; line: number; col: number } | null;
    note: string;
    library: { id: number; version: number; name: string } | null;
  };
  blocked: string;
  /** Abilities a tamed creature has been trained in. */
  learned: string[];
  /** Stealthy right now: hidden from other players unless they have something close by. */
  hidden: boolean;
  /** Active ability effects. */
  buffs: BuffView[];
  /** Units that can fight: damage per hit after bonuses, and damage reduction (0..1). */
  damage?: number;
  armor?: number;
  /** Heroes: seconds until each ability is ready (0 = ready). */
  abilities?: { id: string; readyIn: number }[];
  /** Tamed animals: the paddock it lives in. */
  pen?: number;
  /** Present only when changed since the last update sent to this client. */
  log?: string[];
  trace?: { t: number; line: number; call: string; result: string; ok: boolean }[];
}

export interface UnitView {
  id: number;
  owner: number;
  type: string;
  x: number;
  y: number;
  facing: number;
  activity: string;
  carrying: boolean;
  /** Health as a whole percentage (public: anyone who can see the unit sees how hurt it is). */
  hpPct: number;
  own?: UnitOwnView;
}

export interface BuildingView {
  id: number;
  owner: number;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  complete: boolean;
  /** Construction progress 0..1. */
  progress: number;
  hp: number;
  maxHp: number;
  own?: {
    /** id: unit type, tech id, "recruit"/"revive" (hero), or "<track>:<rank>" (battle training). */
    queue: { kind: "unit" | "tech" | "hero" | "hero_training"; id: string; progress: number; total: number }[];
    buffs: BuffView[];
    fertility: number;
    /** Storage networks mode: what this storage building holds and how much it can hold. */
    storage?: { stock: ResourceBag; capacity: number };
    /** Production has nowhere to go (no storage with room within supply range). */
    productionBlocked?: boolean;
    /** Paddocks: the animals inside, room, output per minute, and breeding progress per species (0..1). */
    paddock?: {
      animals: { id: number; type: string }[];
      capacity: number;
      perMinute: Partial<ResourceBag>;
      breeding: { type: string; progress: number }[];
    };
  };
}

/** A PvE lair as clients see it. */
export interface LairView {
  id: string;
  kind: string;
  x: number;
  y: number;
  r: number;
  /** "dormant": not yet woken (monsters appear when someone comes near). */
  status: "dormant" | "active" | "cleared";
  clearedBy?: string;
  /** Cleared: seconds until it is reoccupied (null when claimed land keeps it clear). */
  respawnIn?: number | null;
  /** Cleared: seconds left of the clearing player's claim, and whether that player is you. */
  claimIn?: number;
  yourClaim?: boolean;
}

/** [kind, x, y, amount] with amount 0 meaning the node was removed (or an emptied, regrowing bush). */
export type NodeTuple = [string, number, number, number];

/** Minimap: samples per chunk side, and the largest chunk radius one overview request may cover. */
export const OVERVIEW_SAMPLES = 8;
export const OVERVIEW_MAX_RADIUS = 12;

/** Owner id of wild creatures (the server's wildlife player). */
export const NEUTRAL_OWNER = 0;

/** [x, y, tier, looted (0/1)] */
export type RuinTuple = [number, number, "common" | "ancient", number];

export interface PlayerView {
  id: number;
  name: string;
  race: string;
  resources: ResourceBag;
  /** Units counting toward the unit limit (the hero does not). */
  unitCount: number;
  buildingCount: number;
  /** Tiles of territory owned. */
  territory: number;
  /** Chunks explored. */
  explored: number;
  techs: string[];
  unlocks: string[];
  modifiers: { stat: string; pct: number; add: number }[];
  level: number;
  xp: number;
  /** Experience at which the current level started and the next level starts (equal at the cap). */
  xpLevelStart: number;
  xpNextLevel: number;
  talentPoints: number;
  talentPointsSpent: number;
  talents: Record<string, number>;
  discoveries: string[];
  observed: string[];
  /** Combat status (only meaningful when the world has combat enabled). */
  combat: {
    /** The player's own choice. */
    optedIn: boolean;
    /** Attackable right now (opted in, or still leaving PvP). */
    active: boolean;
    /** Seconds until an opt-out takes effect, or null. */
    leavingInSeconds: number | null;
  };
  /** Settlement location (changes if the player's settlement is destroyed and re-founded). */
  spawn: { x: number; y: number };
  /** Current unit and building limits (raised by research, capped by the server). */
  limits: { units: number; buildings: number };
  /** Completed coding lessons. */
  lessons: string[];
  /** Boss trophies won. */
  trophies: string[];
  hero: {
    /** Unit type of this race's hero. */
    type: string;
    /** Living hero unit, or null. */
    unitId: number | null;
    recruited: boolean;
    ranks: Record<string, number>;
    deaths: number;
    /** Cost and seconds of the next recruitment or revival. */
    cost: ResourceBag;
    time: number;
    revive: boolean;
  } | null;
}

export interface OwnerInfo {
  id: number;
  name: string;
  race: string;
  /** Currently attackable in PvP (always false when combat is disabled). */
  pvp: boolean;
}

export interface Notice {
  kind: "info" | "error" | "success";
  text: string;
}

export interface ProgramVersionInfo {
  version: number;
  createdAt: string;
  note: string;
}

export type ServerMessage =
  | {
      t: "welcome";
      v: number;
      playerId: number;
      name: string;
      race: string;
      token: string;
      created: boolean;
      world: { chunkSize: number; tickRate: number; generationVersion: number; visionChunkRadius: number; combatEnabled: boolean; pveEnabled: boolean; contestedZones: boolean; storageMode: "shared" | "networks" };
      spawn: { x: number; y: number };
    }
  | {
      t: "chunk";
      cx: number;
      cy: number;
      tiles: string;
      nodes: NodeTuple[];
      territory: number[];
      ruins: RuinTuple[];
      /** Contested zones overlapping this chunk (only when they are active on the server). */
      zones: { id: string; x: number; y: number; r: number }[];
      /** Lairs whose centre is in this chunk. */
      lairs?: LairView[];
    }
  | { t: "species"; reqId: number; type: string; behaviour: string }
  | { t: "chunk_denied"; chunks: [number, number][]; reason: string }
  | {
      t: "tick";
      tick: number;
      units?: UnitView[];
      buildings?: BuildingView[];
      removedUnits?: number[];
      removedBuildings?: number[];
      nodes?: NodeTuple[];
      /** Territory run-length lists for subscribed chunks whose ownership changed. */
      territory?: { cx: number; cy: number; runs: number[] }[];
      player?: PlayerView;
      owners?: OwnerInfo[];
      /** Set when this player gained a level since the last update. */
      levelUp?: number;
      ruins?: RuinTuple[];
      /** Messages for this player: units lost, buildings destroyed, PvP status changes. */
      notices?: Notice[];
      /** Lairs (in subscribed chunks) whose state changed. */
      lairs?: LairView[];
    }
  | { t: "ack"; reqId: number; message?: string; id?: number }
  | { t: "error"; reqId?: number; code: string; message: string }
  | { t: "program"; reqId: number; unitId: number; source: string; version: number; state: string; versions: ProgramVersionInfo[] }
  | { t: "pong"; reqId: number; tick: number }
  | {
      t: "stats";
      reqId: number;
      leaderboard: { id: number; name: string; race: string; territory: number }[];
      history: { buildingId: number; buildingType: string; seconds: number; tiles: number }[];
      territory: number;
      explored: number;
    }
  | {
      t: "overview";
      reqId: number;
      /** [cx, cy, samples] for explored chunks only; see World.overview for the sample encoding. */
      chunks: [number, number, string][];
      buildings: [number, number][];
      units: [number, number][];
      /** Contested zones [x, y, radius] touching chunks the player has explored. */
      zones: [number, number, number][];
    }
  | { t: "library"; reqId: number; programs: LibraryProgramInfo[] }
  | { t: "library_program"; reqId: number; program: LibraryProgramInfo; version: number; source: string; versions: ProgramVersionInfo[] }
  | { t: "library_export"; reqId: number; filename: string; text: string }
  | { t: "kicked"; reason: string };

// ---------------------------------------------------------------- validation

export const LIMITS = {
  maxNameLength: 20,
  minNameLength: 3,
  maxSourceLength: 16_000,
  maxSubscribe: 64,
  maxCoordinate: 1_000_000,
  maxChunkCoordinate: 100_000,
  maxId: 2 ** 31 - 1,
  maxBatchUnits: 100,
  maxLibraryName: 40,
  maxLibraryDescription: 500,
  maxImportBytes: 48_000,
} as const;

export const NAME_PATTERN = /^[A-Za-z0-9_\- ]+$/;

type Parsed = { ok: true; msg: ClientMessage } | { ok: false; error: string; reqId?: number };

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}
function isStr(v: unknown, maxLen: number): v is string {
  return typeof v === "string" && v.length <= maxLen;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intList(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: number[] = [];
  for (const x of v) {
    if (!isInt(x, 1, LIMITS.maxId)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/** Strict validation of an untrusted client frame. Unknown fields are ignored; wrong types are rejected. */
export function parseClientMessage(raw: string): Parsed {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Malformed JSON" };
  }
  if (!isObj(m) || typeof m.t !== "string") return { ok: false, error: "Message must be an object with a 't' field" };
  const reqId = isInt(m.reqId, 1, LIMITS.maxId) ? m.reqId : undefined;
  const bad = (why: string): Parsed => (reqId === undefined ? { ok: false, error: why } : { ok: false, error: why, reqId });
  const needReq = (): boolean => reqId !== undefined;
  const C = LIMITS.maxCoordinate;
  switch (m.t) {
    case "hello": {
      if (!isInt(m.v, 0, 1000)) return bad("hello.v must be the protocol version");
      if (!isStr(m.name, 64)) return bad("hello.name must be a string");
      const msg: ClientMessage = { t: "hello", v: m.v, name: m.name };
      if (m.token !== undefined) {
        if (!isStr(m.token, 128)) return bad("hello.token must be a string");
        msg.token = m.token;
      }
      if (m.race !== undefined) {
        if (!isStr(m.race, 32)) return bad("hello.race must be a string");
        msg.race = m.race;
      }
      return { ok: true, msg };
    }
    case "subscribe": {
      if (!Array.isArray(m.chunks) || m.chunks.length > LIMITS.maxSubscribe) return bad(`subscribe.chunks must be an array of at most ${LIMITS.maxSubscribe} [cx, cy] pairs`);
      const chunks: [number, number][] = [];
      for (const c of m.chunks) {
        if (!Array.isArray(c) || c.length !== 2 || !isInt(c[0], -LIMITS.maxChunkCoordinate, LIMITS.maxChunkCoordinate) || !isInt(c[1], -LIMITS.maxChunkCoordinate, LIMITS.maxChunkCoordinate)) {
          return bad("subscribe.chunks entries must be [cx, cy] integer pairs within range");
        }
        chunks.push([c[0], c[1]]);
      }
      return { ok: true, msg: { t: "subscribe", chunks } };
    }
    case "unit_cmd": {
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.unitId, 1, LIMITS.maxId)) return bad("unitId must be a positive integer");
      const c = m.cmd;
      if (!isObj(c) || typeof c.kind !== "string") return bad("cmd must be an object with 'kind'");
      let cmd: UnitCommand;
      switch (c.kind) {
        case "move":
        case "gather":
        case "investigate":
          if (!isInt(c.x, -C, C) || !isInt(c.y, -C, C)) return bad("cmd.x and cmd.y must be integers within range");
          cmd = { kind: c.kind, x: c.x, y: c.y };
          break;
        case "build":
          if (!isInt(c.buildingId, 1, LIMITS.maxId)) return bad("cmd.buildingId must be a positive integer");
          cmd = { kind: "build", buildingId: c.buildingId };
          break;
        case "deposit":
        case "stop":
          cmd = { kind: c.kind };
          break;
        case "observe":
        case "tame":
        case "attack":
          if (!isInt(c.targetId, 1, LIMITS.maxId)) return bad("cmd.targetId must be a positive integer");
          cmd = { kind: c.kind, targetId: c.targetId };
          break;
        case "attack_building":
        case "repair":
        case "pen":
          if (!isInt(c.buildingId, 1, LIMITS.maxId)) return bad("cmd.buildingId must be a positive integer");
          cmd = { kind: c.kind, buildingId: c.buildingId };
          break;
        default:
          return bad(`Unsupported unit command '${String(c.kind)}'`);
      }
      return { ok: true, msg: { t: "unit_cmd", reqId: reqId as number, unitId: m.unitId, cmd } };
    }
    case "place_building":
      if (!needReq()) return bad("reqId required");
      if (!isStr(m.type, 32) || !isInt(m.x, -C, C) || !isInt(m.y, -C, C)) return bad("place_building needs type, x, y");
      return { ok: true, msg: { t: "place_building", reqId: reqId as number, type: m.type, x: m.x, y: m.y } };
    case "research":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.buildingId, 1, LIMITS.maxId) || !isStr(m.techId, 40)) return bad("research needs buildingId and techId");
      return { ok: true, msg: { t: "research", reqId: reqId as number, buildingId: m.buildingId, techId: m.techId } };
    case "overview_get":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.cx, -C, C) || !isInt(m.cy, -C, C) || !isInt(m.radius, 1, OVERVIEW_MAX_RADIUS)) return bad(`overview_get needs chunk cx, cy and radius 1-${OVERVIEW_MAX_RADIUS}`);
      return { ok: true, msg: { t: "overview_get", reqId: reqId as number, cx: m.cx, cy: m.cy, radius: m.radius } };
    case "stats_get":
      if (!needReq()) return bad("reqId required");
      return { ok: true, msg: { t: "stats_get", reqId: reqId as number } };
    case "talent_allocate":
      if (!needReq()) return bad("reqId required");
      if (!isStr(m.talentId, 40)) return bad("talentId must be a string");
      return { ok: true, msg: { t: "talent_allocate", reqId: reqId as number, talentId: m.talentId } };
    case "talent_reset":
      if (!needReq()) return bad("reqId required");
      return { ok: true, msg: { t: "talent_reset", reqId: reqId as number } };
    case "combat_optin":
      if (!needReq()) return bad("reqId required");
      if (typeof m.enabled !== "boolean") return bad("combat_optin needs enabled: true or false");
      return { ok: true, msg: { t: "combat_optin", reqId: reqId as number, enabled: m.enabled } };
    case "inspect_species":
      if (!needReq()) return bad("reqId required");
      if (!isStr(m.type, 32)) return bad("type must be a string");
      return { ok: true, msg: { t: "inspect_species", reqId: reqId as number, type: m.type } };
    case "hero_recruit":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.buildingId, 1, LIMITS.maxId)) return bad("hero_recruit needs buildingId");
      return { ok: true, msg: { t: "hero_recruit", reqId: reqId as number, buildingId: m.buildingId } };
    case "paddock_release":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.buildingId, 1, LIMITS.maxId) || !isInt(m.unitId, 1, LIMITS.maxId)) return bad("paddock_release needs buildingId and unitId");
      return { ok: true, msg: { t: "paddock_release", reqId: reqId as number, buildingId: m.buildingId, unitId: m.unitId } };
    case "hero_train":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.buildingId, 1, LIMITS.maxId) || !isStr(m.track, 32)) return bad("hero_train needs buildingId and track");
      return { ok: true, msg: { t: "hero_train", reqId: reqId as number, buildingId: m.buildingId, track: m.track } };
    case "ability": {
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.unitId, 1, LIMITS.maxId) || !isStr(m.ability, 32)) return bad("ability needs unitId and ability");
      let target: AbilityTargetMsg = null;
      const t = m.target;
      if (t !== undefined && t !== null) {
        if (!isObj(t)) return bad("target must be {unitId} or {x, y}");
        if (t.unitId !== undefined) {
          if (!isInt(t.unitId, 1, LIMITS.maxId)) return bad("target.unitId must be a positive integer");
          target = { unitId: t.unitId };
        } else {
          if (!isInt(t.x, -C, C) || !isInt(t.y, -C, C)) return bad("target needs whole-number x and y");
          target = { x: t.x, y: t.y };
        }
      }
      return { ok: true, msg: { t: "ability", reqId: reqId as number, unitId: m.unitId, ability: m.ability, target } };
    }
    case "train":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.buildingId, 1, LIMITS.maxId) || !isStr(m.unitType, 32)) return bad("train needs buildingId and unitType");
      return { ok: true, msg: { t: "train", reqId: reqId as number, buildingId: m.buildingId, unitType: m.unitType } };
    case "program_save":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.unitId, 1, LIMITS.maxId)) return bad("unitId must be a positive integer");
      if (!isStr(m.source, LIMITS.maxSourceLength)) return bad(`source must be a string of at most ${LIMITS.maxSourceLength} characters`);
      return { ok: true, msg: { t: "program_save", reqId: reqId as number, unitId: m.unitId, source: m.source, run: m.run === true } };
    case "program_control":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.unitId, 1, LIMITS.maxId)) return bad("unitId must be a positive integer");
      if (m.action !== "run" && m.action !== "pause" && m.action !== "resume" && m.action !== "stop") return bad("action must be run, pause, resume or stop");
      return { ok: true, msg: { t: "program_control", reqId: reqId as number, unitId: m.unitId, action: m.action } };
    case "program_get":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.unitId, 1, LIMITS.maxId)) return bad("unitId must be a positive integer");
      return { ok: true, msg: { t: "program_get", reqId: reqId as number, unitId: m.unitId } };
    case "program_restore":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.unitId, 1, LIMITS.maxId) || !isInt(m.version, 1, LIMITS.maxId)) return bad("program_restore needs unitId and version");
      return { ok: true, msg: { t: "program_restore", reqId: reqId as number, unitId: m.unitId, version: m.version } };
    case "ping":
      if (!needReq()) return bad("reqId required");
      return { ok: true, msg: { t: "ping", reqId: reqId as number } };
    case "units_control": {
      if (!needReq()) return bad("reqId required");
      const ids = intList(m.unitIds, LIMITS.maxBatchUnits);
      if (!ids) return bad(`unitIds must be a list of at most ${LIMITS.maxBatchUnits} unit ids`);
      if (m.action !== "run" && m.action !== "pause" && m.action !== "resume" && m.action !== "stop") return bad("action must be run, pause, resume or stop");
      return { ok: true, msg: { t: "units_control", reqId: reqId as number, unitIds: ids, action: m.action } };
    }
    case "unit_dismiss": {
      if (!needReq()) return bad("reqId required");
      const ids = intList(m.unitIds, LIMITS.maxBatchUnits);
      if (!ids || ids.length === 0) return bad(`unitIds must be a list of 1 to ${LIMITS.maxBatchUnits} unit ids`);
      return { ok: true, msg: { t: "unit_dismiss", reqId: reqId as number, unitIds: ids } };
    }
    case "building_demolish":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.buildingId, 1, LIMITS.maxId)) return bad("building_demolish needs buildingId");
      return { ok: true, msg: { t: "building_demolish", reqId: reqId as number, buildingId: m.buildingId } };
    case "lib_list":
      if (!needReq()) return bad("reqId required");
      return { ok: true, msg: { t: "lib_list", reqId: reqId as number } };
    case "lib_get":
    case "lib_export": {
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.programId, 1, LIMITS.maxId)) return bad("programId must be a positive integer");
      if (m.version !== undefined && !isInt(m.version, 1, LIMITS.maxId)) return bad("version must be a positive integer");
      const msg = { t: m.t, reqId: reqId as number, programId: m.programId } as { t: "lib_get" | "lib_export"; reqId: number; programId: number; version?: number };
      if (m.version !== undefined) msg.version = m.version;
      return { ok: true, msg };
    }
    case "lib_delete":
    case "lib_copy":
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.programId, 1, LIMITS.maxId)) return bad("programId must be a positive integer");
      return { ok: true, msg: { t: m.t, reqId: reqId as number, programId: m.programId } };
    case "lib_save": {
      if (!needReq()) return bad("reqId required");
      if (m.programId !== undefined && !isInt(m.programId, 1, LIMITS.maxId)) return bad("programId must be a positive integer");
      if (!isStr(m.name, LIMITS.maxLibraryName) || !isStr(m.description, LIMITS.maxLibraryDescription)) return bad("name and description must be strings within the size limits");
      if (!Array.isArray(m.unitTypes) || m.unitTypes.length > 10 || !m.unitTypes.every((t) => isStr(t, 32))) return bad("unitTypes must be a list of unit type names");
      if (typeof m.shared !== "boolean") return bad("shared must be true or false");
      if (!isStr(m.source, LIMITS.maxSourceLength)) return bad(`source must be a string of at most ${LIMITS.maxSourceLength} characters`);
      const msg: ClientMessage = { t: "lib_save", reqId: reqId as number, name: m.name, description: m.description, unitTypes: m.unitTypes as string[], shared: m.shared, source: m.source };
      if (m.programId !== undefined) msg.programId = m.programId;
      return { ok: true, msg };
    }
    case "lib_assign": {
      if (!needReq()) return bad("reqId required");
      if (!isInt(m.programId, 1, LIMITS.maxId)) return bad("programId must be a positive integer");
      if (m.version !== undefined && !isInt(m.version, 1, LIMITS.maxId)) return bad("version must be a positive integer");
      const ids = m.unitIds === undefined ? undefined : intList(m.unitIds, LIMITS.maxBatchUnits);
      if (ids === null) return bad(`unitIds must be a list of at most ${LIMITS.maxBatchUnits} unit ids`);
      if (m.unitType !== undefined && !isStr(m.unitType, 32)) return bad("unitType must be a string");
      if (ids === undefined && m.unitType === undefined) return bad("lib_assign needs unitIds or unitType");
      const msg: ClientMessage = { t: "lib_assign", reqId: reqId as number, programId: m.programId, run: m.run === true };
      if (m.version !== undefined) msg.version = m.version;
      if (ids !== undefined) msg.unitIds = ids;
      if (m.unitType !== undefined) msg.unitType = m.unitType as string;
      return { ok: true, msg };
    }
    case "lib_import":
      if (!needReq()) return bad("reqId required");
      if (!isStr(m.text, LIMITS.maxImportBytes)) return bad(`Import text must be at most ${LIMITS.maxImportBytes} characters`);
      return { ok: true, msg: { t: "lib_import", reqId: reqId as number, text: m.text } };
    default:
      return bad(`Unknown message type '${m.t}'`);
  }
}

/** Encode chunk tiles (values 0-9) as a compact digit string. */
export function encodeTiles(tiles: Uint8Array): string {
  let s = "";
  for (const t of tiles) s += String.fromCharCode(48 + t);
  return s;
}

/** Decode a territory run-length list ([owner, count, ...]) into per-tile owner ids. */
export function decodeTerritory(runs: number[], size: number): Int32Array {
  const out = new Int32Array(size * size);
  let i = 0;
  for (let k = 0; k + 1 < runs.length; k += 2) {
    const n = Math.max(0, Math.min(runs[k + 1] as number, out.length - i));
    out.fill(runs[k] as number, i, i + n);
    i += n;
  }
  return out;
}

export function decodeTiles(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) - 48;
  return out;
}
