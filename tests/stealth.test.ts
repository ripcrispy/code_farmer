import { test } from "node:test";
import assert from "node:assert/strict";
import { Tile } from "../src/shared/defs/terrain.ts";
import type { UnitState } from "../src/sim/types.ts";
import { World } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig, PARAMS } from "./helpers.ts";

function tp(w: World, u: UnitState, x: number, y: number): void {
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, x, y);
}

function np(w: World, x: number, y: number): { x: number; y: number } {
  return (w as unknown as { nearestPassable: (x: number, y: number, r: number) => { x: number; y: number } | null }).nearestPassable(x, y, 8)!;
}

test("scouts are hidden from other players unless something of theirs is close", () => {
  const w = new World({ ...PARAMS }, { combatEnabled: true });
  assert.ok(w.createPlayer(1, "alice", "human").ok);
  assert.ok(w.createPlayer(2, "bob", "human").ok);
  for (const u of w.units.values()) w.controlProgram(u.owner, u.id, "stop");
  const p1 = w.players.get(1)!;
  const scout = [...w.unitsOf(2)].map((id) => w.units.get(id)!).find((u) => u.type === "scout")!;
  const watcher = [...w.unitsOf(1)].map((id) => w.units.get(id)!).find((u) => u.type === "woodcutter")!;
  const far = np(w, p1.spawnX + 15, p1.spawnY + 15);
  tp(w, scout, far.x, far.y);
  tp(w, watcher, far.x - 9, far.y);
  // Alice's Town Hall is more than 5 tiles away as well.
  assert.ok(w.isStealthy(scout));
  assert.equal(w.isHiddenFrom(scout, 1), true);
  assert.equal(w.isHiddenFrom(scout, 2), false, "never hidden from its owner");
  tp(w, watcher, far.x - 4, far.y);
  assert.equal(w.isHiddenFrom(scout, 1), false, "a unit within 5 tiles spots it");
  // A worker is not stealthy.
  const worker = w.addUnit(2, "worker", far.x, far.y, false);
  tp(w, watcher, far.x - 9, far.y);
  assert.equal(w.isHiddenFrom(worker, 1), false);
  // A Watchtower spots it from 12 tiles.
  const tower = w.addBuilding(1, "watchtower", far.x - 11, far.y, true);
  assert.equal(w.isHiddenFrom(scout, 1), false);
  w.buildings.delete(tower.id);
  // Hidden targets cannot be attacked or found, even in PvP.
  w.setPvp(1, true);
  w.setPvp(2, true);
  const soldier = w.addUnit(1, "soldier", far.x - 9, far.y, false);
  const why = w.attackBlocker(soldier, scout);
  assert.ok(why && /No such target in sight/.test(why), String(why));
  assert.equal(w.findNearest(soldier, "enemy")?.id === `u:${scout.id}`, false);
  // Attacking reveals the attacker for 10 seconds.
  tp(w, scout, far.x - 8, far.y);
  assert.ok(w.commandUnit(2, scout.id, { kind: "attack", targetId: soldier.id }).ok);
  for (let i = 0; i < 15; i++) w.step();
  w.commandUnit(2, scout.id, { kind: "stop" });
  tp(w, scout, far.x, far.y);
  tp(w, soldier, far.x - 9, far.y);
  assert.equal(w.isHiddenFrom(scout, 1), false, "revealed after attacking");
  for (let i = 0; i < 110; i++) w.step();
  tp(w, soldier, far.x - 9, far.y);
  tp(w, watcher, far.x - 9, far.y);
  assert.equal(w.isHiddenFrom(scout, 1), true, "hidden again 10 s later");
});

test("hidden units never reach other players' clients; detection makes them appear and disappear", () => {
  const cfg = testConfig();
  const { game, world } = makeServer(":memory:", cfg);
  const a = new TestClient(game);
  a.hello("alice");
  const b = new TestClient(game);
  b.hello("bob");
  for (const u of world.units.values()) world.controlProgram(u.owner, u.id, "stop");
  const pa = world.players.get(a.playerId)!;
  const scout = [...world.unitsOf(b.playerId)].map((id) => world.units.get(id)!).find((u) => u.type === "scout")!;
  const watcher = [...world.unitsOf(a.playerId)].map((id) => world.units.get(id)!).find((u) => u.type === "woodcutter")!;
  const spot = np(world, pa.spawnX + 15, pa.spawnY + 15);
  tp(world, scout, spot.x, spot.y);
  world.markUnit(scout);
  tp(world, watcher, spot.x - 9, spot.y);
  world.markUnit(watcher);
  a.subscribeAround(spot.x, spot.y, 1);
  for (let i = 0; i < 12; i++) game.tickOnce();
  assert.equal(a.units.has(scout.id), false, "the scout is hidden from Alice");
  assert.ok(!JSON.stringify(a.inbox).includes(`"id":${scout.id},"owner":${b.playerId}`), "not even once");
  // Alice's attack order on it gets the same answer as for a unit that does not exist.
  const s = world.addUnit(a.playerId, "worker", spot.x - 9, spot.y, false);
  const r1 = a.request({ t: "unit_cmd", unitId: s.id, cmd: { kind: "attack", targetId: scout.id } })[0];
  const r2 = a.request({ t: "unit_cmd", unitId: s.id, cmd: { kind: "attack", targetId: 987654 } })[0];
  assert.ok(r1?.t === "error" && r2?.t === "error" && r1.message === r2.message);
  // Alice's woodcutter walks close: within a second the scout appears; it leaves again when she moves away.
  tp(world, watcher, spot.x - 3, spot.y);
  world.markUnit(watcher);
  for (let i = 0; i < 12; i++) game.tickOnce();
  assert.equal(a.units.has(scout.id), true, "detected");
  tp(world, watcher, spot.x - 12, spot.y);
  world.markUnit(watcher);
  tp(world, s, spot.x - 12, spot.y + 1);
  world.markUnit(s);
  for (let i = 0; i < 12; i++) game.tickOnce();
  assert.equal(a.units.has(scout.id), false, "hidden again once nothing is close");
  // Bob sees his own scout, flagged as hidden.
  for (let i = 0; i < 12; i++) game.tickOnce();
  assert.equal(b.units.get(scout.id)?.own?.hidden, true);
  game.stop();
});

test("Dark Elves hide in forest; Trolls regenerate faster; Undead reclaim part of what defeated units cost", () => {
  const w = new World({ ...PARAMS }, { combatEnabled: true });
  assert.ok(w.createPlayer(1, "elf", "dark_elf").ok);
  assert.ok(w.createPlayer(2, "troll", "troll").ok);
  assert.ok(w.createPlayer(3, "bones", "undead").ok);
  for (const u of w.units.values()) w.controlProgram(u.owner, u.id, "stop");
  const elf = w.addUnit(1, "worker", 0, 0, false);
  // Find a forest tile and a grass tile.
  let forest: { x: number; y: number } | null = null;
  let grass: { x: number; y: number } | null = null;
  for (let i = 0; i < 4000 && (!forest || !grass); i++) {
    const x = (i % 63) * 3 - 90;
    const y = Math.floor(i / 63) * 3 - 90;
    if (!w.isPassable(x, y)) continue;
    const t = w.chunks.terrainAt(x, y);
    if (t === Tile.Forest && !forest) forest = { x, y };
    if (t === Tile.Grass && !grass) grass = { x, y };
  }
  assert.ok(forest && grass);
  tp(w, elf, forest.x, forest.y);
  assert.equal(w.isStealthy(elf), true, "Dark Elf units hide in forest");
  tp(w, elf, grass.x, grass.y);
  assert.equal(w.isStealthy(elf), false, "but not in the open");
  // Regeneration: a Troll heals three times as fast as others.
  const t = w.addUnit(2, "worker", grass.x, grass.y, false);
  const o = w.addUnit(1, "worker", grass.x, grass.y, false);
  t.hp = 10;
  o.hp = 10;
  for (let i = 0; i < 30; i++) w.step();
  assert.ok(t.hp - 10 >= 3 * (o.hp - 10) - 1 && o.hp > 10, `troll ${t.hp} vs other ${o.hp}`);
  // Undead: defeating a trained unit reclaims 30% of its cost, boosted by the Undead salvage bonus (+50%).
  w.setPvp(1, true);
  w.setPvp(3, true);
  const killer = w.addUnit(3, "soldier", grass.x, grass.y, false);
  const victim = w.addUnit(1, "hauler", grass.x + 1, grass.y, false); // costs 40 wood, 40 food
  const before = { ...w.players.get(3)!.resources };
  assert.ok(w.commandUnit(3, killer.id, { kind: "attack", targetId: victim.id }).ok);
  for (let i = 0; i < 200 && w.units.has(victim.id); i++) w.step();
  assert.ok(!w.units.has(victim.id));
  const after = w.players.get(3)!.resources;
  assert.equal(after.wood - before.wood, 18, "40 x 0.3 x 1.5");
  assert.ok(killer.log.some((l) => /Reclaimed 18 wood and 18 food from the fallen hauler/.test(l)), killer.log.join("\n"));
});
