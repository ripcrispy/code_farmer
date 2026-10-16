import { createHash, randomBytes } from "node:crypto";
import { chunkKey, floorDiv, parseKey } from "../shared/coords.ts";
import { raceDef } from "../shared/defs/races.ts";
import {
  LIMITS,
  NAME_PATTERN,
  PROTOCOL_VERSION,
  parseClientMessage,
  type BuildingView,
  type ClientMessage,
  type NodeTuple,
  type RuinTuple,
  type OwnerInfo,
  type Notice,
  type ServerMessage,
  type UnitView,
} from "../shared/protocol.ts";
import { LANGUAGE_VERSION, compileSource } from "../script/compiler.ts";
import { formatCost, type World } from "../sim/world.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { GameStore, SaveBatch } from "./persistence/store.ts";
import { buildingChunks, buildingView, chunkMessage, lairView, playerView, unitChunk, unitView } from "./views.ts";
import { handleLibrary } from "./library.ts";
import { NEUTRAL } from "../sim/types.ts";
import { findUnitDef } from "../shared/defs/units.ts";
import { findBuildingDef } from "../shared/defs/buildings.ts";

/** Transport-independent connection (implemented by the WebSocket adapter and by tests). */
export interface Connection {
  readonly id: number;
  readonly remote: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface Session {
  conn: Connection;
  playerId: number | null;
  subs: Set<string>;
  knownUnits: Map<number, number>;
  /** detailRev of own units' log/trace last sent. */
  knownDetail: Map<number, number>;
  knownBuildings: Map<number, number>;
  knownOwners: Set<number>;
  tokens: number;
  lastRefill: number;
  dropped: number;
  droppedWindowStart: number;
  closed: boolean;
  /**
   * Replies to this connection's recent requests, by reqId. Scoped to the connection, not
   * the player: clients number requests from 1 on every page load, so a per-player cache
   * would answer a fresh session's requests with an older session's replies.
   */
  reqCache: ReqCache;
}

interface ReqCache {
  order: number[];
  results: Map<number, ServerMessage[]>;
}

const REQ_CACHE_SIZE = 256;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Authoritative multiplayer game server. Owns the World, validates every client
 * request, performs interest management, and persists state through GameStore.
 */
export class GameServer {
  readonly world: World;
  private readonly store: GameStore;
  private readonly cfg: ServerConfig;
  private readonly log: Logger;
  private sessions = new Set<Session>();
  private sessionOf = new Map<Connection, Session>();
  private byPlayer = new Map<number, Session>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private running = false;
  readonly persistStatus = { lastFlushMs: 0, lastFlushAt: "", flushes: 0, error: "" as string, failures: 0 };
  readonly netStats = { messagesIn: 0, messagesOut: 0, bytesOut: 0, rejected: 0 };

  constructor(world: World, store: GameStore, cfg: ServerConfig, log: Logger) {
    this.world = world;
    this.store = store;
    this.cfg = cfg;
    this.log = log;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = 1000 / this.world.cfg.tickRate;
    let next = performance.now() + interval;
    const loop = (): void => {
      if (!this.running) return;
      const now = performance.now();
      let steps = 0;
      while (now >= next && steps < 5) {
        this.tickOnce();
        next += interval;
        steps++;
      }
      if (now - next > interval * 20) {
        this.log.warn(`Simulation is ${Math.round(now - next)}ms behind; skipping ahead`);
        next = now + interval;
      }
      this.tickTimer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    this.tickTimer = setTimeout(loop, interval);
  }

  /** Stop ticking, persist everything, and disconnect clients. */
  stop(): void {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.flush();
    for (const s of this.sessions) s.conn.close(1001, "Server shutting down");
  }

  /** Advance one simulation tick, broadcast changes, and flush persistence when due. */
  tickOnce(): void {
    this.world.step();
    const ph = this.world.tickPhases;
    let t = performance.now();
    if (this.world.tick % this.world.cfg.tickRate === 0) this.refreshVision();
    this.broadcast();
    ph.add("network", performance.now() - t);
    t = performance.now();
    const now = Date.now();
    if (now - this.lastFlushAt >= this.cfg.persistence.flushIntervalMs) this.flush();
    ph.add("persistence", performance.now() - t);
  }

  // ---------------------------------------------------------------- connections

  onConnect(conn: Connection): void {
    if (this.sessions.size >= this.cfg.server.maxConnections) {
      conn.send({ t: "error", code: "server_full", message: "Server is full" });
      conn.close(1013, "Server full");
      return;
    }
    const s: Session = {
      conn,
      playerId: null,
      subs: new Set(),
      knownUnits: new Map(),
      knownDetail: new Map(),
      knownBuildings: new Map(),
      knownOwners: new Set(),
      tokens: this.cfg.network.messageBurst,
      lastRefill: Date.now(),
      dropped: 0,
      droppedWindowStart: Date.now(),
      closed: false,
      reqCache: { order: [], results: new Map() },
    };
    this.sessions.add(s);
    this.sessionOf.set(conn, s);
  }

  onClose(conn: Connection): void {
    const s = this.sessionOf.get(conn);
    if (!s) return;
    s.closed = true;
    this.sessions.delete(s);
    this.sessionOf.delete(conn);
    if (s.playerId !== null && this.byPlayer.get(s.playerId) === s) {
      this.byPlayer.delete(s.playerId);
      this.log.info(`Player ${s.playerId} disconnected (${conn.remote})`);
    }
  }

  onMessage(conn: Connection, raw: string): void {
    const s = this.sessionOf.get(conn);
    if (!s || s.closed) return;
    this.netStats.messagesIn++;
    if (raw.length > this.cfg.network.maxMessageBytes) {
      this.send(s, { t: "error", code: "too_large", message: "Message too large" });
      return;
    }
    if (!this.takeToken(s)) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.netStats.rejected++;
      const err: ServerMessage = { t: "error", code: "bad_request", message: parsed.error };
      if (parsed.reqId !== undefined) err.reqId = parsed.reqId;
      this.send(s, err);
      return;
    }
    try {
      this.handle(s, parsed.msg);
    } catch (e) {
      this.log.error(`Unhandled error processing '${parsed.msg.t}' from ${conn.remote}`, e);
      const err: ServerMessage = { t: "error", code: "internal", message: "Internal server error" };
      if ("reqId" in parsed.msg) err.reqId = parsed.msg.reqId;
      this.send(s, err);
    }
  }

  private takeToken(s: Session): boolean {
    const now = Date.now();
    const n = this.cfg.network;
    s.tokens = Math.min(n.messageBurst, s.tokens + ((now - s.lastRefill) / 1000) * n.messagesPerSecond);
    s.lastRefill = now;
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return true;
    }
    if (now - s.droppedWindowStart > 60_000) {
      s.dropped = 0;
      s.droppedWindowStart = now;
    }
    s.dropped++;
    this.netStats.rejected++;
    if (s.dropped === 1) this.send(s, { t: "error", code: "rate_limited", message: "Too many messages; some were dropped" });
    if (s.dropped > 500) {
      this.log.warn(`Disconnecting ${s.conn.remote} for sustained rate-limit violations`);
      s.conn.close(1008, "Rate limit exceeded");
    }
    return false;
  }

  private send(s: Session, msg: ServerMessage): void {
    if (s.closed) return;
    this.netStats.messagesOut++;
    s.conn.send(msg);
  }

  // ---------------------------------------------------------------- request handling

  private handle(s: Session, msg: ClientMessage): void {
    if (msg.t === "hello") return this.handleHello(s, msg);
    if (s.playerId === null) {
      this.send(s, { t: "error", code: "not_authenticated", message: "Send hello first" });
      return;
    }
    const pid = s.playerId;
    if (msg.t === "subscribe") return this.handleSubscribe(s, pid, msg.chunks);
    if (msg.t === "ping") {
      this.send(s, { t: "pong", reqId: msg.reqId, tick: this.world.tick });
      return;
    }
    // Idempotency: a reqId repeated on the same connection gets the original response and is not executed again.
    const cache = s.reqCache;
    const prior = cache.results.get(msg.reqId);
    if (prior) {
      for (const m of prior) this.send(s, m);
      return;
    }
    const responses = this.execute(pid, msg);
    cache.results.set(msg.reqId, responses);
    cache.order.push(msg.reqId);
    while (cache.order.length > REQ_CACHE_SIZE) cache.results.delete(cache.order.shift() as number);
    for (const m of responses) this.send(s, m);
  }

  private execute(pid: number, msg: Exclude<ClientMessage, { t: "hello" | "subscribe" | "ping" }>): ServerMessage[] {
    const w = this.world;
    const err = (code: string, message: string): ServerMessage[] => [{ t: "error", reqId: msg.reqId, code, message }];
    switch (msg.t) {
      case "unit_cmd": {
        if (msg.cmd.kind === "observe" || msg.cmd.kind === "tame" || msg.cmd.kind === "attack") {
          // A target outside your vision gets the same answer as one that does not exist.
          const c = w.units.get(msg.cmd.targetId);
          if (!c || w.isHiddenFrom(c, pid) || !this.allowedChunks(pid).has(chunkKey(floorDiv(c.x, w.chunks.size), floorDiv(c.y, w.chunks.size)))) {
            return err("not_found", msg.cmd.kind === "attack" ? "No such target nearby" : "No such creature nearby");
          }
        }
        if (msg.cmd.kind === "attack_building") {
          const b = w.buildings.get(msg.cmd.buildingId);
          const allowed = this.allowedChunks(pid);
          if (!b || !buildingChunks(w, b).some((k) => allowed.has(k))) return err("not_found", "No such building nearby");
        }
        const r = w.commandUnit(pid, msg.unitId, msg.cmd);
        return r.ok ? [{ t: "ack", reqId: msg.reqId }] : err(r.code, r.message);
      }
      case "place_building": {
        const r = w.placeBuilding(pid, msg.type, msg.x, msg.y);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, id: r.value.id, message: "Construction site placed" }] : err(r.code, r.message);
      }
      case "hero_recruit": {
        const r = w.recruitHero(pid, msg.buildingId);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: r.value.queue.at(-1)?.kind === "hero" && (r.value.queue.at(-1) as { revive: boolean }).revive ? "Revival started" : "Your hero is on the way" }] : err(r.code, r.message);
      }
      case "unit_dismiss": {
        const r = w.dismissUnits(pid, msg.unitIds);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: r.value === 1 ? "Unit dismissed" : `${r.value} units dismissed` }] : err(r.code, r.message);
      }
      case "building_demolish": {
        const r = w.demolishBuilding(pid, msg.buildingId);
        if (!r.ok) return err(r.code, r.message);
        const back = formatCost(r.value.refund);
        return [{ t: "ack", reqId: msg.reqId, message: back !== "nothing" ? `Demolished; refunded ${back}` : "Demolished" }];
      }
      case "paddock_release": {
        const r = w.releaseAnimal(pid, msg.buildingId, msg.unitId);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: "Released" }] : err(r.code, r.message);
      }
      case "hero_train": {
        const r = w.trainHero(pid, msg.buildingId, msg.track);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: "Battle training queued" }] : err(r.code, r.message);
      }
      case "ability": {
        const t = msg.target;
        if (t && "unitId" in t) {
          // A target outside your vision gets the same answer as one that does not exist.
          const c = w.units.get(t.unitId);
          if (!c || w.isHiddenFrom(c, pid) || !this.allowedChunks(pid).has(chunkKey(floorDiv(c.x, w.chunks.size), floorDiv(c.y, w.chunks.size)))) return err("not_found", "No such target nearby");
        }
        const r = w.useAbility(pid, msg.unitId, msg.ability, t);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: r.value }] : err(r.code, r.message);
      }
      case "train": {
        const r = w.trainUnit(pid, msg.buildingId, msg.unitType);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: "Training queued" }] : err(r.code, r.message);
      }
      case "inspect_species": {
        const def = findUnitDef(msg.type);
        // Monsters' behaviour is public knowledge (inspection tier 1): it tells you what they will do to you.
        if (def?.monster) return [{ t: "species", reqId: msg.reqId, type: msg.type, behaviour: def.defaultProgram }];
        if (!def?.creature) return err("not_found", `Unknown creature '${msg.type}'`);
        const p = w.players.get(pid);
        if (!p?.observed.includes(msg.type)) {
          return err("not_observed", `You have not observed a ${def.name.toLowerCase()} yet. Have a unit observe() one to learn its behaviour.`);
        }
        return [{ t: "species", reqId: msg.reqId, type: msg.type, behaviour: def.creature.wildProgram }];
      }
      case "talent_allocate": {
        const r = w.allocateTalent(pid, msg.talentId);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: "Talent learned" }] : err(r.code, r.message);
      }
      case "talent_reset": {
        const r = w.resetTalents(pid);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: `Refunded ${r.value} talent points` }] : err(r.code, r.message);
      }
      case "combat_optin": {
        const r = w.setPvp(pid, msg.enabled);
        if (!r.ok) return err(r.code, r.message);
        const message = msg.enabled
          ? "You have opted in to PvP: players who also opted in can attack you, and you them."
          : r.value.pvpUntil !== null
            ? `Leaving PvP: you stay attackable for ${Math.ceil((r.value.pvpUntil - w.tick) / w.cfg.tickRate)} more seconds (longer if you keep fighting).`
            : "You are not in PvP.";
        return [{ t: "ack", reqId: msg.reqId, message }];
      }
      case "research": {
        const r = w.research(pid, msg.buildingId, msg.techId);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: "Research started" }] : err(r.code, r.message);
      }
      case "overview_get": {
        const o = w.overview(pid, msg.cx, msg.cy, msg.radius);
        return [{ t: "overview", reqId: msg.reqId, ...o }];
      }
      case "stats_get": {
        const ranked = [...w.players.values()]
          .map((p) => ({ id: p.id, name: p.name, race: p.race, territory: w.territory.countOf(p.id) }))
          .sort((a, b) => b.territory - a.territory || a.id - b.id);
        const leaderboard = ranked.slice(0, 10);
        if (!leaderboard.some((r) => r.id === pid)) {
          const me = ranked.find((r) => r.id === pid);
          if (me) leaderboard.push(me);
        }
        // Include unsaved claims so the history is current.
        const pending = w.territory.claims.filter((c) => c.playerId === pid).reverse();
        const history = [...pending, ...this.store.territoryHistory(pid, 30)].slice(0, 30).map((h) => ({
          buildingId: h.buildingId,
          buildingType: w.buildings.get(h.buildingId)?.type ?? "unknown",
          seconds: Math.round(h.tick / w.cfg.tickRate),
          tiles: h.tiles,
        }));
        const p = w.players.get(pid);
        return [{ t: "stats", reqId: msg.reqId, leaderboard, history, territory: w.territory.countOf(pid), explored: p?.explored.size ?? 0 }];
      }
      case "program_save": {
        const u = w.units.get(msg.unitId);
        if (!u) return err("not_found", "Unit not found");
        if (u.owner !== pid) return err("permission_denied", "Permission denied: you do not own that unit");
        const c = compileSource(msg.source, { unlocks: w.mods(pid).unlocks });
        if (!c.ok) {
          const d = c.diagnostics[0];
          return err("syntax_error", d ? `Line ${d.line}, col ${d.col}: ${d.message}` : "Syntax error");
        }
        const version = this.store.addProgramVersion(u.id, msg.source, LANGUAGE_VERSION, "saved from editor");
        const r = w.setProgram(pid, u.id, msg.source, version);
        if (!r.ok) return err(r.code, r.message);
        if (msg.run && u.program.state !== "running") {
          const rr = w.controlProgram(pid, u.id, "run");
          if (!rr.ok) return err(rr.code, rr.message);
        }
        return [{ t: "ack", reqId: msg.reqId, message: `Saved version ${version}`, id: version }];
      }
      case "program_control": {
        const r = w.controlProgram(pid, msg.unitId, msg.action);
        return r.ok ? [{ t: "ack", reqId: msg.reqId, message: r.value.program.note }] : err(r.code, r.message);
      }
      case "program_get": {
        const u = w.units.get(msg.unitId);
        if (!u) return err("not_found", "Unit not found");
        if (u.owner !== pid) return err("permission_denied", "Permission denied: other players' programs are private");
        const versions = this.store.listProgramVersions(u.id, 20).map((v) => ({ version: v.version, createdAt: v.createdAt, note: v.note }));
        return [{ t: "program", reqId: msg.reqId, unitId: u.id, source: u.program.source, version: u.program.version, state: u.program.state, versions }];
      }
      case "units_control": {
        // Validate every unit first so a batch never applies partially because of a permission error.
        for (const id of msg.unitIds) {
          const u = w.units.get(id);
          if (!u) return err("not_found", `Unit ${id} does not exist`);
          if (u.owner !== pid) return err("permission_denied", `Permission denied: unit #${id} is not yours`);
        }
        let changed = 0;
        const failures: string[] = [];
        for (const id of msg.unitIds) {
          const r = w.controlProgram(pid, id, msg.action);
          if (r.ok) changed++;
          else failures.push(`#${id}: ${r.message}`);
        }
        return [{ t: "ack", reqId: msg.reqId, message: `${msg.action}: ${changed} unit${changed === 1 ? "" : "s"}${failures.length ? ` (${failures.length} unchanged)` : ""}` }];
      }
      case "lib_list":
      case "lib_get":
      case "lib_save":
      case "lib_delete":
      case "lib_copy":
      case "lib_assign":
      case "lib_export":
      case "lib_import":
        return handleLibrary(w, this.store, pid, msg);
      case "program_restore": {
        const u = w.units.get(msg.unitId);
        if (!u) return err("not_found", "Unit not found");
        if (u.owner !== pid) return err("permission_denied", "Permission denied: you do not own that unit");
        const v = this.store.getProgramVersion(u.id, msg.version);
        if (!v) return err("not_found", `Version ${msg.version} not found`);
        if (!compileSource(v.source, { unlocks: w.mods(pid).unlocks }).ok) return err("syntax_error", `Version ${msg.version} no longer compiles under the current language version`);
        const nv = this.store.addProgramVersion(u.id, v.source, LANGUAGE_VERSION, `restored from version ${msg.version}`);
        const r = w.setProgram(pid, u.id, v.source, nv);
        if (!r.ok) return err(r.code, r.message);
        return [{ t: "ack", reqId: msg.reqId, message: `Restored version ${msg.version} as version ${nv}`, id: nv }];
      }
    }
  }

  private handleHello(s: Session, msg: Extract<ClientMessage, { t: "hello" }>): void {
    if (s.playerId !== null) {
      this.send(s, { t: "error", code: "already_authenticated", message: "Already logged in" });
      return;
    }
    if (msg.v !== PROTOCOL_VERSION) {
      this.send(s, { t: "error", code: "protocol_version", message: `Client protocol v${msg.v} is not supported (server v${PROTOCOL_VERSION}); reload the page` });
      return;
    }
    let account;
    let token = msg.token ?? "";
    let created = false;
    if (token) {
      account = this.store.findAccountByTokenHash(hashToken(token));
      if (!account) {
        this.send(s, { t: "error", code: "bad_token", message: "Saved login is not valid for this server; choose a new name" });
        return;
      }
    } else {
      const name = msg.name.trim();
      if (name.length < LIMITS.minNameLength || name.length > LIMITS.maxNameLength || !NAME_PATTERN.test(name)) {
        this.send(s, { t: "error", code: "bad_name", message: `Name must be ${LIMITS.minNameLength}-${LIMITS.maxNameLength} letters, digits, spaces, '-' or '_'` });
        return;
      }
      if (this.store.findAccountByName(name)) {
        this.send(s, { t: "error", code: "name_taken", message: "That name is already registered. Log in from the browser that created it, or choose another name." });
        return;
      }
      const race = msg.race ?? "human";
      if (!raceDef(race)) {
        this.send(s, { t: "error", code: "bad_race", message: `Unknown race '${race}'` });
        return;
      }
      token = randomBytes(24).toString("base64url");
      account = this.store.createAccount(name, hashToken(token));
      created = true;
      const r = this.world.createPlayer(account.id, account.name, race);
      if (!r.ok) {
        this.log.error(`Could not create player for account ${account.id}: ${r.message}`);
        this.send(s, { t: "error", code: r.code, message: r.message });
        return;
      }
      this.flush(); // persist the new player immediately
      this.log.info(`New player ${account.name} (#${account.id}, ${race}) at ${r.value.spawnX},${r.value.spawnY}`);
    }
    // Recover an account whose player record was never persisted (e.g. crash right after signup).
    if (!this.world.players.has(account.id)) {
      const r = this.world.createPlayer(account.id, account.name, msg.race && raceDef(msg.race) ? msg.race : "human");
      if (!r.ok) {
        this.send(s, { t: "error", code: r.code, message: r.message });
        return;
      }
      this.flush();
    }
    this.store.touchLogin(account.id);
    const existing = this.byPlayer.get(account.id);
    if (existing && existing !== s) {
      this.send(existing, { t: "kicked", reason: "Logged in from another client" });
      existing.conn.close(4000, "Logged in elsewhere");
      this.onClose(existing.conn);
    }
    s.playerId = account.id;
    this.byPlayer.set(account.id, s);
    const p = this.world.players.get(account.id);
    if (!p) throw new Error("player missing after login");
    this.send(s, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      playerId: p.id,
      name: p.name,
      race: p.race,
      token,
      created,
      world: {
        chunkSize: this.world.chunks.size,
        tickRate: this.world.cfg.tickRate,
        generationVersion: this.world.gen.params.generationVersion,
        visionChunkRadius: this.cfg.network.visionChunkRadius,
        combatEnabled: this.world.cfg.combatEnabled,
        pveEnabled: this.world.cfg.pveEnabled,
        contestedZones: this.world.zonesActive,
        storageMode: this.world.cfg.storageMode,
      },
      spawn: { x: p.spawnX, y: p.spawnY },
    });
    // Initial state: all own entities and the player record.
    const units: UnitView[] = [];
    const buildings: BuildingView[] = [];
    for (const id of this.world.unitsOf(p.id)) {
      const u = this.world.units.get(id);
      if (!u) continue;
      units.push(unitView(this.world, u, true));
      s.knownDetail.set(id, u.detailRev);
      s.knownUnits.set(id, u.rev);
    }
    for (const id of this.world.buildingsOf(p.id)) {
      const b = this.world.buildings.get(id);
      if (!b) continue;
      buildings.push(buildingView(this.world, b, true));
      s.knownBuildings.set(id, b.rev);
    }
    s.knownOwners.add(p.id);
    this.send(s, { t: "tick", tick: this.world.tick, units, buildings, player: playerView(this.world, p), owners: [this.ownerInfo(p.id)] });
    this.log.info(`Player ${p.name} (#${p.id}) connected from ${s.conn.remote}`);
  }

  // ---------------------------------------------------------------- interest management

  /** Chunks a player may observe: within visionChunkRadius of any chunk holding their units or buildings. */
  allowedChunks(pid: number): Set<string> {
    const r = this.cfg.network.visionChunkRadius;
    const out = new Set<string>();
    for (const key of this.world.presenceChunks(pid)) {
      const { a: cx, b: cy } = parseKey(key);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.add(chunkKey(cx + dx, cy + dy));
    }
    // Completed buildings with extra vision (Watchtower) see further around themselves.
    const size = this.world.chunks.size;
    for (const id of this.world.buildingsOf(pid)) {
      const b = this.world.buildings.get(id);
      const extra = b?.complete ? (findBuildingDef(b.type)?.vision ?? 0) : 0;
      if (!b || extra <= 0) continue;
      const cx = floorDiv(b.x, size);
      const cy = floorDiv(b.y, size);
      const vr = r + extra;
      for (let dy = -vr; dy <= vr; dy++) for (let dx = -vr; dx <= vr; dx++) out.add(chunkKey(cx + dx, cy + dy));
    }
    return out;
  }

  private handleSubscribe(s: Session, pid: number, chunks: [number, number][]): void {
    const allowed = this.allowedChunks(pid);
    const requested = new Set(chunks.map(([cx, cy]) => chunkKey(cx, cy)));
    const denied: [number, number][] = [];
    const next = new Set<string>();
    for (const k of requested) {
      if (allowed.has(k)) next.add(k);
      else {
        const { a, b } = parseKey(k);
        denied.push([a, b]);
      }
    }
    const dropped = [...s.subs].filter((k) => !next.has(k));
    const added = [...next].filter((k) => !s.subs.has(k));
    s.subs = next;
    this.dropOutOfInterest(s, pid, dropped);
    for (const k of added) {
      const { a: cx, b: cy } = parseKey(k);
      this.send(s, chunkMessage(this.world, cx, cy, pid));
    }
    this.sendEntitiesIn(s, pid, added);
    if (denied.length) this.send(s, { t: "chunk_denied", chunks: denied, reason: "Outside your vision: move units or build closer to see this area" });
  }

  private dropOutOfInterest(s: Session, pid: number, chunkKeys: string[]): void {
    if (chunkKeys.length === 0) return;
    const removedUnits: number[] = [];
    const removedBuildings: number[] = [];
    for (const k of chunkKeys) {
      for (const id of this.world.unitsInChunk(k)) {
        const u = this.world.units.get(id);
        if (u && u.owner !== pid && s.knownUnits.has(id)) {
          s.knownUnits.delete(id);
          removedUnits.push(id);
        }
      }
      for (const id of this.world.buildingsInChunk(k)) {
        const b = this.world.buildings.get(id);
        if (b && b.owner !== pid && s.knownBuildings.has(id) && !buildingChunks(this.world, b).some((c) => s.subs.has(c))) {
          s.knownBuildings.delete(id);
          removedBuildings.push(id);
        }
      }
    }
    if (removedUnits.length || removedBuildings.length) this.send(s, { t: "tick", tick: this.world.tick, removedUnits, removedBuildings });
  }

  private sendEntitiesIn(s: Session, pid: number, chunkKeys: string[]): void {
    const units: UnitView[] = [];
    const buildings: BuildingView[] = [];
    const owners: OwnerInfo[] = [];
    for (const k of chunkKeys) {
      for (const o of this.world.territory.ownersIn(k)) this.noteOwner(s, o, owners);
      for (const id of this.world.unitsInChunk(k)) {
        const u = this.world.units.get(id);
        if (!u || s.knownUnits.get(id) === u.rev || this.world.isHiddenFrom(u, pid)) continue;
        units.push(unitView(this.world, u, u.owner === pid));
        if (u.owner === pid) s.knownDetail.set(id, u.detailRev);
        s.knownUnits.set(id, u.rev);
        this.noteOwner(s, u.owner, owners);
      }
      for (const id of this.world.buildingsInChunk(k)) {
        const b = this.world.buildings.get(id);
        if (!b || s.knownBuildings.get(id) === b.rev) continue;
        buildings.push(buildingView(this.world, b, b.owner === pid));
        s.knownBuildings.set(id, b.rev);
        this.noteOwner(s, b.owner, owners);
      }
    }
    if (units.length || buildings.length || owners.length) {
      const m: ServerMessage = { t: "tick", tick: this.world.tick, units, buildings };
      if (owners.length) m.owners = owners;
      this.send(s, m);
    }
  }

  private ownerInfo(owner: number): OwnerInfo {
    if (owner === NEUTRAL) return { id: NEUTRAL, name: "Wildlife", race: "wild", pvp: false };
    const p = this.world.players.get(owner);
    return { id: owner, name: p?.name ?? `player ${owner}`, race: p?.race ?? "human", pvp: this.world.pvpActive(owner) };
  }

  private noteOwner(s: Session, owner: number, out: OwnerInfo[]): void {
    if (s.knownOwners.has(owner)) return;
    if (owner !== NEUTRAL && !this.world.players.has(owner)) return;
    s.knownOwners.add(owner);
    out.push(this.ownerInfo(owner));
  }

  /** Revoke subscriptions to chunks that are no longer within the player's vision. */
  private refreshVision(): void {
    for (const s of this.sessions) {
      if (s.playerId === null || s.subs.size === 0) continue;
      const allowed = this.allowedChunks(s.playerId);
      const revoked = [...s.subs].filter((k) => !allowed.has(k));
      if (revoked.length === 0) continue;
      for (const k of revoked) s.subs.delete(k);
      this.dropOutOfInterest(s, s.playerId, revoked);
      this.send(s, { t: "chunk_denied", chunks: revoked.map((k) => { const { a, b } = parseKey(k); return [a, b] as [number, number]; }), reason: "Out of vision" });
    }
  }

  private broadcast(): void {
    const w = this.world;
    const size = w.chunks.size;
    const nodeChanges = w.chunks.nodeChanges;
    const terrDirty = [...w.territory.dirty];
    const levelUps = new Map(w.levelUps.map((l) => [l.playerId, l.level]));
    const ruinChanges = w.ruinChanges;
    const notices = new Map<number, Notice[]>();
    for (const n of w.notices) {
      let list = notices.get(n.playerId);
      if (!list) notices.set(n.playerId, (list = []));
      if (list.length < 20) list.push({ kind: n.kind, text: n.text });
    }
    const ownersChanged = [...w.ownersChanged];
    const lairsChanged = [...w.lairNet].flatMap((id) => {
      const l = w.lairs.byId(id);
      return l ? [l] : [];
    });
    for (const s of this.sessions) {
      const pid = s.playerId;
      if (pid === null) continue;
      const units: UnitView[] = [];
      const buildings: BuildingView[] = [];
      const removedUnits: number[] = [];
      const removedBuildings: number[] = [];
      const owners: OwnerInfo[] = [];
      // Owners whose PvP status changed: refresh everyone who already knows them.
      for (const o of ownersChanged) if (s.knownOwners.has(o)) owners.push(this.ownerInfo(o));
      for (const id of w.net.units) {
        const u = w.units.get(id);
        if (!u) continue;
        // Stealthy units are only sent to players who detect them (and to their owner).
        const interested = u.owner === pid || (s.subs.has(unitChunk(w, u)) && !w.isHiddenFrom(u, pid));
        if (interested) {
          if (s.knownUnits.get(id) !== u.rev) {
            const own = u.owner === pid;
            const details = own && s.knownDetail.get(id) !== u.detailRev;
            if (details) s.knownDetail.set(id, u.detailRev);
            units.push(unitView(w, u, own, details));
            s.knownUnits.set(id, u.rev);
            this.noteOwner(s, u.owner, owners);
          }
        } else if (s.knownUnits.has(id)) {
          s.knownUnits.delete(id);
          removedUnits.push(id);
        }
      }
      for (const id of w.net.removedUnits) {
        if (s.knownUnits.delete(id)) removedUnits.push(id);
      }
      for (const id of w.net.buildings) {
        const b = w.buildings.get(id);
        if (!b) continue;
        const interested = b.owner === pid || buildingChunks(w, b).some((c) => s.subs.has(c));
        if (interested && s.knownBuildings.get(id) !== b.rev) {
          buildings.push(buildingView(w, b, b.owner === pid));
          s.knownBuildings.set(id, b.rev);
          this.noteOwner(s, b.owner, owners);
        }
      }
      for (const id of w.net.removedBuildings) {
        if (s.knownBuildings.delete(id)) removedBuildings.push(id);
      }
      const nodes: NodeTuple[] = [];
      for (const n of nodeChanges) {
        if (s.subs.has(chunkKey(floorDiv(n.x, size), floorDiv(n.y, size)))) nodes.push([n.kind, n.x, n.y, n.amount]);
      }
      const territory: { cx: number; cy: number; runs: number[] }[] = [];
      for (const key of terrDirty) {
        if (!s.subs.has(key)) continue;
        const { a, b } = parseKey(key);
        territory.push({ cx: a, cy: b, runs: w.territory.encodeChunk(key) });
        for (const o of w.territory.ownersIn(key)) this.noteOwner(s, o, owners);
      }
      const p = w.net.players.has(pid) ? w.players.get(pid) : undefined;
      const ruins: RuinTuple[] = [];
      for (const r of ruinChanges) {
        if (!s.subs.has(chunkKey(floorDiv(r.x, size), floorDiv(r.y, size)))) continue;
        const g = w.chunks.ruinAt(r.x, r.y);
        if (g) ruins.push([g.x, g.y, g.tier, w.lootedRuins.has(`${g.x},${g.y}`) ? 1 : 0]);
      }
      const myNotices = notices.get(pid);
      const lairs = lairsChanged.filter((l) => s.subs.has(chunkKey(floorDiv(l.x, size), floorDiv(l.y, size)))).map((l) => lairView(w, l, pid));
      const hasContent =
        units.length || buildings.length || removedUnits.length || removedBuildings.length || nodes.length || territory.length || ruins.length || p || levelUps.has(pid) || myNotices || owners.length || lairs.length;
      if (!hasContent && w.tick % w.cfg.tickRate !== 0) continue;
      const m: ServerMessage = { t: "tick", tick: w.tick };
      if (units.length) m.units = units;
      if (buildings.length) m.buildings = buildings;
      if (removedUnits.length) m.removedUnits = removedUnits;
      if (removedBuildings.length) m.removedBuildings = removedBuildings;
      if (nodes.length) m.nodes = nodes;
      if (territory.length) m.territory = territory;
      if (ruins.length) m.ruins = ruins;
      const lv = levelUps.get(pid);
      if (lv !== undefined) m.levelUp = lv;
      if (p) m.player = playerView(w, p);
      if (owners.length) m.owners = owners;
      if (myNotices) m.notices = myNotices;
      if (lairs.length) m.lairs = lairs;
      this.send(s, m);
    }
    w.lairNet.clear();
    w.notices = [];
    w.ownersChanged.clear();
    w.net.clear();
    w.chunks.nodeChanges = [];
    w.territory.dirty.clear();
    w.levelUps = [];
    w.ruinChanges = [];
  }

  // ---------------------------------------------------------------- persistence

  /** Write all dirty state in one transaction. On failure the dirty sets are kept and retried next time. */
  flush(): boolean {
    const w = this.world;
    const ps = w.persist;
    this.lastFlushAt = Date.now();
    const audit = w.audit;
    const dirtyMods = [...w.chunks.dirtyMods];
    const explored = w.exploredNew;
    const claims = w.territory.claims;
    const populated = w.populatedNew;
    const looted = w.lootedNew;
    if (ps.units.size + ps.buildings.size + ps.players.size + ps.removedUnits.size + ps.removedBuildings.size + dirtyMods.length + audit.length + explored.length + claims.length + populated.length + looted.length + w.lairDirty.size === 0) {
      return true;
    }
    const batch: SaveBatch = {
      meta: { nextId: w.nextId, tick: w.tick },
      players: [...ps.players].flatMap((id) => {
        const p = w.players.get(id);
        return p ? [{ id: p.id, race: p.race, resources: { ...p.resources }, spawnX: p.spawnX, spawnY: p.spawnY, techs: [...p.techs], xp: p.xp, talents: { ...p.talents }, discoveries: [...p.discoveries], observed: [...p.observed], pvp: p.pvp, pvpUntil: p.pvpUntil, hero: { ...p.hero, ranks: { ...p.hero.ranks } }, lessons: [...p.lessons], trophies: [...p.trophies] }] : [];
      }),
      units: [...ps.units].flatMap((id) => {
        const u = w.units.get(id);
        return u
          ? [{
              id: u.id,
              ownerId: u.owner,
              type: u.type,
              x: u.x,
              y: u.y,
              facing: u.facing,
              hp: u.hp,
              inventory: { ...u.inventory },
              programSource: u.program.source,
              programVersion: u.program.version,
              programState: u.program.state,
              programError: u.program.error,
              programLibrary: u.program.library,
              learned: [...u.learned],
              home: u.home ? { ...u.home } : null,
              pen: u.pen,
            }]
          : [];
      }),
      buildings: [...ps.buildings].flatMap((id) => {
        const b = w.buildings.get(id);
        return b
          ? [{ id: b.id, ownerId: b.owner, type: b.type, x: b.x, y: b.y, w: b.w, h: b.h, hp: b.hp, complete: b.complete, progress: b.progress, queue: b.queue.map((q) => ({ ...q })), prodAcc: b.prodAcc, fertility: b.fertility, completedTick: b.completedTick, stock: { ...b.stock }, pen: b.pen ? { acc: { ...b.pen.acc }, breed: { ...b.pen.breed } } : null }]
          : [];
      }),
      removedUnits: [...ps.removedUnits],
      removedBuildings: [...ps.removedBuildings],
      chunkMods: dirtyMods.map((k) => {
        const { a, b } = parseKey(k);
        return { cx: a, cy: b, data: w.chunks.exportMods(k) };
      }),
      audit: audit.slice(),
      explored: explored.map((e) => {
        const { a, b } = parseKey(e.key);
        return { playerId: e.playerId, cx: a, cy: b, tick: w.tick };
      }),
      territoryEvents: claims.map((c) => ({ playerId: c.playerId, buildingId: c.buildingId, tick: c.tick, tiles: c.tiles })),
      populated: populated.map((k) => {
        const { a, b } = parseKey(k);
        return { cx: a, cy: b };
      }),
      looted: looted.map((l) => ({ ...l, tick: w.tick })),
      lairs: [...w.lairDirty].flatMap((id) => {
        const st = w.lairState.get(id);
        return st ? [{ ...st }] : [];
      }),
    };
    const t0 = performance.now();
    try {
      this.store.saveBatch(batch);
    } catch (e) {
      this.persistStatus.failures++;
      this.persistStatus.error = (e as Error).message;
      this.log.error("Persistence flush failed; changes are kept in memory and will be retried", e);
      return false;
    }
    ps.clear();
    for (const k of dirtyMods) w.chunks.dirtyMods.delete(k);
    w.audit.splice(0, batch.audit.length);
    w.exploredNew.splice(0, batch.explored.length);
    w.territory.claims.splice(0, batch.territoryEvents.length);
    w.populatedNew.splice(0, batch.populated.length);
    w.lootedNew.splice(0, batch.looted.length);
    for (const l of batch.lairs) w.lairDirty.delete(l.id);
    this.persistStatus.lastFlushMs = performance.now() - t0;
    this.persistStatus.lastFlushAt = new Date().toISOString();
    this.persistStatus.flushes++;
    this.persistStatus.error = "";
    return true;
  }

  // ---------------------------------------------------------------- admin

  status(): Record<string, unknown> {
    const w = this.world;
    return {
      world: { ...w.gen.params },
      simulation: w.cfg,
      tick: w.tick,
      players: w.players.size,
      units: w.units.size,
      buildings: w.buildings.size,
      connections: this.sessions.size,
      onlinePlayers: this.byPlayer.size,
      chunksCached: w.chunks.cachedCount,
      chunksGenerated: w.chunks.generatedCount,
      tickMs: { last: Number(w.stats.lastTickMs.toFixed(3)), max: Number(w.stats.maxTickMs.toFixed(3)) },
      tickPhasesMs: w.tickPhases.summary(),
      scripts: { opsLastTick: w.stats.scriptOps, unitsRunLastTick: w.stats.scriptUnitsRun, deferredLastTick: w.stats.scriptUnitsDeferred },
      pathSearches: w.stats.pathSearches,
      pathFailures: w.stats.pathFailures,
      coarseSearches: w.stats.coarseSearches,
      wildlife: w.unitsOf(NEUTRAL).size,
      internalErrors: w.stats.internalErrors,
      network: this.netStats,
      persistence: this.persistStatus,
    };
  }

  isOnline(pid: number): boolean {
    return this.byPlayer.has(pid);
  }
}
