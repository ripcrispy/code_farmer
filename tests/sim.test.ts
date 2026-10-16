import { test } from "node:test";
import assert from "node:assert/strict";
import { bagTotal } from "../src/shared/defs/resources.ts";
import { unitDef } from "../src/shared/defs/units.ts";
import { BALANCE } from "../src/shared/defs/balance.ts";
import { findPath } from "../src/sim/pathfinding.ts";
import type { UnitState } from "../src/sim/types.ts";
import { World } from "../src/sim/world.ts";
import { compileSource } from "../src/script/compiler.ts";
import { makeWorld, stepWorld } from "./helpers.ts";

function setup(): { w: World; pid: number; units: UnitState[] } {
  const w = makeWorld();
  const r = w.createPlayer(1, "alice", "high_elf");
  assert.ok(r.ok);
  const units = [...w.unitsOf(1)].map((id) => w.units.get(id) as UnitState);
  // Stop default programs so tests control units directly.
  for (const u of units) w.controlProgram(1, u.id, "stop");
  return { w, pid: 1, units };
}

function nearestNode(w: World, u: UnitState, kind: string): { x: number; y: number } {
  const ref = w.findNearest(u, kind);
  assert.ok(ref, `no ${kind} near unit`);
  return { x: ref.x, y: ref.y };
}

test("a new player starts with exactly three units, a town hall and starting resources", () => {
  const { w, units } = setup();
  assert.equal(units.length, 3);
  assert.deepEqual(units.map((u) => u.type).sort(), ["builder", "scout", "woodcutter"]);
  const halls = [...w.buildings.values()].filter((b) => b.owner === 1);
  assert.equal(halls.length, 1);
  assert.equal(halls[0]?.type, "town_hall");
  assert.equal(halls[0]?.complete, true);
  assert.deepEqual(w.players.get(1)?.resources, BALANCE.startingResources);
});

test("players spawn apart from each other", () => {
  const w = makeWorld();
  assert.ok(w.createPlayer(1, "a", "human").ok);
  assert.ok(w.createPlayer(2, "b", "orc").ok);
  const a = w.players.get(1)!;
  const b = w.players.get(2)!;
  assert.ok(Math.max(Math.abs(a.spawnX - b.spawnX), Math.abs(a.spawnY - b.spawnY)) >= BALANCE.spawnSeparation);
});

test("gathering reduces the node, respects capacity, and depositing transfers to stock", () => {
  const { w, units } = setup();
  const u = units.find((x) => x.type === "woodcutter")!;
  const cap = unitDef(u.type).capacity;
  const t = nearestNode(w, u, "tree");
  const before = w.chunks.nodeAt(t.x, t.y)!.amount;
  assert.ok(w.commandUnit(1, u.id, { kind: "gather", x: t.x, y: t.y }).ok);
  stepWorld(w, 600);
  const after = w.chunks.nodeAt(t.x, t.y)?.amount ?? 0;
  const carried = bagTotal(u.inventory);
  assert.ok(carried > 0 && carried <= cap, `carried ${carried}`);
  assert.equal(before - after, carried, "resources are conserved between node and inventory");
  const stockBefore = w.players.get(1)!.resources.wood;
  assert.ok(w.commandUnit(1, u.id, { kind: "deposit" }).ok);
  stepWorld(w, 600);
  assert.equal(bagTotal(u.inventory), 0);
  assert.equal(w.players.get(1)!.resources.wood, stockBefore + carried);
});

test("gathering stops when inventory is full", () => {
  const { w, units } = setup();
  const u = units.find((x) => x.type === "woodcutter")!;
  u.inventory.stone = unitDef(u.type).capacity;
  const t = nearestNode(w, u, "tree");
  const r = w.commandUnit(1, u.id, { kind: "gather", x: t.x, y: t.y });
  assert.ok(!r.ok && r.code === "inventory_full");
});

test("exhausted deposits cannot be harvested", () => {
  const { w, units } = setup();
  const u = units[0]!;
  const t = nearestNode(w, u, "tree");
  w.chunks.takeFromNode(t.x, t.y, 10_000);
  assert.equal(w.chunks.nodeAt(t.x, t.y), undefined);
  const r = w.commandUnit(1, u.id, { kind: "gather", x: t.x, y: t.y });
  assert.ok(!r.ok && r.code === "no_resource");
  assert.ok(w.isPassable(t.x, t.y), "an exhausted node frees its tile");
});

test("construction cost is charged exactly once and incompatible placements are rejected", () => {
  const { w } = setup();
  const p = w.players.get(1)!;
  const hall = [...w.buildings.values()][0]!;
  p.resources.wood = 100;
  let placed: { x: number; y: number } | null = null;
  outer: for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
    const x = hall.x + 4 + dx;
    const y = hall.y + dy;
    if (w.checkPlacement(1, "stockpile", x, y).ok) {
      placed = { x, y };
      break outer;
    }
  }
  assert.ok(placed, "found a free spot");
  const r1 = w.placeBuilding(1, "stockpile", placed.x, placed.y);
  assert.ok(r1.ok);
  assert.equal(p.resources.wood, 60);
  const r2 = w.placeBuilding(1, "stockpile", placed.x, placed.y);
  assert.ok(!r2.ok && r2.code === "occupied");
  assert.equal(p.resources.wood, 60, "failed placement charges nothing");
  // Overlap with the town hall
  const r3 = w.placeBuilding(1, "stockpile", hall.x, hall.y);
  assert.ok(!r3.ok);
  // Outside territory
  const r4 = w.placeBuilding(1, "stockpile", hall.x + 200, hall.y);
  assert.ok(!r4.ok && r4.code === "outside_territory", JSON.stringify(r4));
  // Insufficient resources
  p.resources.wood = 5;
  const r5 = w.checkPlacement(1, "farm", hall.x + 5, hall.y + 6);
  assert.ok(!r5.ok);
  // Unknown and prototype-named types are rejected
  for (const t of ["castle", "constructor", "__proto__", "toString"]) {
    const r = w.placeBuilding(1, t, placed.x + 3, placed.y);
    assert.ok(!r.ok && r.code === "bad_type", t);
  }
  // Prerequisite missing (Town Halls need Civic Planning)
  const r6 = w.placeBuilding(1, "town_hall", placed.x + 3, placed.y);
  assert.ok(!r6.ok && r6.code === "missing_prerequisite");
});

test("builders complete construction and the building then works as storage", () => {
  const { w, units } = setup();
  const p = w.players.get(1)!;
  const hall = [...w.buildings.values()][0]!;
  let site = null;
  for (let dy = -6; dy <= 6 && !site; dy++) for (let dx = -6; dx <= 8 && !site; dx++) {
    if (!w.checkPlacement(1, "stockpile", hall.x + dx, hall.y + dy).ok) continue;
    const r = w.placeBuilding(1, "stockpile", hall.x + dx, hall.y + dy);
    if (r.ok) site = r.value;
  }
  assert.ok(site, "found a free spot");
  const builder = units.find((u) => u.type === "builder")!;
  assert.ok(w.commandUnit(1, builder.id, { kind: "build", buildingId: site.id }).ok);
  stepWorld(w, 400);
  assert.equal(site.complete, true);
  assert.equal(builder.task.kind, "idle");
  // The new stockpile accepts deposits.
  builder.inventory.stone = 5;
  const stone0 = p.resources.stone;
  assert.ok(w.commandUnit(1, builder.id, { kind: "deposit" }).ok);
  stepWorld(w, 100);
  assert.equal(p.resources.stone, stone0 + 5);
});

test("movement respects terrain and obstacles; unreachable targets fail cleanly", () => {
  const { w, units } = setup();
  const u = units.find((x) => x.type === "scout")!;
  // Find a water tile near the spawn and order a move onto it.
  let water: { x: number; y: number } | null = null;
  for (let r = 1; r < 60 && !water; r++) for (let dy = -r; dy <= r && !water; dy++) for (let dx = -r; dx <= r; dx++) {
    if (w.chunks.terrainAt(u.x + dx, u.y + dy) === 0) {
      water = { x: u.x + dx, y: u.y + dy };
      break;
    }
  }
  if (water) {
    assert.ok(w.commandUnit(1, u.id, { kind: "move", x: water.x, y: water.y }).ok);
    stepWorld(w, 5);
    assert.equal(u.task.kind, "idle");
    assert.match(u.blocked, /blocked/);
  }
  // Pathfinding around a wall
  const passable = (x: number, y: number): boolean => !(x === 5 && y >= -3 && y <= 3);
  const res = findPath({ sx: 0, sy: 0, goal: { x: 10, y: 0, w: 1, h: 1 }, range: 0, radius: 20, passable });
  assert.ok(res.ok);
  if (res.ok) {
    assert.ok(res.path.every((p) => passable(p.x, p.y)));
    assert.deepEqual(res.path.at(-1), { x: 10, y: 0 });
  }
  const boxed = findPath({ sx: 0, sy: 0, goal: { x: 10, y: 0, w: 1, h: 1 }, range: 0, radius: 20, passable: (x, y) => Math.abs(x) <= 1 && Math.abs(y) <= 1 });
  assert.ok(!boxed.ok && /unreachable/.test(boxed.reason));
  // The unit walks along a valid path and its authoritative position changes
  const start = { x: u.x, y: u.y };
  let target: { x: number; y: number } | null = null;
  for (let d = 6; d < 12 && !target; d++) if (w.isPassable(u.x + d, u.y)) target = { x: u.x + d, y: u.y };
  if (target) {
    assert.ok(w.commandUnit(1, u.id, { kind: "move", x: target.x, y: target.y }).ok);
    for (let i = 0; i < 200 && u.task.kind !== "idle"; i++) {
      w.step();
      assert.ok(w.isPassable(u.x, u.y) || (u.x === start.x && u.y === start.y), "never stands on a blocked tile");
    }
    assert.deepEqual({ x: u.x, y: u.y }, target);
  }
});

test("players cannot command or reprogram other players' units", () => {
  const w = makeWorld();
  w.createPlayer(1, "a", "human");
  w.createPlayer(2, "b", "human");
  const theirs = [...w.unitsOf(2)][0]!;
  const r1 = w.commandUnit(1, theirs, { kind: "stop" });
  assert.ok(!r1.ok && r1.code === "permission_denied");
  const r2 = w.setProgram(1, theirs, "wait(1)", 1);
  assert.ok(!r2.ok && r2.code === "permission_denied");
  const r3 = w.controlProgram(1, theirs, "stop");
  assert.ok(!r3.ok && r3.code === "permission_denied");
  const hall2 = [...w.buildingsOf(2)][0]!;
  const r4 = w.trainUnit(1, hall2, "worker");
  assert.ok(!r4.ok && r4.code === "permission_denied");
});

test("training a unit charges its cost once and spawns it with its default program", () => {
  const { w } = setup();
  const hall = [...w.buildings.values()][0]!;
  const p = w.players.get(1)!;
  p.resources.food = 100;
  assert.ok(w.trainUnit(1, hall.id, "worker").ok);
  assert.equal(p.resources.food, 60);
  stepWorld(w, unitDef("worker").trainTime * w.cfg.tickRate + 2);
  const workers = [...w.unitsOf(1)].map((id) => w.units.get(id)!).filter((u) => u.type === "worker");
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.program.state, "running");
  p.resources.food = 10;
  const r = w.trainUnit(1, hall.id, "worker");
  assert.ok(!r.ok && r.code === "insufficient_resources");
  const r2 = w.trainUnit(1, hall.id, "constructor");
  assert.ok(!r2.ok && r2.code === "bad_type");
});

test("programs drive real gathering: a custom script deposits wood into the stockpile", () => {
  const { w, units } = setup();
  const u = units.find((x) => x.type === "woodcutter")!;
  const src = `loads = 0
while loads < 2:
    t = find_nearest("tree")
    harvest(t)
    if deposit():
        loads += 1
print("done", loads)
`;
  assert.ok(compileSource(src).ok);
  assert.ok(w.setProgram(1, u.id, src, 1).ok);
  assert.ok(w.controlProgram(1, u.id, "run").ok);
  const wood0 = w.players.get(1)!.resources.wood;
  stepWorld(w, 3000);
  assert.equal(u.program.state, "finished", u.log.join("\n"));
  assert.ok(u.log.some((l) => l.includes("done 2")));
  assert.equal(w.players.get(1)!.resources.wood, wood0 + 2 * unitDef(u.type).capacity);
});

test("programs can be paused, resumed and stopped; failed scripts leave state consistent", () => {
  const { w, units } = setup();
  const u = units.find((x) => x.type === "woodcutter")!;
  assert.ok(w.setProgram(1, u.id, "n = 0\nwhile alive:\n    n += 1\n    wait(0.1)\n", 1).ok);
  assert.ok(w.controlProgram(1, u.id, "run").ok);
  stepWorld(w, 10);
  assert.ok(w.controlProgram(1, u.id, "pause").ok);
  const vm = u.vm;
  stepWorld(w, 10);
  assert.equal(u.program.state, "paused");
  assert.ok(w.controlProgram(1, u.id, "resume").ok);
  assert.equal(u.vm, vm, "resume continues the same VM");
  assert.ok(w.controlProgram(1, u.id, "stop").ok);
  assert.equal(u.vm, null);
  // A crashing program goes to error state; resources and position stay valid.
  const res0 = { ...w.players.get(1)!.resources };
  assert.ok(w.setProgram(1, u.id, "x = None\nharvest(x)\n", 2).ok);
  assert.ok(w.controlProgram(1, u.id, "run").ok);
  stepWorld(w, 5);
  assert.equal(u.program.state, "error");
  assert.equal(u.program.error?.line, 2);
  assert.match(u.program.error?.message ?? "", /None/);
  assert.deepEqual(w.players.get(1)!.resources, res0);
  assert.equal(u.task.kind, "idle", "unit is not frozen");
  // ...and it can be fixed and rerun.
  assert.ok(w.setProgram(1, u.id, "wait(1)\n", 3).ok);
  assert.ok(w.controlProgram(1, u.id, "run").ok);
  stepWorld(w, 20);
  assert.equal(u.program.state, "finished");
});

test("syntax errors are rejected when saving", () => {
  const { w, units } = setup();
  const r = w.setProgram(1, units[0]!.id, "while alive\n  pass\n", 1);
  assert.ok(!r.ok && r.code === "syntax_error" && /Line 1/.test(r.message));
});

test("units recover from invalid script actions", () => {
  const { w, units } = setup();
  const u = units[0]!;
  assert.ok(w.setProgram(1, u.id, "r = move_to(5000000, 0)\nprint('result', r)\nr2 = deposit()\nprint('deposit', r2)\n", 1).ok);
  assert.ok(w.controlProgram(1, u.id, "run").ok);
  stepWorld(w, 20);
  assert.equal(u.program.state, "finished", u.log.join("\n"));
  assert.ok(u.log.some((l) => l.includes("result False")));
  assert.ok(u.log.some((l) => l.includes("deposit False")));
  assert.ok(u.log.some((l) => /Nothing to deposit/.test(l)));
});

test("an infinite script loop cannot stall the simulation", () => {
  const { w, units } = setup();
  for (const u of units) {
    assert.ok(w.setProgram(1, u.id, "while True:\n    x = 1\n", 1).ok);
    assert.ok(w.controlProgram(1, u.id, "run").ok);
  }
  const t0 = performance.now();
  stepWorld(w, 200);
  assert.ok(performance.now() - t0 < 3000);
  for (const u of units) assert.equal(u.program.state, "error");
});

test("the global script budget defers units fairly instead of overrunning a tick", () => {
  const w = makeWorld();
  (w.cfg as { scriptOpsPerTick: number }).scriptOpsPerTick = 500;
  w.createPlayer(1, "a", "human");
  for (const id of w.unitsOf(1)) {
    w.setProgram(1, id, "i = 0\nwhile i < 100000:\n    i += 1\n    if i % 50 == 0:\n        wait(0)\n", 1);
    w.controlProgram(1, id, "run");
  }
  w.step();
  assert.ok(w.stats.scriptOps <= 500 + 50);
  assert.ok(w.stats.scriptUnitsDeferred > 0);
  let ranTotal = 0;
  for (let i = 0; i < 10; i++) {
    w.step();
    ranTotal += w.stats.scriptUnitsRun;
  }
  assert.ok(ranTotal >= 10);
});

test("scripts automate construction: find_build_spot + place, and training", () => {
  const { w, units } = setup();
  const p = w.players.get(1)!;
  p.resources.wood = 200;
  p.resources.food = 100;
  const b = units.find((x) => x.type === "builder")!;
  const src = `spot = find_build_spot("stockpile")
site = place("stockpile", spot)
print("site", site.kind)
build(site)
ok = train_unit("worker")
print("trained", ok, count_units("worker"), stock_all()["wood"])
bad = place("stockpile", 999999, 0)
print("bad", bad)
`;
  assert.ok(w.setProgram(1, b.id, src, 1).ok);
  assert.ok(w.controlProgram(1, b.id, "run").ok);
  stepWorld(w, 400);
  assert.equal(b.program.state, "finished", b.log.join("\n"));
  assert.ok(b.log.some((l) => l.includes("site construction")));
  assert.ok(b.log.some((l) => l.includes("trained True 1 160")), b.log.join("\n"));
  assert.ok(b.log.some((l) => l.includes("bad None")));
  const stockpiles = [...w.buildingsOf(1)].map((id) => w.buildings.get(id)!).filter((x) => x.type === "stockpile");
  assert.equal(stockpiles.length, 1);
  assert.equal(stockpiles[0]!.complete, true);
  // The trace records each action with its result.
  assert.ok(b.trace.some((e) => e.call.startsWith("place(") && e.ok));
  assert.ok(b.trace.some((e) => e.call.startsWith("place(") && !e.ok && /Cannot build|Too far|territory/i.test(e.result)), JSON.stringify(b.trace));
});

test("units far beyond the pathfinding radius travel home in legs", () => {
  const { w, units } = setup();
  const u = units.find((x) => x.type === "scout")!;
  const p = w.players.get(1)!;
  // Find a tile roughly 100-150 tiles from home with a sensible (non-maze) route back, and
  // teleport the scout there (test setup only). The route exists; the unit must find it itself.
  const hall = [...w.buildingsOf(1)].map((id) => w.buildings.get(id)!)[0]!;
  let spot: { x: number; y: number } | null = null;
  for (let r = 100; r < 150 && !spot; r += 7) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      const x = p.spawnX + dx * r;
      const y = p.spawnY + dy * r;
      if (!w.isPassable(x, y)) continue;
      const route = findPath({ sx: x, sy: y, goal: hall, range: 1, radius: 200, passable: (px, py) => w.isPassable(px, py) });
      if (route.ok && route.path.length < r * 1.6) {
        spot = { x, y };
        break;
      }
    }
  }
  assert.ok(spot, "found a far spot with a route home");
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, spot.x, spot.y);
  u.inventory.wood = 5;
  const wood0 = p.resources.wood;
  assert.ok(w.commandUnit(1, u.id, { kind: "deposit" }).ok);
  for (let i = 0; i < 3000 && u.task.kind !== "idle"; i++) w.step();
  assert.equal(u.blocked, "", `deposit should succeed, got: ${u.blocked}`);
  assert.equal(p.resources.wood, wood0 + 5);
});

test("regression: re-planning to a nearby goal after a failed short search never crashes", () => {
  // Server crash 2026-10-10: unit and goal in the same coarse cell with the short search skipped
  // (it had failed before) made the coarse router return an empty route, which was indexed.
  const w = makeWorld();
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  const u = [...w.unitsOf(1)].map((id) => w.units.get(id)!)[0]!;
  type Plan = (u: UnitState, goal: { x: number; y: number; w: number; h: number }, range: number, allowWide: boolean, skipNarrow: boolean) => { ok: boolean };
  const plan = (w as unknown as { planPathNow: Plan }).planPathNow.bind(w);
  for (const [dx, dy] of [[0, 0], [1, 0], [2, 1], [-1, -1], [3, 3]] as const) {
    (w as unknown as { wideSearchesThisTick: number }).wideSearchesThisTick = 0;
    const r = plan(u, { x: u.x + dx, y: u.y + dy, w: 1, h: 1 }, 1, true, true);
    assert.equal(typeof r.ok, "boolean");
  }
});

test("an internal error in one unit's update is contained: the world keeps running", () => {
  const w = makeWorld();
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  const [a, b] = [...w.unitsOf(1)].map((id) => w.units.get(id)!);
  const errors: string[] = [];
  w.onInternalError = (msg) => errors.push(msg);
  const internal = w as unknown as { updateUnit: (u: UnitState) => void };
  const original = internal.updateUnit.bind(w);
  internal.updateUnit = (u: UnitState) => {
    if (u.id === a!.id) throw new TypeError("simulated bug");
    original(u);
  };
  const t0 = w.tick;
  const bx = b!.x;
  const by = b!.y;
  for (let i = 0; i < 30; i++) w.step();
  assert.equal(w.tick, t0 + 30, "ticks continue");
  assert.ok(errors.length > 0 && errors[0]!.includes(`unit #${a!.id}`));
  assert.equal(a!.task.kind, "idle");
  assert.ok(a!.log.some((l) => l.includes("Internal server error")));
  assert.ok(b!.x !== bx || b!.y !== by || b!.activity !== "idle", "other units are unaffected");
  assert.ok(w.stats.internalErrors > 0);
});

test("long-range route planning does not generate chunks and rejects enclosed goals cheaply", () => {
  const w = makeWorld();
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  const u = [...w.unitsOf(1)].map((id) => w.units.get(id)!)[0]!;
  const coarse = (w as unknown as { coarse: { route: (sx: number, sy: number, gx: number, gy: number, tick: number) => unknown } }).coarse;
  const before = w.chunks.generatedCount;
  coarse.route(u.x, u.y, u.x + 600, u.y + 400, w.tick);
  assert.equal(w.chunks.generatedCount, before, "coarse planning reads the generator, not the chunk cache");
  // A goal surrounded by water: find a water tile whose 3x3 cell neighbourhood is all water.
  let lake: { x: number; y: number } | null = null;
  for (let r = 40; r < 600 && !lake; r += 8) {
    for (let a = 0; a < 16 && !lake; a++) {
      const x = Math.round(u.x + r * Math.cos(a)), y = Math.round(u.y + r * Math.sin(a));
      let all = true;
      for (let dy = -12; dy <= 12 && all; dy += 2) for (let dx = -12; dx <= 12 && all; dx += 2) if (w.chunks.approxPassable(x + dx, y + dy)) all = false;
      if (all) lake = { x, y };
    }
  }
  if (lake) {
    const t = performance.now();
    assert.equal(coarse.route(u.x, u.y, lake.x, lake.y, w.tick), null);
    assert.ok(performance.now() - t < 50, "enclosed goal rejected quickly");
  }
});

test("wildlife spawns only in chunks near players, a few chunks per tick", () => {
  const w = new World({ seed: "test-seed", generationVersion: 2, chunkSize: 64, resourceDensity: 1 });
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  // Generating far-away chunks (as pathfinding or a subscription might) must not populate them.
  for (let cx = 40; cx < 50; cx++) for (let cy = 40; cy < 50; cy++) w.chunks.getChunk(cx, cy);
  for (let i = 0; i < 60; i++) w.step();
  for (const id of w.unitsOf(0)) {
    const c = w.units.get(id)!;
    assert.ok(Math.abs(Math.floor(c.x / 64)) < 20 && Math.abs(Math.floor(c.y / 64)) < 20, "no creature in the far chunks");
  }
  assert.ok(![...w.populated].some((k) => Number(k.split(",")[0]) >= 40), "far chunks stay unpopulated");
});
