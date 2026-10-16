import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALANCE } from "../src/shared/defs/balance.ts";
import type { BuildingState, UnitState } from "../src/sim/types.ts";
import { findPath } from "../src/sim/pathfinding.ts";
import { World, type SimConfig } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig, PARAMS } from "./helpers.ts";

function tp(w: World, u: UnitState, x: number, y: number): void {
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, x, y);
}

function world(over: Partial<SimConfig> = {}): World {
  const w = new World({ ...PARAMS }, over);
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  for (const u of w.units.values()) w.controlProgram(u.owner, u.id, "stop");
  return w;
}

const hallOf = (w: World, pid = 1): BuildingState => [...w.buildingsOf(pid)].map((id) => w.buildings.get(id)!).find((b) => b.type === "town_hall")!;
const unitOf = (w: World, type: string, pid = 1): UnitState => [...w.unitsOf(pid)].map((id) => w.units.get(id)!).find((u) => u.type === type)!;

function runScript(w: World, u: UnitState, src: string, ticks: number): void {
  const r = w.setProgram(u.owner, u.id, src, 1);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.ok(w.controlProgram(u.owner, u.id, "run").ok);
  for (let i = 0; i < ticks && u.program.state === "running"; i++) w.step();
}

test("unit and building limits rise with Library research, up to the server ceiling", () => {
  const w = world();
  assert.equal(w.unitCap(1), BALANCE.maxUnitsPerPlayer);
  assert.equal(w.buildingCap(1), BALANCE.maxBuildingsPerPlayer);
  const p = w.players.get(1)!;
  p.techs.push("administration");
  w.invalidateMods(1);
  assert.equal(w.unitCap(1), BALANCE.maxUnitsPerPlayer + 30);
  assert.equal(w.buildingCap(1), BALANCE.maxBuildingsPerPlayer + 40);
  p.techs.push("bureaucracy", "grand_council");
  w.invalidateMods(1);
  assert.equal(w.unitCap(1), BALANCE.maxUnitsPerPlayer + 120);
  // The server ceiling wins.
  const capped = world({ unitLimitCeiling: 70, buildingLimitCeiling: 90 });
  capped.players.get(1)!.techs.push("administration");
  capped.invalidateMods(1);
  assert.equal(capped.unitCap(1), 70);
  assert.equal(capped.buildingCap(1), 90);
  // Training at the limit is refused with a pointer to the research.
  const small = world({ unitLimitCeiling: 10 });
  small.players.get(1)!.resources.food = 5000;
  const hall = hallOf(small);
  for (let i = 0; i < 7; i++) assert.ok(small.trainUnit(1, hall.id, "worker").ok || i >= 5);
  for (let i = 0; i < 400; i++) small.step();
  let refused = small.trainUnit(1, hall.id, "worker");
  for (let i = 0; i < 10 && refused.ok; i++) {
    for (let k = 0; k < 200; k++) small.step();
    refused = small.trainUnit(1, hall.id, "worker");
  }
  assert.ok(!refused.ok && /Unit limit \(10\) reached: research Administration/.test(refused.message), refused.ok ? "" : refused.message);
  // Research prerequisites: Bureaucracy needs Administration.
  const fresh = world();
  fresh.players.get(1)!.resources = { wood: 5000, stone: 5000, gold: 5000, food: 5000 };
  const lodge = fresh.addBuilding(1, "lodge", hallOf(fresh).x + 6, hallOf(fresh).y, true);
  void lodge;
  const lib = fresh.addBuilding(1, "library", hallOf(fresh).x - 8, hallOf(fresh).y, true);
  const pre = fresh.research(1, lib.id, "bureaucracy");
  assert.ok(!pre.ok && /Administration/.test(pre.message), pre.ok ? "" : pre.message);
  assert.ok(fresh.research(1, lib.id, "administration").ok);
});

test("shared storage (the default) keeps one stock usable anywhere", () => {
  const w = world();
  assert.equal(w.cfg.storageMode, "shared");
  const hall = hallOf(w);
  assert.equal(w.players.get(1)!.resources.wood, BALANCE.startingResources.wood);
  assert.equal(hall.stock.wood, 0, "buildings hold nothing themselves");
  const wc = unitOf(w, "woodcutter");
  wc.inventory.wood = 10;
  assert.ok(w.commandUnit(1, wc.id, { kind: "deposit" }).ok);
  for (let i = 0; i < 200 && wc.inventory.wood > 0; i++) w.step();
  assert.equal(w.players.get(1)!.resources.wood, BALANCE.startingResources.wood + 10);
  assert.equal(hall.stock.wood, 0);
});

test("storage networks: deposits fill buildings up to capacity, costs are paid locally", () => {
  const w = world({ storageMode: "networks" });
  const p = w.players.get(1)!;
  const hall = hallOf(w);
  assert.equal(hall.stock.wood, BALANCE.startingResources.wood, "starting supplies sit in the Town Hall");
  assert.equal(p.resources.wood, hall.stock.wood, "the player's total is the sum of their storage");
  // A Stockpile near the hall joins its network; one far away is a separate network.
  const near = w.addBuilding(1, "stockpile", hall.x + 6, hall.y, true);
  const far = w.addBuilding(1, "stockpile", hall.x + 90, hall.y, true);
  assert.equal(w.storageNetworks(1).length, 2);
  // Fill the near stockpile to capacity, then deposits overflow to the next storage with room.
  const cap = w.storageCapacityOf(near);
  w.deliver(1, near.x, near.y, { stone: cap });
  assert.equal(w.storageFree(near), 0);
  const wc = unitOf(w, "woodcutter");
  tp(w, wc, near.x - 1, near.y);
  wc.inventory.wood = 12;
  assert.ok(w.commandUnit(1, wc.id, { kind: "deposit" }).ok);
  for (let i = 0; i < 300 && wc.inventory.wood > 0; i++) w.step();
  assert.equal(wc.inventory.wood, 0);
  assert.equal(near.stock.wood, 0, "the full stockpile took nothing");
  assert.equal(hall.stock.wood, BALANCE.startingResources.wood + 12, "it went to the hall instead");
  // An explicit deposit at a full storage fails clearly (the program named that storage).
  wc.inventory.wood = 5;
  tp(w, wc, near.x - 1, near.y);
  runScript(w, wc, `s = None\nfor b in [0]:\n    s = find_nearest("storage")\nprint("near", storage_contents(s)["free"])\nprint("dep", deposit(s))\n`, 100);
  assert.ok(wc.log.some((l) => l.includes("near 0")), wc.log.join("\n"));
  assert.ok(wc.log.some((l) => /Stockpile #\d+ is full/.test(l)) && wc.log.some((l) => l.includes("dep False")), wc.log.join("\n"));
  assert.equal(wc.inventory.wood, 5, "nothing was lost");
  // Paying: a Farm next to the far stockpile cannot use the hall's wood.
  const spot = { x: far.x + 3, y: far.y + 3 };
  const r = w.checkPlacement(1, "farm", spot.x, spot.y);
  assert.ok(!r.ok);
  // Haul 60 wood there with a script, then the same placement is affordable from that network.
  const hauler = w.addUnit(1, "hauler", hall.x - 1, hall.y, false);
  runScript(
    w,
    hauler,
    `n = withdraw("wood", 30)\nprint("took", n)\n`,
    400,
  );
  assert.ok(hauler.log.some((l) => l.includes("took 30")), hauler.log.join("\n"));
  tp(w, hauler, far.x - 1, far.y);
  runScript(w, hauler, `print("dep", deposit(find_nearest("storage")))\nprint("has", storage_contents(find_nearest("storage"))["wood"], storage_mode())\n`, 200);
  assert.ok(hauler.log.some((l) => l.includes("has 30 networks")), hauler.log.join("\n"));
  assert.equal(far.stock.wood, 30);
  w.deliver(1, far.x, far.y, { wood: 40 });
  assert.ok(w.canPayAt(1, { x: spot.x, y: spot.y, w: 3, h: 3 }, { wood: 60 }, "a Farm").ok);
  assert.equal(p.resources.wood, hall.stock.wood + near.stock.wood + far.stock.wood);
  // Far from any storage: a clear message.
  const nowhere = w.canPayAt(1, { x: hall.x + 300, y: hall.y, w: 2, h: 2 }, { wood: 10 }, "a Stockpile");
  assert.ok(!nowhere.ok && /No storage building within 48 tiles/.test(nowhere.message));
});

test("storage networks: production needs a storage in range; destroyed storage loses its contents, the attacker plunders a quarter", () => {
  const w = new World({ ...PARAMS }, { storageMode: "networks", combatEnabled: true });
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  assert.ok(w.createPlayer(2, "bob", "high_elf").ok);
  for (const u of w.units.values()) w.controlProgram(u.owner, u.id, "stop");
  const hall = hallOf(w);
  // A farm next to the hall delivers into it; one far away holds its output.
  const farm = w.addBuilding(1, "farm", hall.x + 5, hall.y + 5, true);
  const lonely = w.addBuilding(1, "farm", hall.x + 200, hall.y, true);
  const food0 = hall.stock.food;
  for (let i = 0; i < 200; i++) w.step();
  assert.ok(hall.stock.food > food0, "nearby production reaches the hall");
  assert.equal(lonely.prodBlocked, true);
  assert.ok(lonely.prodAcc <= 10);
  void farm;
  // Destroying a stocked storage: the owner loses it all, the attacker gets 25%.
  const p1 = w.players.get(1)!;
  const sp = w.addBuilding(1, "stockpile", hall.x + 30, hall.y, true);
  w.deliver(1, sp.x, sp.y, { gold: 100 });
  const goldBefore = p1.resources.gold;
  w.setPvp(1, true);
  w.setPvp(2, true);
  const raider = w.addUnit(2, "soldier", sp.x - 1, sp.y, false);
  const bobGold = w.players.get(2)!.resources.gold;
  assert.ok(w.commandUnit(2, raider.id, { kind: "attack_building", buildingId: sp.id }).ok);
  for (let i = 0; i < 1000 && w.buildings.has(sp.id); i++) w.step();
  assert.ok(!w.buildings.has(sp.id));
  assert.equal(p1.resources.gold, goldBefore - 100, "the 100 gold is gone from Alice's totals");
  assert.equal(w.players.get(2)!.resources.gold, bobGold + 25, "Bob plundered a quarter");
  assert.ok(raider.log.some((l) => /Plundered 25 gold/.test(l)), raider.log.join("\n"));
});

test("switching storage mode on a saved world is lossless, both ways, and building stock persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-storage-"));
  const db = join(dir, "s.db");
  try {
    const cfg = testConfig(db);
    const s1 = makeServer(db, cfg);
    const c = new TestClient(s1.game);
    c.hello("alice");
    assert.equal(c.playerId, 1);
    s1.world.players.get(1)!.resources = { wood: 321, stone: 45, gold: 6, food: 78 };
    s1.world.markPlayer(s1.world.players.get(1)!);
    assert.ok(s1.game.flush());
    s1.game.stop();
    s1.store.close();
    // Shared -> networks: everything moves into the Town Hall.
    cfg.economy.storage = "networks";
    const s2 = makeServer(db, cfg);
    const hall2 = hallOf(s2.world);
    assert.deepEqual(hall2.stock, { wood: 321, stone: 45, gold: 6, food: 78 });
    assert.deepEqual(s2.world.players.get(1)!.resources, { wood: 321, stone: 45, gold: 6, food: 78 });
    const sp = s2.world.addBuilding(1, "stockpile", hall2.x + 6, hall2.y, true);
    s2.world.deliver(1, sp.x, sp.y, { stone: 10 });
    assert.ok(s2.game.flush());
    s2.game.stop();
    s2.store.close();
    // Restart in networks mode: stock is where it was.
    const s3 = makeServer(db, cfg);
    assert.equal(s3.world.buildings.get(sp.id)!.stock.stone, 10);
    assert.equal(hallOf(s3.world).stock.wood, 321);
    assert.ok(s3.game.flush());
    s3.game.stop();
    s3.store.close();
    // Networks -> shared: all building stock returns to the shared stock.
    cfg.economy.storage = "shared";
    const s4 = makeServer(db, cfg);
    assert.deepEqual(s4.world.players.get(1)!.resources, { wood: 321, stone: 55, gold: 6, food: 78 });
    for (const b of s4.world.buildings.values()) assert.equal(b.stock.wood + b.stock.stone + b.stock.gold + b.stock.food, 0);
    s4.game.stop();
    s4.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the SCRIPTING.md hauling example keeps a remote storage network supplied", () => {
  const w = world({ storageMode: "networks" });
  const hall = hallOf(w);
  // A clear, reachable 4x4 patch 30-60 tiles away: the stockpile plus a free tile beside it (beyond the 24-tile link range).
  const clear = (x0: number, y0: number): boolean => { for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) if (!w.isPassable(x, y)) return false; return true; };
  let fx = 0, fy = 0;
  const reachable = (x: number, y: number): boolean => findPath({ sx: hall.x - 1, sy: hall.y, goal: { x, y, w: 1, h: 1 }, range: 0, radius: 80, passable: (px, py) => w.isPassable(px, py) }).ok;
  search: for (let d = 30; d < 60; d += 2) for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x0 = hall.x + ux! * d, y0 = hall.y + uy! * d;
    if (clear(x0, y0) && reachable(x0, y0 + 1)) { fx = x0 + 1; fy = y0 + 1; break search; }
  }
  assert.ok(fx !== 0, "found a clear spot");
  const far = w.addBuilding(1, "stockpile", fx, fy, true);
  assert.equal(w.storageNetworks(1).length, 2);
  w.deliver(1, hall.x, hall.y, { wood: 200 });
  assert.ok(w.isPassable(hall.x - 1, hall.y));
  const hauler = w.addUnit(1, "hauler", hall.x - 1, hall.y, false);
  const site = { x: fx - 1, y: fy };
  const src = `SITE_X = ${site.x}                       # a spot next to the remote Stockpile
SITE_Y = ${site.y}
home = find_nearest("storage")     # start the Hauler at home
move_to(SITE_X, SITE_Y)
target = find_nearest("storage")
while True:
    if storage_contents(target)["wood"] < 300 and storage_contents(home)["wood"] >= 40:
        withdraw("wood", 40, home)
        deposit(target)
    else:
        wait(10)
`;
  const before = hall.stock.wood;
  runScript(w, hauler, src, 4000);
  assert.equal(hauler.program.state, "running", hauler.log.join("\n"));
  assert.ok(far.stock.wood >= 80, `far stockpile got ${far.stock.wood}; log: ${hauler.log.join(" | ")}`);
  assert.equal(hall.stock.wood + far.stock.wood + hauler.inventory.wood, before, "hauling moves wood, never creates or loses it");
});
