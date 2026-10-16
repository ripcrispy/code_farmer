import type { HeroState } from "../../sim/types.ts";
/**
 * Persistence interface. The simulation and network layers depend only on this
 * interface; SqliteStore is the initial implementation. Another database can be
 * introduced by implementing GameStore.
 */
import type { ResourceBag } from "../../shared/defs/resources.ts";
import type { PaddockState, ProgramRunState, TrainOrder } from "../../sim/types.ts";
import type { NodeMod } from "../../sim/chunks.ts";

export interface WorldMetaRecord {
  seed: string;
  generationVersion: number;
  chunkSize: number;
  resourceDensity: number;
  createdAt: string;
  /** Next entity id to allocate. */
  nextId: number;
  tick: number;
}

export interface AccountRecord {
  id: number;
  name: string;
  tokenHash: string;
  createdAt: string;
}

export interface PlayerRecord {
  id: number;
  race: string;
  resources: ResourceBag;
  spawnX: number;
  spawnY: number;
  techs: string[];
  xp: number;
  talents: Record<string, number>;
  discoveries: string[];
  observed: string[];
  pvp: boolean;
  /** Tick until which an opted-out player stays attackable, or null. */
  pvpUntil: number | null;
  hero: HeroState;
  lessons: string[];
  trophies: string[];
}

export interface UnitRecord {
  id: number;
  ownerId: number;
  type: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  inventory: ResourceBag;
  programSource: string;
  programVersion: number;
  programState: ProgramRunState;
  programError: { message: string; line: number; col: number } | null;
  /** Library program the unit's code came from, if any. */
  programLibrary: { id: number; version: number; name: string } | null;
  learned: string[];
  home: { x: number; y: number } | null;
  /** Paddock the animal lives in. */
  pen: number | null;
}

export interface BuildingRecord {
  id: number;
  ownerId: number;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  complete: boolean;
  progress: number;
  queue: TrainOrder[];
  prodAcc: number;
  fertility: number;
  completedTick: number | null;
  /** Resources held by this storage building (storage networks mode). */
  stock: ResourceBag;
  /** Paddocks: production and breeding progress. */
  pen: PaddockState | null;
}

export interface LairRecord {
  id: string;
  status: "active" | "cleared";
  clearedBy: number | null;
  clearedTick: number | null;
  respawnTick: number | null;
  claimUntil: number | null;
}

export interface ChunkModRecord {
  cx: number;
  cy: number;
  data: Record<string, NodeMod>;
}

export interface ExploredRecord {
  playerId: number;
  cx: number;
  cy: number;
  tick: number;
}

export interface TerritoryEventRecord {
  playerId: number;
  buildingId: number;
  tick: number;
  tiles: number;
}

export interface AuditRecord {
  tick: number;
  playerId: number;
  action: string;
  detail: string;
}

export interface SaveBatch {
  meta: { nextId: number; tick: number };
  players: PlayerRecord[];
  units: UnitRecord[];
  buildings: BuildingRecord[];
  removedUnits: number[];
  removedBuildings: number[];
  chunkMods: ChunkModRecord[];
  audit: AuditRecord[];
  explored: ExploredRecord[];
  territoryEvents: TerritoryEventRecord[];
  populated: { cx: number; cy: number }[];
  looted: { x: number; y: number; playerId: number; tick: number }[];
  lairs: LairRecord[];
}

export interface LoadedWorld {
  accounts: AccountRecord[];
  players: PlayerRecord[];
  units: UnitRecord[];
  buildings: BuildingRecord[];
  chunkMods: ChunkModRecord[];
  explored: ExploredRecord[];
  populated: { cx: number; cy: number }[];
  looted: { x: number; y: number }[];
  lairs: LairRecord[];
}

export interface ProgramVersionRecord {
  unitId: number;
  version: number;
  source: string;
  languageVersion: number;
  createdAt: string;
  note: string;
}

export interface LibraryProgramRecord {
  id: number;
  ownerId: number;
  ownerName: string;
  name: string;
  description: string;
  unitTypes: string[];
  shared: boolean;
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryVersionRecord {
  programId: number;
  version: number;
  source: string;
  languageVersion: number;
  note: string;
  createdAt: string;
}

export interface LibraryMeta {
  name: string;
  description: string;
  unitTypes: string[];
  shared: boolean;
}

export interface GameStore {
  /** Apply pending migrations. Returns the list of applied migration versions. */
  migrate(): number[];
  schemaVersion(): number;
  getWorldMeta(): WorldMetaRecord | null;
  createWorldMeta(meta: WorldMetaRecord): void;
  loadWorld(): LoadedWorld;
  /** Persist a batch of changes atomically (single transaction). */
  saveBatch(batch: SaveBatch): void;
  findAccountByTokenHash(tokenHash: string): AccountRecord | null;
  findAccountByName(name: string): AccountRecord | null;
  createAccount(name: string, tokenHash: string): AccountRecord;
  touchLogin(accountId: number): void;
  /** Append a new program version and return its number. */
  addProgramVersion(unitId: number, source: string, languageVersion: number, note: string): number;
  getProgramVersion(unitId: number, version: number): ProgramVersionRecord | null;
  listProgramVersions(unitId: number, limit: number): ProgramVersionRecord[];
  /** Own programs plus programs other players have shared. */
  libList(viewerId: number): LibraryProgramRecord[];
  libGet(programId: number): LibraryProgramRecord | null;
  libFindByName(ownerId: number, name: string): LibraryProgramRecord | null;
  libCount(ownerId: number): number;
  libCreate(ownerId: number, meta: LibraryMeta, source: string, languageVersion: number, note: string): LibraryProgramRecord;
  /** Update metadata and, when source differs from the latest version, append a version. Returns the latest version number. */
  libUpdate(programId: number, meta: LibraryMeta, source: string, languageVersion: number, note: string): number;
  libVersions(programId: number, limit: number): Omit<LibraryVersionRecord, "source">[];
  libGetVersion(programId: number, version: number): LibraryVersionRecord | null;
  libDelete(programId: number): void;
  /** Most recent territory expansions of a player (newest first). */
  territoryHistory(playerId: number, limit: number): TerritoryEventRecord[];
  close(): void;
}
