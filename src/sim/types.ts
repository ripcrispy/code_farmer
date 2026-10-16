import type { ResourceBag, ResourceType } from "../shared/defs/resources.ts";
import type { RuntimeErrorInfo, VM } from "../script/vm.ts";
import type { Value } from "../script/values.ts";
import type { Rect } from "./pathfinding.ts";

export interface PlayerState {
  id: number;
  name: string;
  race: string;
  resources: ResourceBag;
  spawnX: number;
  spawnY: number;
  /** Completed research. */
  techs: string[];
  /** Chunks (keys "cx,cy") any of this player's units has entered. */
  explored: Set<string>;
  /** Total experience (level and talent points are derived from it). */
  xp: number;
  /** Allocated talent ranks by talent id. */
  talents: Record<string, number>;
  /** Discovery ids known (code fragments and hidden discoveries). */
  discoveries: string[];
  /** Creature species whose behaviour this player has observed (inspection tier 2). */
  observed: string[];
  /** PvP opt-in as the player last chose it. */
  pvp: boolean;
  /**
   * After opting out, the player stays attackable until this tick (extended by any
   * fighting in the meantime). null when not leaving PvP.
   */
  pvpUntil: number | null;
  /** The player's hero (one per player). */
  hero: HeroState;
  /** Completed coding lessons (ids from lessons.ts). */
  lessons: string[];
  /** Boss trophies won (ids from lairs.ts; each a permanent bonus). */
  trophies: string[];
}

/** Persistent hero record, kept on the player so training survives the hero's death. */
export interface HeroState {
  /** The living hero unit, or null (never recruited, or fallen). */
  unitId: number | null;
  /** Ever recruited (later recruitment is a revival). */
  recruited: boolean;
  /** Barracks battle training ranks by track id. */
  ranks: Record<string, number>;
  deaths: number;
}

export function newHeroState(): HeroState {
  return { unitId: null, recruited: false, ranks: {}, deaths: 0 };
}

/** A timed modifier from a hero ability. */
export interface Buff {
  stat: string;
  pct: number;
  until: number;
  /** Ability that applied it (for display). */
  source: string;
}

/** Owner id of wild creatures. */
export const NEUTRAL = 0;

export type ProgramRunState = "running" | "paused" | "stopped" | "error" | "finished";

export interface UnitProgram {
  source: string;
  /** Saved version number of `source` (program_versions table). */
  version: number;
  state: ProgramRunState;
  error: RuntimeErrorInfo | null;
  /** Human-readable reason for the last state change (e.g. "Stopped by manual command"). */
  note: string;
  /** Library program this code was assigned from (null when edited directly). */
  library: { id: number; version: number; name: string } | null;
}

/** What a unit is doing. Movement is a sub-step shared by tasks that need to approach something. */
export type Task =
  | { kind: "idle" }
  | { kind: "move"; goal: Rect; range: number; label: string }
  | { kind: "gather"; nodeX: number; nodeY: number; resource: ResourceType; gathered: number; acc: number; rate: number }
  /** `explicit`: the program named the storage (deposit(storage)), so do not switch to another one. */
  | { kind: "deposit"; buildingId: number | null; explicit?: boolean }
  | { kind: "withdraw"; buildingId: number | null; resource: ResourceType; amount: number; explicit?: boolean }
  | { kind: "build"; buildingId: number; acc: number }
  | { kind: "wait"; until: number }
  | { kind: "observe"; targetId: number; progress: number; sawHidden: boolean }
  | { kind: "investigate"; x: number; y: number; progress: number }
  | { kind: "tame"; targetId: number }
  | { kind: "train_creature"; targetId: number; ability: string; progress: number }
  | { kind: "follow"; targetId: number; until: number }
  | { kind: "guard"; x: number; y: number; until: number }
  | { kind: "attack"; targetId: number; building: boolean; nextHit: number }
  | { kind: "repair"; buildingId: number; hpAcc: number; costAcc: Partial<Record<ResourceType, number>> }
  /** A tamed animal walking into one of its owner's paddocks. */
  | { kind: "pen"; buildingId: number };

export type TaskSource = "script" | "manual";

export interface TaskResult {
  ok: boolean;
  /** Value returned to the script. */
  value: Value;
  reason: string;
}

export interface TraceEntry {
  tick: number;
  line: number;
  call: string;
  /** Empty while the action is in progress. */
  result: string;
  ok: boolean;
}

export type Activity = "idle" | "walking" | "carrying" | "harvesting" | "mining" | "foraging" | "building" | "waiting" | "observing" | "investigating" | "taming" | "guarding" | "attacking" | "repairing";

export interface UnitState {
  id: number;
  owner: number;
  type: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  inventory: ResourceBag;
  /** Abilities a tamed creature has been trained in. */
  learned: string[];
  /** Home position (creatures wander around it); null for ordinary units. */
  home: { x: number; y: number } | null;
  /** Paddock (building id) this tamed animal lives in, or null. Penned animals do not run programs. */
  pen: number | null;
  task: Task;
  taskSource: TaskSource;
  program: UnitProgram;
  /** Last failure explanation shown in the UI (cleared on the next successful task). */
  blocked: string;
  // ---- transient (not persisted) ----
  vm: VM | null;
  path: { x: number; y: number }[] | null;
  moveProgress: number;
  log: string[];
  exploreCount: number;
  /** Node ids recently found unreachable -> tick until which they are ignored by find_nearest. */
  avoid: Map<string, number>;
  activity: Activity;
  /** Set when a script action resolves without a task (failed to start, or instant actions such as place()); reported next tick. */
  pendingResult: TaskResult | null;
  /** Name of the script action currently being performed. */
  scriptAction: string | null;
  /** Recent script actions and their outcomes (automation diagnostics). */
  trace: TraceEntry[];
  /** Incremented when log or trace change (sent to the owner only when it changes). */
  detailRev: number;
  /** Recent failed path search, to avoid repeating an expensive failing search every tick. */
  pathFail: { key: string; until: number; reason: string } | null;
  /** Goal key whose normal-radius search already failed (go straight to a wide search). */
  pathNarrowFailed: string | null;
  /** Incremented whenever client-visible state changes. */
  rev: number;
  /** Most recent hit taken (combat): attacker unit, its owner and the tick. */
  lastHit: { by: number; owner: number; tick: number } | null;
  /** Wild creatures only: owners whose units attacked it recently -> tick (they may be fought back). */
  provokedBy: Map<number, number> | null;
  /** Attacker to report to the program's on_attacked handler on the next update, if any. */
  attackedBy: number | null;
  /** Tick of the last on_attacked call (at most one every 2 seconds). */
  lastAttackEvent: number;
  /** Stealthy units are visible to everyone until this tick after attacking or being hit. */
  revealedUntil: number;
  /** Stealth state at the last visibility check (a change is sent to the owner). */
  wasStealthy: boolean;
  /** Active ability effects (transient: they end on restart). */
  buffs: Buff[];
  /** Heroes: tick at which each ability is ready again (transient). */
  cooldowns: Record<string, number>;
}

/** A queued unit or research order at a building. Progress is in seconds. */
export type TrainOrder =
  | { kind: "unit"; unitType: string; progress: number }
  | { kind: "tech"; techId: string; progress: number }
  /** Recruit (first time) or revive the player's hero. */
  | { kind: "hero"; revive: boolean; progress: number; time: number }
  /** Barracks battle training: one rank of a track. */
  | { kind: "hero_training"; track: string; rank: number; progress: number; time: number };

export interface BuildingState {
  id: number;
  owner: number;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  complete: boolean;
  /** Construction points accumulated. */
  progress: number;
  queue: TrainOrder[];
  /** Fractional production carried between ticks. */
  prodAcc: number;
  /** Fraction of fertile tiles under the footprint (farms). */
  fertility: number;
  /** Tick at which construction finished (orders territory claims); null if unknown/incomplete. */
  completedTick: number | null;
  /** Resources held in this storage building (storage networks mode only; always empty in shared mode). */
  stock: ResourceBag;
  /** Production has nowhere to go (no storage with room within supply range). */
  prodBlocked: boolean;
  /** Active ability effects (training/research speed; transient). */
  buffs: Buff[];
  /** Paddocks only: production and breeding progress. */
  pen: PaddockState | null;
  rev: number;
}

/** Progress of a paddock: fractional production carried between ticks, and breeding per species (0..1). */
export interface PaddockState {
  acc: Partial<Record<ResourceType, number>>;
  breed: Record<string, number>;
}

export type CommandResult<T = undefined> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value };
}
export function fail<T = never>(code: string, message: string): CommandResult<T> {
  return { ok: false, code, message };
}
