import { DEFAULT_CONFIG, type ServerConfig } from "../src/server/config.ts";
import { openWorld } from "../src/server/bootstrap.ts";
import { GameServer, type Connection } from "../src/server/gameServer.ts";
import { silentLogger } from "../src/server/logger.ts";
import { SqliteStore } from "../src/server/persistence/sqliteStore.ts";
import { PROTOCOL_VERSION, type BuildingView, type PlayerView, type ServerMessage, type UnitView } from "../src/shared/protocol.ts";
import { World } from "../src/sim/world.ts";

export const PARAMS = { seed: "test-seed", generationVersion: 1, chunkSize: 64, resourceDensity: 1 };

export function makeWorld(seed = "test-seed"): World {
  return new World({ ...PARAMS, seed });
}

export function testConfig(dbPath = ":memory:", over: Partial<ServerConfig["network"]> = {}): ServerConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.world = { ...PARAMS };
  c.persistence.databasePath = dbPath;
  c.network = { ...c.network, ...over };
  return c;
}

export function makeServer(dbPath = ":memory:", cfg = testConfig(dbPath)): { game: GameServer; store: SqliteStore; world: World } {
  const store = new SqliteStore(dbPath);
  const { world } = openWorld(cfg, store, silentLogger);
  const game = new GameServer(world, store, cfg, silentLogger);
  return { game, store, world };
}

let connIds = 1;

/** In-process client: a fake Connection plus a reducer that mirrors what a real client would know. */
export class TestClient implements Connection {
  readonly id = connIds++;
  readonly remote = "test";
  inbox: ServerMessage[] = [];
  closed = false;
  playerId = 0;
  token = "";
  spawn = { x: 0, y: 0 };
  units = new Map<number, UnitView>();
  buildings = new Map<number, BuildingView>();
  player: PlayerView | null = null;
  chunks = new Map<string, ServerMessage & { t: "chunk" }>();
  errors: (ServerMessage & { t: "error" })[] = [];
  private req = 1;
  private readonly game: GameServer;

  constructor(game: GameServer) {
    this.game = game;
    game.onConnect(this);
  }

  send(msg: ServerMessage): void {
    // Round-trip through JSON exactly like the real transport.
    const m = JSON.parse(JSON.stringify(msg)) as ServerMessage;
    this.inbox.push(m);
    switch (m.t) {
      case "welcome":
        this.playerId = m.playerId;
        this.token = m.token;
        this.spawn = m.spawn;
        break;
      case "tick":
        for (const u of m.units ?? []) {
          const prev = this.units.get(u.id);
          if (u.own && prev?.own) {
            u.own.log ??= prev.own.log;
            u.own.trace ??= prev.own.trace;
          }
          this.units.set(u.id, u);
        }
        for (const b of m.buildings ?? []) this.buildings.set(b.id, b);
        for (const id of m.removedUnits ?? []) this.units.delete(id);
        for (const id of m.removedBuildings ?? []) this.buildings.delete(id);
        if (m.player) this.player = m.player;
        break;
      case "chunk":
        this.chunks.set(`${m.cx},${m.cy}`, m);
        break;
      case "error":
        this.errors.push(m);
        break;
      default:
        break;
    }
  }

  close(): void {
    this.closed = true;
  }

  raw(text: string): void {
    this.game.onMessage(this, text);
  }

  hello(name: string, extra: { token?: string; race?: string } = {}): void {
    this.raw(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, name, ...extra }));
  }

  /** Send a request and return the response(s) carrying its reqId. */
  request(msg: Record<string, unknown>, reqId = this.req++): ServerMessage[] {
    const before = this.inbox.length;
    this.raw(JSON.stringify({ ...msg, reqId }));
    return this.inbox.slice(before).filter((m) => "reqId" in m && m.reqId === reqId);
  }

  subscribeAround(x: number, y: number, r = 1, size = 64): void {
    const cx = Math.floor(x / size);
    const cy = Math.floor(y / size);
    const chunks: [number, number][] = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) chunks.push([cx + dx, cy + dy]);
    this.raw(JSON.stringify({ t: "subscribe", chunks }));
  }

  disconnect(): void {
    this.closed = true;
    this.game.onClose(this);
  }

  own(): UnitView[] {
    return [...this.units.values()].filter((u) => u.owner === this.playerId);
  }
}

/** Advance the server until a predicate holds (or fail after maxTicks). */
export function runUntil(game: GameServer, pred: () => boolean, maxTicks: number, label: string): number {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return i;
    game.tickOnce();
  }
  if (pred()) return maxTicks;
  throw new Error(`Condition not reached within ${maxTicks} ticks: ${label}`);
}

export function stepWorld(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) world.step();
}
