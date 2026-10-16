import { test } from "node:test";
import assert from "node:assert/strict";
import { TestClient, makeServer, runUntil, testConfig } from "./helpers.ts";

test("two clients observe consistent shared state and each other's actions", () => {
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const b = new TestClient(game);
  b.hello("bob");
  assert.ok(a.playerId && b.playerId && a.playerId !== b.playerId);
  // Put one of Bob's units inside Alice's view by moving Alice's scout near Bob's base.
  const bobBase = b.spawn;
  const scout = a.own().find((u) => u.type === "scout")!;
  const s = world.units.get(scout.id)!;
  world.controlProgram(a.playerId, s.id, "stop");
  // Teleport for test setup only (not a client action).
  (world as unknown as { moveUnitTo: (u: unknown, x: number, y: number) => void }).moveUnitTo(s, bobBase.x + 3, bobBase.y + 3);
  world.markUnit(s);
  game.tickOnce();
  a.subscribeAround(bobBase.x, bobBase.y, 1);
  b.subscribeAround(bobBase.x, bobBase.y, 1);
  game.tickOnce();
  const bobUnitsSeenByAlice = [...a.units.values()].filter((u) => u.owner === b.playerId);
  assert.ok(bobUnitsSeenByAlice.length >= 1, "Alice sees Bob's units");
  assert.ok([...b.units.values()].some((u) => u.id === scout.id), "Bob sees Alice's scout");
  // Run for a while; positions both clients have for the same unit agree with the server.
  for (let i = 0; i < 100; i++) game.tickOnce();
  for (const [id, view] of a.units) {
    const u = world.units.get(id);
    if (!u || !b.units.has(id)) continue;
    assert.equal(view.x, u.x);
    assert.equal(b.units.get(id)!.x, u.x);
    assert.equal(b.units.get(id)!.y, view.y);
  }
  // Bob's construction is visible to Alice.
  const hall = [...b.buildings.values()].find((x) => x.owner === b.playerId)!;
  let placedId = 0;
  for (let dy = -6; dy <= 6 && !placedId; dy++) for (let dx = -6; dx <= 8 && !placedId; dx++) {
    if (!world.checkPlacement(b.playerId, "stockpile", hall.x + dx, hall.y + dy).ok) continue;
    const r = b.request({ t: "place_building", type: "stockpile", x: hall.x + dx, y: hall.y + dy });
    if (r[0]?.t === "ack") placedId = r[0].id ?? 0;
  }
  assert.ok(placedId);
  game.tickOnce();
  assert.ok(a.buildings.has(placedId), "Alice sees Bob's construction site");
  assert.equal(a.buildings.get(placedId)?.own, undefined, "but not its private details");
  game.stop();
});

test("players cannot modify unauthorised entities over the network", () => {
  const { game } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const b = new TestClient(game);
  b.hello("bob");
  const bobUnit = b.own()[0]!;
  const bobHall = [...b.buildings.values()][0]!;
  const tries: Record<string, unknown>[] = [
    { t: "unit_cmd", unitId: bobUnit.id, cmd: { kind: "stop" } },
    { t: "program_save", unitId: bobUnit.id, source: "wait(1)", run: true },
    { t: "program_control", unitId: bobUnit.id, action: "stop" },
    { t: "program_get", unitId: bobUnit.id },
    { t: "train", buildingId: bobHall.id, unitType: "worker" },
  ];
  for (const m of tries) {
    const r = a.request(m);
    assert.equal(r[0]?.t, "error", JSON.stringify(m));
    assert.equal((r[0] as { code: string }).code, "permission_denied", JSON.stringify(m));
  }
  game.stop();
});

test("hidden information is not exposed to other players", () => {
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const b = new TestClient(game);
  b.hello("bob");
  // Areas outside a player's vision are denied (no terrain, no entities).
  const before = a.chunks.size;
  a.subscribeAround(a.spawn.x + 64 * 20, a.spawn.y, 0);
  assert.equal(a.chunks.size, before, "no terrain for chunks outside vision");
  assert.ok(a.inbox.some((m) => m.t === "chunk_denied"));
  // Without a subscription covering Bob's base, Alice receives none of Bob's units.
  for (let i = 0; i < 20; i++) game.tickOnce();
  assert.ok(![...a.units.values()].some((u) => u.owner === b.playerId));
  // Own units carry private details; others never do.
  game.tickOnce();
  for (const u of a.units.values()) {
    if (u.owner === a.playerId) assert.ok(u.own);
    else assert.equal(u.own, undefined);
  }
  // Even when visible, other players' views have no inventory, program or log.
  const s = world.units.get(a.own().find((u) => u.type === "scout")!.id)!;
  (world as unknown as { moveUnitTo: (u: unknown, x: number, y: number) => void }).moveUnitTo(s, b.spawn.x + 2, b.spawn.y + 3);
  world.markUnit(s);
  game.tickOnce();
  a.subscribeAround(b.spawn.x, b.spawn.y, 0);
  game.tickOnce();
  const seen = [...a.units.values()].filter((u) => u.owner === b.playerId);
  assert.ok(seen.length > 0);
  for (const u of seen) {
    assert.equal(u.own, undefined);
    assert.equal("inventory" in u, false);
  }
  const raw = JSON.stringify(a.inbox);
  const bobSource = world.units.get(b.own()[0]!.id)!.program.source;
  assert.ok(!raw.includes(bobSource.slice(0, 40)), "Bob's program source never reaches Alice");
  game.stop();
});

test("duplicate economic requests do not duplicate effects", () => {
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const p = world.players.get(a.playerId)!;
  p.resources.food = 200;
  const hall = [...a.buildings.values()][0]!;
  const r1 = a.request({ t: "train", buildingId: hall.id, unitType: "worker" }, 77);
  const r2 = a.request({ t: "train", buildingId: hall.id, unitType: "worker" }, 77);
  assert.equal(r1[0]?.t, "ack");
  assert.deepEqual(r2, r1, "the same reqId returns the original response");
  assert.equal(p.resources.food, 160, "charged once");
  assert.equal(world.buildings.get(hall.id)!.queue.length, 1);
  game.stop();
});

test("a new connection's requests are carried out even when its reqIds were used before", () => {
  // Browsers number requests from 1 on every page load. A reloaded page must not be
  // answered with the previous page's replies (that once made hero recruitment and other
  // actions silently do nothing after a reload).
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const p = world.players.get(a.playerId)!;
  p.resources.food = 200;
  const hall = [...a.buildings.values()][0]!;
  assert.equal(a.request({ t: "overview_get", cx: 0, cy: 0, radius: 1 }, 3)[0]?.t, "overview");
  a.disconnect();
  const again = new TestClient(game);
  again.hello("alice", { token: a.token });
  const r = again.request({ t: "train", buildingId: hall.id, unitType: "worker" }, 3);
  assert.equal(r[0]?.t, "ack", JSON.stringify(r));
  assert.equal(p.resources.food, 160, "the training order was carried out");
  game.stop();
});

test("malformed and abusive messages are rejected", () => {
  const { game } = makeServer(":memory:", testConfig(":memory:", { messagesPerSecond: 5, messageBurst: 10 }));
  const a = new TestClient(game);
  a.raw("not json");
  a.raw(JSON.stringify({ t: "unit_cmd", reqId: 1, unitId: 1, cmd: { kind: "stop" } }));
  assert.ok(a.errors.some((e) => e.code === "bad_request"));
  assert.ok(a.errors.some((e) => e.code === "not_authenticated"));
  a.hello("alice");
  for (const bad of [
    { t: "unit_cmd", reqId: 5, unitId: "1", cmd: { kind: "stop" } },
    { t: "unit_cmd", reqId: 6, unitId: 1, cmd: { kind: "teleport" } },
    { t: "place_building", reqId: 7, type: "stockpile", x: 1e12, y: 0 },
    { t: "subscribe", chunks: [[1e9, 0]] },
    { t: "hack" },
  ]) a.raw(JSON.stringify(bad));
  assert.ok(a.errors.filter((e) => e.code === "bad_request").length >= 5);
  for (let i = 0; i < 50; i++) a.raw(JSON.stringify({ t: "ping", reqId: 1000 + i }));
  assert.ok(a.errors.some((e) => e.code === "rate_limited"));
  game.stop();
});

test("name rules, duplicate names and invalid tokens", () => {
  const { game } = makeServer();
  const a = new TestClient(game);
  a.hello("x");
  assert.equal(a.errors.at(-1)?.code, "bad_name");
  a.hello("alice", { race: "dragon" });
  assert.equal(a.errors.at(-1)?.code, "bad_race");
  a.hello("alice");
  assert.ok(a.playerId);
  const b = new TestClient(game);
  b.hello("ALICE");
  assert.equal(b.errors.at(-1)?.code, "name_taken");
  b.hello("whatever", { token: "forged-token" });
  assert.equal(b.errors.at(-1)?.code, "bad_token");
  game.stop();
});

test("reconnection restores state and replaces the old session", () => {
  const { game } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  runUntil(game, () => (a.player?.resources.wood ?? 0) > 50, 3000, "some wood");
  const a2 = new TestClient(game);
  a2.hello("", { token: a.token });
  assert.equal(a2.playerId, a.playerId);
  assert.ok(a.closed, "old session was closed");
  assert.ok(a.inbox.some((m) => m.t === "kicked"));
  assert.equal(a2.own().length, 3);
  assert.deepEqual(a2.player?.resources, game.world.players.get(a.playerId)?.resources);
  game.stop();
});

test("minimap overview covers only explored chunks and marks territory without leaking positions", () => {
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const b = new TestClient(game);
  b.hello("bob");
  const cs = world.chunks.size;
  const acx = Math.floor(a.spawn.x / cs);
  const acy = Math.floor(a.spawn.y / cs);
  const r = a.request({ t: "overview_get", cx: acx, cy: acy, radius: 12 })[0];
  assert.ok(r?.t === "overview");
  const explored = world.players.get(a.playerId)!.explored;
  assert.ok(r.chunks.length > 0);
  for (const [cx, cy, s] of r.chunks) {
    assert.ok(explored.has(`${cx},${cy}`), "only explored chunks are described");
    assert.equal(s.length, 64);
  }
  // The home chunk shows the player's own territory (owner flag 1) and its terrain matches the generator.
  const home = r.chunks.find(([cx, cy]) => cx === acx && cy === acy)!;
  assert.ok([...home[2]].some((ch) => Math.floor((ch.charCodeAt(0) - 48) / 8) === 1));
  assert.equal((home[2].charCodeAt(0) - 48) % 8, world.gen.terrainAt(acx * cs + 4, acy * cs + 4));
  // Only own buildings and units are listed.
  assert.equal(r.buildings.length, world.buildingsOf(a.playerId).size);
  assert.equal(r.units.length, world.unitsOf(a.playerId).size);
  // Bob's base is outside Alice's explored chunks: nothing about it is returned.
  const far = a.request({ t: "overview_get", cx: Math.floor(b.spawn.x / cs), cy: Math.floor(b.spawn.y / cs), radius: 1 })[0];
  assert.ok(far?.t === "overview");
  for (const [cx, cy] of far.chunks) assert.ok(explored.has(`${cx},${cy}`));
  // Oversized requests are rejected by validation.
  const big = a.request({ t: "overview_get", cx: 0, cy: 0, radius: 500 })[0];
  assert.ok(big?.t === "error");
  game.stop();
});

test("manual creature orders: targets outside your vision look exactly like missing ones", () => {
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const scout = a.own().find((u) => u.type === "scout")!;
  const near = world.spawnCreature("deer", a.spawn.x + 5, a.spawn.y + 5);
  const far = world.spawnCreature("deer", a.spawn.x + 64 * 30, a.spawn.y);
  const rFar = a.request({ t: "unit_cmd", unitId: scout.id, cmd: { kind: "observe", targetId: far.id } })[0];
  const rNone = a.request({ t: "unit_cmd", unitId: scout.id, cmd: { kind: "observe", targetId: 987654 } })[0];
  assert.ok(rFar?.t === "error" && rNone?.t === "error");
  assert.equal(rFar.code, rNone.code);
  assert.equal(rFar.message, rNone.message);
  const ok = a.request({ t: "unit_cmd", unitId: scout.id, cmd: { kind: "observe", targetId: near.id } })[0];
  assert.equal(ok?.t, "ack");
  game.stop();
});

test("a completed Watchtower extends the area a player may observe", () => {
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const cs = world.chunks.size;
  const hall = [...world.buildingsOf(a.playerId)].map((id) => world.buildings.get(id)!)[0]!;
  const hcx = Math.floor(hall.x / cs);
  const hcy = Math.floor(hall.y / cs);
  const r = testConfig().network.visionChunkRadius;
  // Units may wander; use a chunk just beyond normal vision on the far side from all units.
  const farKey = `${hcx + r + 2},${hcy}`;
  const unitsNear = a.own().some((u) => Math.abs(Math.floor(u.x / cs) - (hcx + r + 2)) <= r);
  assert.ok(!unitsNear);
  assert.ok(!game.allowedChunks(a.playerId).has(farKey), "beyond normal vision");
  const site = world.addBuilding(a.playerId, "watchtower", hall.x + 4, hall.y, false);
  assert.ok(!game.allowedChunks(a.playerId).has(farKey), "an unfinished tower sees nothing extra");
  site.complete = true;
  assert.ok(game.allowedChunks(a.playerId).has(farKey), "a completed tower adds 2 chunks of vision");
  game.stop();
});
