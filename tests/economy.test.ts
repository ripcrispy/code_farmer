import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_DEFS } from "../src/shared/defs/resources.ts";
import { unitDef } from "../src/shared/defs/units.ts";
import { BALANCE } from "../src/shared/defs/balance.ts";
import type { BuildingState, UnitState } from "../src/sim/types.ts";
import { findPath } from "../src/sim/pathfinding.ts";
import { findBuildingDef } from "../src/shared/defs/buildings.ts";
import type { World } from "../src/sim/world.ts";
import { TestClient, makeServer, makeWorld, runUntil, stepWorld } from "./helpers.ts";

function setup(): { w: World; units: UnitState[]; hall: BuildingState } {
  const w = makeWorld();
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  const units = [...w.unitsOf(1)].map((id) => w.units.get(id) as UnitState);
  for (const u of units) w.controlProgram(1, u.id, "stop");
  const hall = [...w.buildingsOf(1)].map((id) => w.buildings.get(id)!)[0]!;
  return { w, units, hall };
}

/** Find a valid spot (reachable by the player's builder) near a point by asking the authoritative check. */
function spotFor(w: World, pid: number, type: string, cx: number, cy: number, maxR = 40): { x: number; y: number } {
  const builder = [...w.unitsOf(pid)].map((id) => w.units.get(id)!).find((u) => u.type === "builder")!;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!w.checkPlacement(pid, type, x, y, true).ok) continue;
      const def = findBuildingDef(type)!;
      const path = findPath({ sx: builder.x, sy: builder.y, goal: { x, y, w: def.width, h: def.height }, range: 1, radius: 48, passable: (px, py) => w.isPassable(px, py) });
      if (path.ok) return { x, y };
    }
  }
  throw new Error(`no spot for ${type}`);
}

function complete(w: World, b: BuildingState): void {
  // Finish construction through the real build task with the builder.
  const builder = [...w.unitsOf(b.owner)].map((id) => w.units.get(id)!).find((u) => u.type === "builder")!;
  assert.ok(w.commandUnit(b.owner, builder.id, { kind: "build", buildingId: b.id }).ok);
  for (let i = 0; i < 6000 && !b.complete; i++) w.step();
  assert.ok(b.complete, `${b.type} completed`);
}

test("a new settlement claims territory around its Town Hall", () => {
  const { w, hall } = setup();
  const owned = w.territory.countOf(1);
  assert.ok(owned > 400 && owned < 1000, `owned ${owned}`);
  assert.equal(w.territory.ownerAt(hall.x + 1, hall.y + 1), 1);
  assert.equal(w.territory.ownerAt(hall.x + 40, hall.y), 0);
});

test("buildings must be inside your territory; outposts expand it", () => {
  const { w, hall } = setup();
  const p = w.players.get(1)!;
  p.resources = { wood: 1000, stone: 1000, gold: 0, food: 100 };
  // A stockpile on clear land just outside the claimed circle is rejected.
  let outside = null;
  for (let dy = -10; dy <= 10 && !outside; dy++) {
    for (let dx = 16; dx <= 24; dx++) {
      const x = hall.x + dx;
      const y = hall.y + dy;
      const clear = [0, 1].every((oy) => [0, 1].every((ox) => w.territory.ownerAt(x + ox, y + oy) === 0 && w.isPassable(x + ox, y + oy) && w.chunks.terrainAt(x + ox, y + oy) !== 1));
      if (clear) {
        outside = w.checkPlacement(1, "stockpile", x, y);
        break;
      }
    }
  }
  assert.ok(outside && !outside.ok && outside.code === "outside_territory", JSON.stringify(outside));
  // An outpost may go there (within expansion range), but not far beyond.
  const farCodes = new Set<string>();
  for (let dy = -30; dy <= 30; dy += 3) for (let dx = -30; dx <= 30; dx += 3) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 26) continue;
    const r = w.checkPlacement(1, "outpost", hall.x + 80 + dx, hall.y + dy);
    farCodes.add(r.ok ? "ok" : r.code);
  }
  assert.ok(farCodes.has("out_of_range") && !farCodes.has("ok"), [...farCodes].join(","));
  const spot = spotFor(w, 1, "outpost", hall.x + 24, hall.y);
  const before = w.territory.countOf(1);
  const r = w.placeBuilding(1, "outpost", spot.x, spot.y);
  assert.ok(r.ok);
  assert.equal(w.territory.countOf(1), before, "construction sites do not claim");
  complete(w, r.value);
  assert.ok(w.territory.countOf(1) > before + 50, "completed outpost claims new land");
  assert.equal(w.territory.ownerAt(spot.x, spot.y), 1);
  assert.equal(w.territory.claims.at(-1)?.buildingId, r.value.id, "expansion history recorded");
});

test("contested land stays with its first owner and blocks foreign construction", () => {
  const w = makeWorld();
  assert.ok(w.createPlayer(1, "a", "human").ok);
  assert.ok(w.createPlayer(2, "b", "orc").ok);
  const hall2 = [...w.buildingsOf(2)].map((id) => w.buildings.get(id)!)[0]!;
  w.players.get(1)!.resources = { wood: 1000, stone: 1000, gold: 0, food: 0 };
  const r = w.checkPlacement(1, "outpost", hall2.x + 4, hall2.y);
  assert.ok(!r.ok && (r.code === "foreign_territory" || r.code === "occupied" || r.code === "out_of_range"), JSON.stringify(r));
  // Claims never overwrite: tiles owned by player 2 remain theirs after player 1 claims nearby.
  const owned2 = w.territory.countOf(2);
  w.territory.claim(1, 999, { x: hall2.x, y: hall2.y, w: 3, h: 3 }, 20, w.tick);
  assert.equal(w.territory.countOf(2), owned2);
  assert.equal(w.territory.ownerAt(hall2.x + 1, hall2.y + 1), 2);
});

test("prerequisites, research costs once, and research effects apply", () => {
  const { w, hall, units } = setup();
  const p = w.players.get(1)!;
  p.resources = { wood: 2000, stone: 2000, gold: 500, food: 500 };
  const noLodge = w.placeBuilding(1, "library", hall.x + 5, hall.y);
  assert.ok(!noLodge.ok && noLodge.code === "missing_prerequisite" && /Lodge/.test(noLodge.message));
  const th = w.checkPlacement(1, "town_hall", hall.x + 30, hall.y);
  assert.ok(!th.ok && th.code === "missing_prerequisite" && /Civic Planning/.test(th.message));
  const lodgeSpot = spotFor(w, 1, "lodge", hall.x - 6, hall.y);
  const lodge = w.placeBuilding(1, "lodge", lodgeSpot.x, lodgeSpot.y);
  assert.ok(lodge.ok);
  complete(w, lodge.value);
  const ls = spotFor(w, 1, "library", hall.x + 5, hall.y + 3);
  const lib = w.placeBuilding(1, "library", ls.x, ls.y);
  assert.ok(lib.ok, JSON.stringify(lib));
  complete(w, lib.value);
  // Prerequisite chain
  const early = w.research(1, lib.value.id, "civic_planning");
  assert.ok(!early.ok && early.code === "missing_prerequisite");
  const wood0 = p.resources.wood;
  assert.ok(w.research(1, lib.value.id, "ox_carts").ok);
  assert.equal(p.resources.wood, wood0 - 100, "cost charged once");
  const dup = w.research(1, lib.value.id, "ox_carts");
  assert.ok(!dup.ok && dup.code === "already_queued");
  assert.equal(p.resources.wood, wood0 - 100);
  const wc = units.find((u) => u.type === "woodcutter")!;
  const capBefore = w.capacity(wc);
  stepWorld(w, 51 * w.cfg.tickRate);
  assert.deepEqual(p.techs, ["ox_carts"]);
  assert.equal(w.capacity(wc), capBefore + 4);
  const again = w.research(1, lib.value.id, "ox_carts");
  assert.ok(!again.ok && again.code === "already_researched");
  // Unlock chain: surveying -> civic planning -> Town Hall placement allowed.
  assert.ok(w.research(1, lib.value.id, "surveying").ok);
  stepWorld(w, 41 * w.cfg.tickRate);
  assert.ok(w.research(1, lib.value.id, "civic_planning").ok);
  stepWorld(w, 61 * w.cfg.tickRate);
  assert.ok(p.techs.includes("civic_planning"));
  assert.ok(w.mods(1).has("building:town_hall"));
  const spot = spotFor(w, 1, "town_hall", hall.x + 26, hall.y);
  assert.ok(w.placeBuilding(1, "town_hall", spot.x, spot.y).ok);
  // Lodge trains haulers.
  assert.ok(w.trainUnit(1, lodge.value.id, "hauler").ok);
  stepWorld(w, 21 * w.cfg.tickRate);
  assert.ok([...w.unitsOf(1)].some((id) => w.units.get(id)!.type === "hauler"));
});

test("Lumber Camp aura speeds up nearby wood gathering", () => {
  const { w, hall, units } = setup();
  w.players.get(1)!.resources.wood = 500;
  const wc = units.find((u) => u.type === "woodcutter")!;
  const tree = w.findNearest(wc, "tree")!;
  const base = w.gatherRate(wc, "wood", tree.x, tree.y);
  assert.equal(base, unitDef("woodcutter").gatherRate.wood, "high elves have no wood bonus");
  const spot = spotFor(w, 1, "lumber_camp", tree.x, tree.y, 12);
  const camp = w.placeBuilding(1, "lumber_camp", spot.x, spot.y);
  assert.ok(camp.ok);
  complete(w, camp.value);
  assert.ok(Math.abs(w.gatherRate(wc, "wood", tree.x, tree.y) - base * 1.25) < 1e-9);
  void hall;
});

test("berry bushes regrow instead of disappearing; trees are finite", () => {
  const { w, units } = setup();
  const u = units[0]!;
  const bush = w.findNearest(u, "berries");
  assert.ok(bush, "berries near spawn");
  const n = w.chunks.nodeAt(bush.x, bush.y)!;
  w.chunks.takeFromNode(bush.x, bush.y, 10_000);
  assert.equal(w.chunks.amountAt(bush.x, bush.y), 0);
  assert.ok(w.chunks.nodeAt(bush.x, bush.y), "empty bush stays");
  assert.equal(w.isPassable(bush.x, bush.y), false, "and still blocks its tile");
  const g = w.commandUnit(1, u.id, { kind: "gather", x: bush.x, y: bush.y });
  assert.ok(!g.ok && /regrowing/.test(g.message));
  const perMinute = NODE_DEFS.berries.regrowPerMinute;
  stepWorld(w, 60 * w.cfg.tickRate);
  assert.equal(w.chunks.amountAt(bush.x, bush.y), perMinute);
  assert.ok(w.chunks.nodeChanges.some((c) => c.x === bush.x && c.y === bush.y && c.amount > 0), "clients are told it regrew");
  assert.ok(w.chunks.amountOf(n) <= n.max);
  const tree = w.findNearest(u, "tree")!;
  w.chunks.takeFromNode(tree.x, tree.y, 10_000);
  stepWorld(w, 600);
  assert.equal(w.chunks.nodeAt(tree.x, tree.y), undefined, "trees do not regrow");
});

test("withdraw moves resources from stock into a unit atomically", () => {
  const { w, units } = setup();
  const p = w.players.get(1)!;
  p.resources.food = 50;
  const u = units.find((x) => x.type === "woodcutter")!;
  assert.ok(w.setProgram(1, u.id, 'a = withdraw("food", 8)\nb = withdraw("gold")\nc = withdraw("food")\nprint("got", a, b, c, inventory.count("food"))\n', 1).ok);
  assert.ok(w.controlProgram(1, u.id, "run").ok);
  stepWorld(w, 300);
  assert.equal(u.program.state, "finished", u.log.join("\n"));
  const cap = w.capacity(u);
  assert.ok(u.log.some((l) => l.includes(`got 8 0 ${cap - 8} ${cap}`)), u.log.join("\n"));
  assert.equal(p.resources.food, 50 - cap);
  assert.equal(p.resources.food + u.inventory.food, 50, "no resources created or lost");
});

test("territory reaches clients, updates on expansion, and is rebuilt identically after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-terr-"));
  const db = join(dir, "t.db");
  try {
    let s = makeServer(db);
    const a = new TestClient(s.game);
    a.hello("alice");
    a.subscribeAround(a.spawn.x, a.spawn.y, 1);
    const chunk = [...a.chunks.values()].find((c) => c.territory.length > 0);
    assert.ok(chunk, "chunk messages carry territory");
    const p = s.world.players.get(a.playerId)!;
    p.resources = { wood: 1000, stone: 1000, gold: 0, food: 100 };
    const hall = [...s.world.buildingsOf(a.playerId)].map((id) => s.world.buildings.get(id)!)[0]!;
    const spot = spotFor(s.world, a.playerId, "outpost", hall.x + 22, hall.y + 2);
    const placed = a.request({ t: "place_building", type: "outpost", x: spot.x, y: spot.y })[0];
    assert.ok(placed?.t === "ack");
    const outpost = s.world.buildings.get((placed as { id: number }).id)!;
    const builder = a.own().find((u) => u.type === "builder")!;
    a.request({ t: "unit_cmd", unitId: builder.id, cmd: { kind: "build", buildingId: outpost.id } });
    runUntil(s.game, () => outpost.complete, 6000, "outpost built");
    s.game.tickOnce();
    assert.ok(a.inbox.some((m) => m.t === "tick" && (m.territory?.length ?? 0) > 0), "territory delta broadcast");
    assert.equal(a.player?.territory, s.world.territory.countOf(a.playerId));
    const stats = a.request({ t: "stats_get" })[0];
    assert.ok(stats?.t === "stats" && stats.history.some((h) => h.buildingType === "outpost") && stats.leaderboard[0]?.id === a.playerId);
    const count = s.world.territory.countOf(a.playerId);
    const sample = [0, 5, 10, 15, 20, 25, 30].map((d) => s.world.territory.ownerAt(hall.x + d, hall.y + 1));
    const explored = p.explored.size;
    s.game.stop();
    s.store.close();
    s = makeServer(db);
    assert.equal(s.world.territory.countOf(a.playerId), count);
    assert.deepEqual([0, 5, 10, 15, 20, 25, 30].map((d) => s.world.territory.ownerAt(hall.x + d, hall.y + 1)), sample);
    assert.equal(s.world.players.get(a.playerId)!.explored.size, explored);
    assert.ok(explored >= 1);
    s.game.stop();
    s.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  void BALANCE;
});
