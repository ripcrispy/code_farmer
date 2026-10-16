/**
 * Headless smoke-test client. Drives a running server through the core player loop
 * over a real WebSocket connection:
 *
 *   connect -> receive 3 units -> run a custom program -> gather & deposit ->
 *   place a Stockpile -> builder completes it -> train a Worker ->
 *   disconnect -> reconnect with the saved token -> verify state restored.
 *
 * Usage: npm run smoke -- [ws://127.0.0.1:3001/ws] [botName]
 * Exits non-zero on failure. Uses the WebSocket built into Node >= 22.
 */
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type UnitView, type BuildingView, type PlayerView } from "../src/shared/protocol.ts";

const url = process.argv[2] ?? "ws://127.0.0.1:3001/ws";
const name = process.argv[3] ?? `bot${Math.floor(Math.random() * 1e6)}`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);

interface State {
  playerId: number;
  token: string;
  spawn: { x: number; y: number };
  chunkSize: number;
  units: Map<number, UnitView>;
  buildings: Map<number, BuildingView>;
  player: PlayerView | null;
  chunks: number;
  errors: string[];
}

class Client {
  ws!: WebSocket;
  state: State = { playerId: 0, token: "", spawn: { x: 0, y: 0 }, chunkSize: 64, units: new Map(), buildings: new Map(), player: null, chunks: 0, errors: [] };
  private reqId = 1;
  private waiters: { pred: () => boolean; resolve: () => void }[] = [];
  private replies = new Map<number, (m: ServerMessage) => void>();

  connect(hello: { name: string; token?: string; race?: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        const msg: ClientMessage = { t: "hello", v: PROTOCOL_VERSION, name: hello.name };
        if (hello.token) msg.token = hello.token;
        if (hello.race) msg.race = hello.race;
        this.ws.send(JSON.stringify(msg));
      };
      this.ws.onerror = () => reject(new Error(`Could not connect to ${url}`));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMessage;
        this.onMessage(m);
        if (m.t === "welcome") resolve();
        if (m.t === "error" && m.reqId === undefined && this.state.playerId === 0) reject(new Error(`${m.code}: ${m.message}`));
      };
    });
  }

  private onMessage(m: ServerMessage): void {
    const s = this.state;
    switch (m.t) {
      case "welcome":
        s.playerId = m.playerId;
        s.token = m.token;
        s.spawn = m.spawn;
        s.chunkSize = m.world.chunkSize;
        break;
      case "tick":
        for (const u of m.units ?? []) {
          const prev = s.units.get(u.id);
          if (u.own && prev?.own) {
            u.own.log ??= prev.own.log;
            u.own.trace ??= prev.own.trace;
          }
          s.units.set(u.id, u);
        }
        for (const b of m.buildings ?? []) s.buildings.set(b.id, b);
        for (const id of m.removedUnits ?? []) s.units.delete(id);
        for (const id of m.removedBuildings ?? []) s.buildings.delete(id);
        if (m.player) s.player = m.player;
        break;
      case "chunk":
        s.chunks++;
        break;
      case "error":
        s.errors.push(`${m.code}: ${m.message}`);
        break;
      default:
        break;
    }
    if ("reqId" in m && typeof m.reqId === "number") {
      const r = this.replies.get(m.reqId);
      if (r) {
        this.replies.delete(m.reqId);
        r(m);
      }
    }
    this.waiters = this.waiters.filter((w) => {
      if (w.pred()) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  request(msg: Record<string, unknown>): Promise<ServerMessage> {
    const reqId = this.reqId++;
    return new Promise((resolve) => {
      this.replies.set(reqId, resolve);
      this.ws.send(JSON.stringify({ ...msg, reqId }));
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(label: string, pred: () => boolean, timeoutMs = TIMEOUT_MS): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting for: ${label}`)), timeoutMs);
      this.waiters.push({ pred, resolve: () => { clearTimeout(t); resolve(); } });
    });
  }

  ownUnits(): UnitView[] {
    return [...this.state.units.values()].filter((u) => u.owner === this.state.playerId);
  }
  ownBuildings(): BuildingView[] {
    return [...this.state.buildings.values()].filter((b) => b.owner === this.state.playerId);
  }
  close(): Promise<void> {
    return new Promise((r) => {
      this.ws.onclose = () => r();
      this.ws.close();
    });
  }
}

function step(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const c = new Client();
  await c.connect({ name, race: "dwarf" });
  step(`connected as ${name} (player #${c.state.playerId}), spawn ${c.state.spawn.x},${c.state.spawn.y}`);
  await c.waitFor("3 starting units", () => c.ownUnits().length === 3, 5000);
  step(`starting units: ${c.ownUnits().map((u) => `${u.type}#${u.id}`).join(", ")}`);
  const cs = c.state.chunkSize;
  const scx = Math.floor(c.state.spawn.x / cs);
  const scy = Math.floor(c.state.spawn.y / cs);
  const chunks: [number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) chunks.push([scx + dx, scy + dy]);
  c.send({ t: "subscribe", chunks });
  await c.waitFor("chunks", () => c.state.chunks >= 9, 5000);
  step(`received ${c.state.chunks} chunks`);

  // Program the woodcutter with a custom script and confirm it runs.
  const wc = c.ownUnits().find((u) => u.type === "woodcutter");
  if (!wc) throw new Error("no woodcutter");
  const custom = `print("custom program v1 starting at", me.x, me.y)
while alive:
    if inventory.is_full():
        deposit()
    else:
        t = find_nearest("tree")
        if t is None:
            explore()
        else:
            harvest(t)
`;
  const saved = await c.request({ t: "program_save", unitId: wc.id, source: custom, run: true });
  if (saved.t !== "ack") throw new Error(`program_save failed: ${JSON.stringify(saved)}`);
  step(`saved and started custom program (${saved.message})`);
  const bad = await c.request({ t: "program_save", unitId: wc.id, source: "while alive\n    pass", run: false });
  if (bad.t !== "error" || bad.code !== "syntax_error") throw new Error("syntax error was not rejected");
  step(`invalid program rejected with: ${bad.message}`);
  await c.waitFor("custom program log", () => (c.state.units.get(wc.id)?.own?.log ?? []).some((l) => l.includes("custom program v1")), 10_000);
  step("custom program is running (log line observed)");

  await c.waitFor("woodcutter deposits wood", () => (c.state.player?.resources.wood ?? 0) > 50, 90_000);
  step(`wood deposited: stock now ${JSON.stringify(c.state.player?.resources)}`);

  // Place a stockpile next to the town hall.
  const hall = c.ownBuildings().find((b) => b.type === "town_hall");
  if (!hall) throw new Error("no town hall");
  let placedId = 0;
  const spots: [number, number][] = [];
  for (let r = 1; r <= 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) spots.push([hall.x + 1 + dx * 2, hall.y + 1 + dy * 2]);
  for (const [x, y] of spots) {
    const r = await c.request({ t: "place_building", type: "stockpile", x, y });
    if (r.t === "ack" && r.id) {
      placedId = r.id;
      step(`stockpile #${placedId} placed at ${x},${y}`);
      break;
    }
  }
  if (!placedId) throw new Error(`could not place a stockpile: ${c.state.errors.slice(-3).join("; ")}`);
  await c.waitFor("construction site visible", () => c.state.buildings.has(placedId), 5000);
  const site = c.state.buildings.get(placedId) as BuildingView;
  const dup = await c.request({ t: "place_building", type: "stockpile", x: site.x + 1, y: site.y });
  if (dup.t !== "error") throw new Error("overlapping placement was accepted");
  step(`overlapping placement rejected: ${dup.message}`);
  await c.waitFor("stockpile completed by builder", () => c.state.buildings.get(placedId)?.complete === true, 120_000);
  step("stockpile completed by the builder's default program");

  // Train a worker.
  await c.waitFor("40 food", () => (c.state.player?.resources.food ?? 0) >= 40, 5000);
  const tr = await c.request({ t: "train", buildingId: hall.id, unitType: "worker" });
  if (tr.t !== "ack") throw new Error(`train failed: ${JSON.stringify(tr)}`);
  step("worker training queued");
  await c.waitFor("4 units", () => c.ownUnits().length === 4, 60_000);
  step(`worker trained: ${c.ownUnits().map((u) => `${u.type}#${u.id}`).join(", ")}`);

  const before = { units: c.ownUnits().length, buildings: c.ownBuildings().length, token: c.state.token, pid: c.state.playerId };
  await c.close();
  step("disconnected");

  const c2 = new Client();
  await c2.connect({ name, token: before.token });
  await c2.waitFor("own entities restored", () => c2.ownUnits().length === before.units && c2.ownBuildings().length === before.buildings, 5000);
  if (c2.state.playerId !== before.pid) throw new Error("reconnected as a different player");
  step(`reconnected with token: ${c2.ownUnits().length} units, ${c2.ownBuildings().length} buildings, resources ${JSON.stringify(c2.state.player?.resources)}`);
  const progs = c2.ownUnits().map((u) => `${u.type}:${u.own?.program.state}`).join(", ");
  step(`program states: ${progs}`);
  await c2.close();
  step(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`[smoke] FAIL: ${(e as Error).message}`);
  process.exit(1);
});
