import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type ServerMessage } from "../src/shared/protocol.ts";
import { startTransport } from "../src/server/transport.ts";
import { silentLogger } from "../src/server/logger.ts";
import { TestClient, makeServer, runUntil, testConfig } from "./helpers.ts";

test("full player loop: connect, program, gather, deposit, build, train, expand, disconnect, reconnect", () => {
  const { game, world } = makeServer();
  const c = new TestClient(game);
  c.hello("loop", { race: "troll" });
  assert.equal(c.own().length, 3);
  c.subscribeAround(c.spawn.x, c.spawn.y, 1);
  assert.equal(c.chunks.size, 9);
  // Inspect a unit's program.
  const wc = c.own().find((u) => u.type === "woodcutter")!;
  const prog = c.request({ t: "program_get", unitId: wc.id })[0];
  assert.equal(prog?.t, "program");
  assert.match((prog as { source: string }).source, /while alive/);
  // Assign a custom program.
  const src = "while alive:\n    if inventory.is_full():\n        deposit()\n    else:\n        harvest(find_nearest('tree'))\n";
  assert.equal(c.request({ t: "program_save", unitId: wc.id, source: src, run: true })[0]?.t, "ack");
  // Units gather and deposit.
  runUntil(game, () => (c.player?.resources.wood ?? 0) >= 90, 6000, "wood >= 90");
  // Build a farm (60 wood) and a stockpile (40 wood).
  const hall = [...c.buildings.values()].find((b) => b.type === "town_hall")!;
  const placeNear = (type: string): number => {
    for (let r = 2; r <= 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (!world.checkPlacement(c.playerId, type, hall.x + dx, hall.y + dy).ok) continue;
      const res = c.request({ t: "place_building", type, x: hall.x + dx, y: hall.y + dy })[0];
      if (res?.t === "ack" && res.id) return res.id;
    }
    return 0;
  };
  const farmId = placeNear("farm");
  assert.ok(farmId, "farm placed");
  runUntil(game, () => c.buildings.get(farmId)?.complete === true, 6000, "farm completed by builder");
  // The farm produces food over time.
  const food0 = c.player!.resources.food;
  runUntil(game, () => c.player!.resources.food > food0 + 3, 1000, "farm produces food");
  // Train a worker.
  runUntil(game, () => c.player!.resources.food >= 40, 3000, "food for worker");
  assert.equal(c.request({ t: "train", buildingId: hall.id, unitType: "worker" })[0]?.t, "ack");
  runUntil(game, () => c.own().length === 4, 400, "worker trained");
  // Expansion: the scout's default program explores beyond the starting area.
  runUntil(game, () => {
    const s = c.own().find((u) => u.type === "scout")!;
    return Math.max(Math.abs(s.x - c.spawn.x), Math.abs(s.y - c.spawn.y)) > 40;
  }, 3000, "scout explores beyond the start area");
  // Disconnect and reconnect.
  const token = c.token;
  const pid = c.playerId;
  c.disconnect();
  for (let i = 0; i < 20; i++) game.tickOnce();
  const c2 = new TestClient(game);
  c2.hello("", { token });
  assert.equal(c2.playerId, pid);
  assert.equal(c2.own().length, 4);
  assert.ok([...c2.buildings.values()].some((b) => b.id === farmId && b.complete));
  game.stop();
});

test("two real WebSocket clients share one server", async () => {
  const cfg = testConfig();
  cfg.server.port = 0;
  const { game } = makeServer(":memory:", cfg);
  const t = await startTransport(game, cfg, silentLogger);
  game.start();
  const url = `ws://127.0.0.1:${t.port}/ws`;
  const connect = (name: string): Promise<{ ws: WebSocket; msgs: ServerMessage[]; id: number }> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const msgs: ServerMessage[] = [];
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, name }));
      ws.onerror = () => reject(new Error("ws error"));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMessage;
        msgs.push(m);
        if (m.t === "welcome") resolve({ ws, msgs, id: m.playerId });
      };
    });
  try {
    const a = await connect("ws-alice");
    const b = await connect("ws-bob");
    assert.notEqual(a.id, b.id);
    // Bob's units are within Alice's vision radius: subscribe to Bob's area and observe them.
    const bobWelcome = b.msgs.find((m) => m.t === "welcome") as Extract<ServerMessage, { t: "welcome" }>;
    const cx = Math.floor(bobWelcome.spawn.x / 64);
    const cy = Math.floor(bobWelcome.spawn.y / 64);
    a.ws.send(JSON.stringify({ t: "subscribe", chunks: [[cx, cy]] }));
    await new Promise((r) => setTimeout(r, 600));
    const sawChunk = a.msgs.some((m) => m.t === "chunk" || m.t === "chunk_denied");
    assert.ok(sawChunk);
    const ticks = a.msgs.filter((m) => m.t === "tick").length;
    assert.ok(ticks >= 3, `received ${ticks} tick messages`);
    if (a.msgs.some((m) => m.t === "chunk")) {
      const bobUnits = a.msgs.flatMap((m) => (m.t === "tick" ? (m.units ?? []) : [])).filter((u) => u.owner === b.id);
      assert.ok(bobUnits.length > 0, "Alice observes Bob's units over the network");
      assert.ok(bobUnits.every((u) => u.own === undefined));
    }
    a.ws.close();
    b.ws.close();
  } finally {
    game.stop();
    await t.close();
  }
});

test("HTTP endpoints: public /health, admin status only with the right bearer token", async () => {
  const cfg = testConfig();
  cfg.server.port = 0;
  cfg.admin.token = "s3cret-admin-token";
  const { game } = makeServer(":memory:", cfg);
  const t = await startTransport(game, cfg, silentLogger);
  try {
    const base = `http://127.0.0.1:${t.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
    assert.equal((await fetch(`${base}/admin/status`)).status, 401);
    assert.equal((await fetch(`${base}/admin/status`, { headers: { authorization: "Bearer wrong-token-same-len" } })).status, 401);
    const ok = await fetch(`${base}/admin/status`, { headers: { authorization: "Bearer s3cret-admin-token" } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    for (const k of ["tick", "units", "tickMs", "pathSearches", "internalErrors", "wildlife", "persistence"]) assert.ok(k in body, `status has ${k}`);
    assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 405);
  } finally {
    await t.close();
    game.stop();
  }
  // Without a configured token the endpoint is disabled.
  const cfg2 = testConfig();
  cfg2.server.port = 0;
  const s2 = makeServer(":memory:", cfg2);
  const t2 = await startTransport(s2.game, cfg2, silentLogger);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${t2.port}/admin/status`)).status, 404);
  } finally {
    await t2.close();
    s2.game.stop();
  }
});
