import type { ResourceBag } from "../../shared/defs/resources.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";
import type {
  AccountRecord,
  ExploredRecord,
  TerritoryEventRecord,
  LibraryMeta,
  LibraryProgramRecord,
  LibraryVersionRecord,
  BuildingRecord,
  ChunkModRecord,
  GameStore,
  LairRecord,
  LoadedWorld,
  PlayerRecord,
  ProgramVersionRecord,
  SaveBatch,
  UnitRecord,
  WorldMetaRecord,
} from "./store.ts";

/**
 * SQLite implementation of GameStore using Node's built-in `node:sqlite` module
 * (no native add-on to compile). All statements are parameterised.
 */
export class SqliteStore implements GameStore {
  private readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  migrate(): number[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const done = new Set((this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
      });
      applied.push(m.version);
    }
    return applied;
  }

  schemaVersion(): number {
    const r = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
    return r?.v ?? 0;
  }

  getWorldMeta(): WorldMetaRecord | null {
    const rows = this.q("SELECT key, value FROM world_meta").all() as { key: string; value: string }[];
    if (rows.length === 0) return null;
    const m = new Map(rows.map((r) => [r.key, r.value]));
    const need = (k: string): string => {
      const v = m.get(k);
      if (v === undefined) throw new Error(`world_meta is missing '${k}' - the database may be corrupt`);
      return v;
    };
    return {
      seed: need("seed"),
      generationVersion: Number(need("generation_version")),
      chunkSize: Number(need("chunk_size")),
      resourceDensity: Number(need("resource_density")),
      createdAt: need("created_at"),
      nextId: Number(m.get("next_id") ?? "1"),
      tick: Number(m.get("tick") ?? "0"),
    };
  }

  createWorldMeta(meta: WorldMetaRecord): void {
    this.tx(() => {
      const existing = this.q("SELECT COUNT(*) AS n FROM world_meta").get() as { n: number };
      if (existing.n > 0) throw new Error("World metadata already exists; refusing to overwrite an existing world");
      const ins = this.q("INSERT INTO world_meta (key, value) VALUES (?, ?)");
      ins.run("seed", meta.seed);
      ins.run("generation_version", String(meta.generationVersion));
      ins.run("chunk_size", String(meta.chunkSize));
      ins.run("resource_density", String(meta.resourceDensity));
      ins.run("created_at", meta.createdAt);
      ins.run("next_id", String(meta.nextId));
      ins.run("tick", String(meta.tick));
    });
  }

  loadWorld(): LoadedWorld {
    const accounts = (this.q("SELECT id, name, token_hash, created_at FROM accounts").all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      name: r.name as string,
      tokenHash: r.token_hash as string,
      createdAt: r.created_at as string,
    }));
    const players: PlayerRecord[] = (this.q("SELECT * FROM players WHERE id <> 0").all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      race: r.race as string,
      resources: { wood: r.wood as number, stone: r.stone as number, gold: r.gold as number, food: r.food as number },
      spawnX: r.spawn_x as number,
      spawnY: r.spawn_y as number,
      techs: JSON.parse((r.techs as string | null) ?? "[]") as string[],
      xp: (r.xp as number | null) ?? 0,
      talents: JSON.parse((r.talents as string | null) ?? "{}") as Record<string, number>,
      discoveries: JSON.parse((r.discoveries as string | null) ?? "[]") as string[],
      observed: JSON.parse((r.observed as string | null) ?? "[]") as string[],
      pvp: r.pvp === 1,
      pvpUntil: (r.pvp_until as number | null) ?? null,
      hero: JSON.parse((r.hero as string | null) ?? '{"unitId":null,"recruited":false,"ranks":{},"deaths":0}') as PlayerRecord["hero"],
      lessons: JSON.parse((r.lessons as string | null) ?? "[]") as string[],
      trophies: JSON.parse((r.trophies as string | null) ?? "[]") as string[],
    }));
    const units: UnitRecord[] = (this.q("SELECT * FROM units ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      ownerId: r.owner_id as number,
      type: r.type as string,
      x: r.x as number,
      y: r.y as number,
      facing: r.facing as number,
      hp: r.hp as number,
      inventory: JSON.parse(r.inventory as string),
      programSource: r.program_source as string,
      programVersion: r.program_version as number,
      programState: r.program_state as UnitRecord["programState"],
      programError: r.program_error ? JSON.parse(r.program_error as string) : null,
      programLibrary: r.program_library ? JSON.parse(r.program_library as string) : null,
      learned: JSON.parse((r.learned as string | null) ?? "[]") as string[],
      home: r.home_x === null || r.home_x === undefined ? null : { x: r.home_x as number, y: r.home_y as number },
      pen: (r.pen_id as number | null | undefined) ?? null,
    }));
    const buildings: BuildingRecord[] = (this.q("SELECT * FROM buildings ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      ownerId: r.owner_id as number,
      type: r.type as string,
      x: r.x as number,
      y: r.y as number,
      w: r.w as number,
      h: r.h as number,
      hp: r.hp as number,
      complete: (r.complete as number) === 1,
      progress: r.progress as number,
      queue: JSON.parse(r.queue as string),
      prodAcc: r.prod_acc as number,
      fertility: r.fertility as number,
      completedTick: (r.completed_tick as number | null) ?? null,
      stock: { wood: 0, stone: 0, gold: 0, food: 0, ...(JSON.parse((r.stock as string | null) ?? "{}") as Partial<ResourceBag>) },
      pen: r.pen ? (JSON.parse(r.pen as string) as BuildingRecord["pen"]) : null,
    }));
    const chunkMods: ChunkModRecord[] = (this.q("SELECT cx, cy, data FROM chunk_mods").all() as Record<string, unknown>[]).map((r) => ({
      cx: r.cx as number,
      cy: r.cy as number,
      data: JSON.parse(r.data as string),
    }));
    const explored: ExploredRecord[] = (this.q("SELECT player_id, cx, cy, tick FROM explored_chunks").all() as Record<string, unknown>[]).map((r) => ({
      playerId: r.player_id as number,
      cx: r.cx as number,
      cy: r.cy as number,
      tick: r.tick as number,
    }));
    const populated = (this.q("SELECT cx, cy FROM populated_chunks").all() as Record<string, unknown>[]).map((r) => ({ cx: r.cx as number, cy: r.cy as number }));
    const looted = (this.q("SELECT x, y FROM ruins_looted").all() as Record<string, unknown>[]).map((r) => ({ x: r.x as number, y: r.y as number }));
    const lairs: LairRecord[] = (this.q("SELECT * FROM lairs").all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      status: r.status as LairRecord["status"],
      clearedBy: (r.cleared_by as number | null) ?? null,
      clearedTick: (r.cleared_tick as number | null) ?? null,
      respawnTick: (r.respawn_tick as number | null) ?? null,
      claimUntil: (r.claim_until as number | null) ?? null,
    }));
    return { accounts: accounts.filter((a) => a.id !== 0), players, units, buildings, chunkMods, explored, populated, looted, lairs };
  }

  saveBatch(b: SaveBatch): void {
    const now = new Date().toISOString();
    this.tx(() => {
      const meta = this.q("INSERT INTO world_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      meta.run("next_id", String(b.meta.nextId));
      meta.run("tick", String(b.meta.tick));
      const pl = this.q(
        `INSERT INTO players (id, race, wood, stone, gold, food, spawn_x, spawn_y, techs, xp, talents, discoveries, observed, pvp, pvp_until, hero, lessons, trophies, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET race = excluded.race, wood = excluded.wood, stone = excluded.stone, gold = excluded.gold,
         food = excluded.food, spawn_x = excluded.spawn_x, spawn_y = excluded.spawn_y, techs = excluded.techs, xp = excluded.xp,
         talents = excluded.talents, discoveries = excluded.discoveries, observed = excluded.observed,
         pvp = excluded.pvp, pvp_until = excluded.pvp_until, hero = excluded.hero, lessons = excluded.lessons, trophies = excluded.trophies,
         updated_at = excluded.updated_at`,
      );
      for (const p of b.players) {
        pl.run(
          p.id, p.race, p.resources.wood, p.resources.stone, p.resources.gold, p.resources.food, p.spawnX, p.spawnY, JSON.stringify(p.techs), p.xp,
          JSON.stringify(p.talents), JSON.stringify(p.discoveries), JSON.stringify(p.observed), p.pvp ? 1 : 0, p.pvpUntil, JSON.stringify(p.hero), JSON.stringify(p.lessons),
          JSON.stringify(p.trophies), now,
        );
      }
      const un = this.q(
        `INSERT INTO units (id, owner_id, type, x, y, facing, hp, inventory, program_source, program_version, program_state, program_error, program_library,
         learned, home_x, home_y, pen_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, type = excluded.type, x = excluded.x, y = excluded.y,
         facing = excluded.facing, hp = excluded.hp, inventory = excluded.inventory, program_source = excluded.program_source,
         program_version = excluded.program_version, program_state = excluded.program_state, program_error = excluded.program_error,
         program_library = excluded.program_library, learned = excluded.learned, home_x = excluded.home_x, home_y = excluded.home_y,
         pen_id = excluded.pen_id, updated_at = excluded.updated_at`,
      );
      for (const u of b.units) {
        un.run(
          u.id, u.ownerId, u.type, u.x, u.y, u.facing, u.hp, JSON.stringify(u.inventory), u.programSource, u.programVersion, u.programState,
          u.programError ? JSON.stringify(u.programError) : null, u.programLibrary ? JSON.stringify(u.programLibrary) : null,
          JSON.stringify(u.learned), u.home?.x ?? null, u.home?.y ?? null, u.pen, now,
        );
      }
      const bd = this.q(
        `INSERT INTO buildings (id, owner_id, type, x, y, w, h, hp, complete, progress, queue, prod_acc, fertility, completed_tick, stock, pen, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET hp = excluded.hp, complete = excluded.complete, progress = excluded.progress,
         queue = excluded.queue, prod_acc = excluded.prod_acc, fertility = excluded.fertility, completed_tick = excluded.completed_tick,
         stock = excluded.stock, pen = excluded.pen, updated_at = excluded.updated_at`,
      );
      for (const x of b.buildings) {
        bd.run(x.id, x.ownerId, x.type, x.x, x.y, x.w, x.h, x.hp, x.complete ? 1 : 0, x.progress, JSON.stringify(x.queue), x.prodAcc, x.fertility, x.completedTick, JSON.stringify(x.stock), x.pen ? JSON.stringify(x.pen) : null, now);
      }
      const lr = this.q(
        `INSERT INTO lairs (id, status, cleared_by, cleared_tick, respawn_tick, claim_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, cleared_by = excluded.cleared_by, cleared_tick = excluded.cleared_tick,
         respawn_tick = excluded.respawn_tick, claim_until = excluded.claim_until, updated_at = excluded.updated_at`,
      );
      for (const l of b.lairs) lr.run(l.id, l.status, l.clearedBy, l.clearedTick, l.respawnTick, l.claimUntil, now);
      const du = this.q("DELETE FROM units WHERE id = ?");
      for (const id of b.removedUnits) du.run(id);
      const db = this.q("DELETE FROM buildings WHERE id = ?");
      for (const id of b.removedBuildings) db.run(id);
      const cm = this.q(
        "INSERT INTO chunk_mods (cx, cy, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(cx, cy) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      );
      for (const c of b.chunkMods) cm.run(c.cx, c.cy, JSON.stringify(c.data), now);
      const au = this.q("INSERT INTO audit_log (tick, player_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const a of b.audit) au.run(a.tick, a.playerId, a.action, a.detail, now);
      const ex = this.q("INSERT OR IGNORE INTO explored_chunks (player_id, cx, cy, tick) VALUES (?, ?, ?, ?)");
      for (const e of b.explored) ex.run(e.playerId, e.cx, e.cy, e.tick);
      const te = this.q("INSERT INTO territory_events (player_id, building_id, tick, tiles, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const t of b.territoryEvents) te.run(t.playerId, t.buildingId, t.tick, t.tiles, now);
      const pc = this.q("INSERT OR IGNORE INTO populated_chunks (cx, cy) VALUES (?, ?)");
      for (const c of b.populated) pc.run(c.cx, c.cy);
      const rl = this.q("INSERT OR IGNORE INTO ruins_looted (x, y, player_id, tick) VALUES (?, ?, ?, ?)");
      for (const r of b.looted) rl.run(r.x, r.y, r.playerId, r.tick);
    });
  }

  findAccountByTokenHash(tokenHash: string): AccountRecord | null {
    const r = this.q("SELECT id, name, token_hash, created_at FROM accounts WHERE token_hash = ?").get(tokenHash) as Record<string, unknown> | undefined;
    return r ? { id: r.id as number, name: r.name as string, tokenHash: r.token_hash as string, createdAt: r.created_at as string } : null;
  }

  findAccountByName(name: string): AccountRecord | null {
    const r = this.q("SELECT id, name, token_hash, created_at FROM accounts WHERE name = ? COLLATE NOCASE").get(name) as Record<string, unknown> | undefined;
    return r ? { id: r.id as number, name: r.name as string, tokenHash: r.token_hash as string, createdAt: r.created_at as string } : null;
  }

  createAccount(name: string, tokenHash: string): AccountRecord {
    const createdAt = new Date().toISOString();
    const r = this.q("INSERT INTO accounts (name, token_hash, created_at) VALUES (?, ?, ?)").run(name, tokenHash, createdAt);
    return { id: Number(r.lastInsertRowid), name, tokenHash, createdAt };
  }

  touchLogin(accountId: number): void {
    this.q("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), accountId);
  }

  addProgramVersion(unitId: number, source: string, languageVersion: number, note: string): number {
    return this.tx(() => {
      const r = this.q("SELECT COALESCE(MAX(version), 0) AS v FROM program_versions WHERE unit_id = ?").get(unitId) as { v: number };
      const version = r.v + 1;
      this.q("INSERT INTO program_versions (unit_id, version, source, language_version, created_at, note) VALUES (?, ?, ?, ?, ?, ?)").run(
        unitId,
        version,
        source,
        languageVersion,
        new Date().toISOString(),
        note,
      );
      return version;
    });
  }

  getProgramVersion(unitId: number, version: number): ProgramVersionRecord | null {
    const r = this.q("SELECT * FROM program_versions WHERE unit_id = ? AND version = ?").get(unitId, version) as Record<string, unknown> | undefined;
    return r ? toVersion(r) : null;
  }

  listProgramVersions(unitId: number, limit: number): ProgramVersionRecord[] {
    return (this.q("SELECT * FROM program_versions WHERE unit_id = ? ORDER BY version DESC LIMIT ?").all(unitId, limit) as Record<string, unknown>[]).map(toVersion);
  }

  // ---------------------------------------------------------------- code library

  private static readonly LIB_SELECT = `SELECT p.*, a.name AS owner_name FROM library_programs p JOIN accounts a ON a.id = p.owner_id`;

  libList(viewerId: number): LibraryProgramRecord[] {
    return (this.q(`${SqliteStore.LIB_SELECT} WHERE p.owner_id = ? OR p.shared = 1 ORDER BY (p.owner_id = ?) DESC, p.name COLLATE NOCASE LIMIT 500`).all(viewerId, viewerId) as Record<string, unknown>[]).map(toLib);
  }

  libGet(programId: number): LibraryProgramRecord | null {
    const r = this.q(`${SqliteStore.LIB_SELECT} WHERE p.id = ?`).get(programId) as Record<string, unknown> | undefined;
    return r ? toLib(r) : null;
  }

  libFindByName(ownerId: number, name: string): LibraryProgramRecord | null {
    const r = this.q(`${SqliteStore.LIB_SELECT} WHERE p.owner_id = ? AND p.name = ? COLLATE NOCASE`).get(ownerId, name) as Record<string, unknown> | undefined;
    return r ? toLib(r) : null;
  }

  libCount(ownerId: number): number {
    return (this.q("SELECT COUNT(*) AS n FROM library_programs WHERE owner_id = ?").get(ownerId) as { n: number }).n;
  }

  libCreate(ownerId: number, meta: LibraryMeta, source: string, languageVersion: number, note: string): LibraryProgramRecord {
    const now = new Date().toISOString();
    const id = this.tx(() => {
      const r = this.q(
        "INSERT INTO library_programs (owner_id, name, description, unit_types, shared, latest_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      ).run(ownerId, meta.name, meta.description, JSON.stringify(meta.unitTypes), meta.shared ? 1 : 0, now, now);
      const pid = Number(r.lastInsertRowid);
      this.q("INSERT INTO library_versions (program_id, version, source, language_version, note, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(pid, source, languageVersion, note, now);
      return pid;
    });
    return this.libGet(id) as LibraryProgramRecord;
  }

  libUpdate(programId: number, meta: LibraryMeta, source: string, languageVersion: number, note: string): number {
    const now = new Date().toISOString();
    return this.tx(() => {
      const cur = this.q("SELECT latest_version FROM library_programs WHERE id = ?").get(programId) as { latest_version: number } | undefined;
      if (!cur) throw new Error(`Library program ${programId} not found`);
      let version = cur.latest_version;
      const latest = this.q("SELECT source FROM library_versions WHERE program_id = ? AND version = ?").get(programId, version) as { source: string } | undefined;
      if (latest?.source !== source) {
        version++;
        this.q("INSERT INTO library_versions (program_id, version, source, language_version, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(programId, version, source, languageVersion, note, now);
        // Retain the most recent 100 versions.
        this.q("DELETE FROM library_versions WHERE program_id = ? AND version <= ?").run(programId, version - 100);
      }
      this.q("UPDATE library_programs SET name = ?, description = ?, unit_types = ?, shared = ?, latest_version = ?, updated_at = ? WHERE id = ?").run(
        meta.name, meta.description, JSON.stringify(meta.unitTypes), meta.shared ? 1 : 0, version, now, programId,
      );
      return version;
    });
  }

  libVersions(programId: number, limit: number): Omit<LibraryVersionRecord, "source">[] {
    return (this.q("SELECT program_id, version, language_version, note, created_at FROM library_versions WHERE program_id = ? ORDER BY version DESC LIMIT ?").all(programId, limit) as Record<string, unknown>[]).map((r) => ({
      programId: r.program_id as number,
      version: r.version as number,
      languageVersion: r.language_version as number,
      note: r.note as string,
      createdAt: r.created_at as string,
    }));
  }

  libGetVersion(programId: number, version: number): LibraryVersionRecord | null {
    const r = this.q("SELECT * FROM library_versions WHERE program_id = ? AND version = ?").get(programId, version) as Record<string, unknown> | undefined;
    return r
      ? { programId: r.program_id as number, version: r.version as number, source: r.source as string, languageVersion: r.language_version as number, note: r.note as string, createdAt: r.created_at as string }
      : null;
  }

  libDelete(programId: number): void {
    this.tx(() => {
      this.q("DELETE FROM library_versions WHERE program_id = ?").run(programId);
      this.q("DELETE FROM library_programs WHERE id = ?").run(programId);
    });
  }

  territoryHistory(playerId: number, limit: number): TerritoryEventRecord[] {
    return (this.q("SELECT player_id, building_id, tick, tiles FROM territory_events WHERE player_id = ? ORDER BY id DESC LIMIT ?").all(playerId, limit) as Record<string, unknown>[]).map((r) => ({
      playerId: r.player_id as number,
      buildingId: r.building_id as number,
      tick: r.tick as number,
      tiles: r.tiles as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function toLib(r: Record<string, unknown>): LibraryProgramRecord {
  return {
    id: r.id as number,
    ownerId: r.owner_id as number,
    ownerName: r.owner_name as string,
    name: r.name as string,
    description: r.description as string,
    unitTypes: JSON.parse(r.unit_types as string) as string[],
    shared: (r.shared as number) === 1,
    latestVersion: r.latest_version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toVersion(r: Record<string, unknown>): ProgramVersionRecord {
  return {
    unitId: r.unit_id as number,
    version: r.version as number,
    source: r.source as string,
    languageVersion: r.language_version as number,
    createdAt: r.created_at as string,
    note: (r.note as string | null) ?? "",
  };
}
