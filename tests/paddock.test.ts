import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitDef } from "../src/shared/defs/units.ts";
import { NEUTRAL, type BuildingState, type UnitState } from "../src/sim/types.ts";
import { World, type SimConfig } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig } from "./helpers.ts";

const V3 = { seed: "test-seed", generationVersion: 3, chunkSize: 64, resourceDensity: 1 };

function world(over: Partial<SimConfig> = {}): World {
  const w = new World({ ...V3 }, over);
  assert.ok(w.createPlayer(1, "alice", "human").ok);
  for (const u of w.units.values()) if (u.owner !== NEUTRAL) w.controlProgram(u.owner, u.id, "stop");
  const p = w.players.get(1)!;
  p.resources = { wood: 5000, stone: 5000, gold: 5000, food: 5000 };
  return w;
}

const steps = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) w.step();
};

function near(w: World, x: number, y: number, r = 6): { x: number; y: number } {
  const np = (w as unknown as { nearestPassable: (x: number, y: number, r: number) => { x: number; y: number } | null }).nearestPassable.bind(w);
  const p = np(x, y, r);
  assert.ok(p);
  return p;
}

/** A completed paddock next to player 1's Town Hall (ground cleared of trees). */
function paddock(w: World): BuildingState {
  const p = w.players.get(1)!;
  const x = p.spawnX + 4;
  const y = p.spawnY - 2;
  for (let ty = y - 1; ty < y + 5; ty++) for (let tx = x - 1; tx < x + 5; tx++) w.chunks.clearNode(tx, ty);
  return w.addBuilding(1, "paddock", x, y, true);
}

/** A wild creature of `type` tamed by player 1 (observation skipped), standing near the paddock. */
function tamed(w: World, type: string, b: BuildingState): UnitState {
  const s = near(w, b.x + b.w + 2, b.y + 1);
  const c = w.spawnCreature(type, s.x, s.y);
  const p = w.players.get(1)!;
  if (!p.observed.includes(type)) p.observed.push(type);
  const tamer = w.addUnit(1, "worker", s.x, s.y + 1, false);
  tamer.inventory.food = 100;
  const r = w.commandUnit(1, tamer.id, { kind: "tame", targetId: c.id });
  assert.ok(r.ok, r.ok ? "" : r.message);
  steps(w, 30);
  assert.equal(c.owner, 1, `${type} tamed`);
  return c;
}

test("tamed animals walk into a paddock by themselves and live there: production, bonuses, unit limit", () => {
  const w = world();
  const b = paddock(w);
  const p = w.players.get(1)!;
  const sheep = tamed(w, "sheep", b);
  // Its default program finds the paddock and goes in.
  steps(w, 200);
  assert.equal(sheep.pen, b.id, "the sheep penned itself");
  assert.ok(sheep.x >= b.x && sheep.x < b.x + b.w && sheep.y >= b.y && sheep.y < b.y + b.h, "standing inside the fence");
  assert.equal(sheep.program.state, "stopped");
  const units = w.unitsOf(1).size;
  assert.equal(w.limitedUnits(1), units - 1, "animals in a paddock do not count toward the unit limit");
  // Production: 4 food and 1 gold a minute per sheep.
  const f0 = p.resources.food;
  const g0 = p.resources.gold;
  steps(w, 600);
  assert.ok(p.resources.food - f0 >= 3 && p.resources.food - f0 <= 5, `food +${p.resources.food - f0}`);
  assert.ok(p.resources.gold - g0 >= 1, "wool sold for gold");
  // A horse in the paddock makes every unit faster.
  const speed0 = w.stat(1, "moveSpeed", 1);
  const horse = tamed(w, "horse", b);
  // (It may already be walking in by itself; a manual order works too.)
  if (horse.pen === null) {
    const r0 = w.commandUnit(1, horse.id, { kind: "pen", buildingId: b.id });
    assert.ok(r0.ok, r0.ok ? "" : r0.message);
  }
  steps(w, 200);
  assert.equal(horse.pen, b.id);
  assert.ok(Math.abs(w.stat(1, "moveSpeed", 1) / speed0 - 1.03) < 1e-9, "+3% movement speed");
  // Penned animals take no orders, cannot run programs and cannot be attacked.
  assert.equal((w.commandUnit(1, horse.id, { kind: "stop" }) as { code: string }).code, "penned");
  assert.ok(!w.controlProgram(1, horse.id, "run").ok);
  // Release: the horse comes out, the bonus goes away.
  const r = w.releaseAnimal(1, b.id, horse.id);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.equal(horse.pen, null);
  assert.ok(horse.x < b.x || horse.x >= b.x + b.w || horse.y < b.y || horse.y >= b.y + b.h, "outside the fence");
  assert.equal(w.stat(1, "moveSpeed", 1), speed0);
  // Only owners release; only tamed animals with paddock uses go in; wild ones cannot be penned.
  assert.ok(!w.releaseAnimal(2, b.id, sheep.id).ok);
  const wild = w.spawnCreature("goat", horse.x + 1, horse.y);
  assert.ok(w.penBlocker(wild, b));
  const worker = w.addUnit(1, "worker", horse.x, horse.y + 1, false);
  assert.match(w.penBlocker(worker, b) ?? "", /cannot be kept/);
});

test("pairs breed while there is room (paying food), capacity is enforced, and a lost paddock frees its animals", () => {
  const w = world();
  const b = paddock(w);
  const p = w.players.get(1)!;
  const a1 = tamed(w, "sheep", b);
  const a2 = tamed(w, "sheep", b);
  steps(w, 250);
  assert.equal(a1.pen, b.id);
  assert.equal(a2.pen, b.id);
  const food0 = p.resources.food;
  const breed = unitDef("sheep").creature!.paddock!;
  steps(w, (breed.breedSeconds + 3) * 10);
  const flock = w.pennedIn(b).filter((u) => u.type === "sheep");
  assert.equal(flock.length, 3, "a lamb was born");
  assert.ok(p.resources.food < food0 + 60, "the birth cost food (production gave some back)");
  // Fill it up: no more room, no more entries.
  while (w.pennedIn(b).length < 8) {
    const s = near(w, b.x - 2, b.y);
    const x = w.addUnit(1, "sheep", s.x, s.y, false);
    assert.ok(w.commandUnit(1, x.id, { kind: "pen", buildingId: b.id }).ok);
    steps(w, 100);
  }
  const extra = w.addUnit(1, "goat", b.x - 2, b.y + 1, false);
  assert.match(w.penBlocker(extra, b) ?? "", /full/);
  // The paddock is lost: its animals escape and count as units again.
  (w as unknown as { removeBuilding: (b: BuildingState) => void }).removeBuilding(b);
  assert.ok([...w.unitsOf(1)].every((id) => w.units.get(id)!.pen === null));
});

test("new units: miners quarry fast, rangers tame cheaply, clerics heal, knights need fighting enabled", () => {
  const w = world();
  const p = w.players.get(1)!;
  assert.ok(unitDef("miner").gatherRate.stone > unitDef("worker").gatherRate.stone * 1.5);
  // Ranger: half the food, twice as fast at observing.
  const s = near(w, p.spawnX + 8, p.spawnY + 8);
  const boar = w.spawnCreature("boar", s.x, s.y);
  const ranger = w.addUnit(1, "ranger", s.x + 1, s.y, false);
  const worker = w.addUnit(1, "worker", s.x, s.y + 1, false);
  assert.equal(w.tameCost(ranger, boar), 15);
  assert.equal(w.tameCost(worker, boar), 30);
  assert.ok(w.commandUnit(1, ranger.id, { kind: "observe", targetId: boar.id }).ok);
  steps(w, 10 * unitDef("boar").creature!.observeSeconds / 2 + 5);
  assert.ok(p.observed.includes("boar"), "observed in half the time");
  ranger.inventory.food = 15;
  assert.ok(w.commandUnit(1, ranger.id, { kind: "tame", targetId: boar.id }).ok);
  steps(w, 30);
  assert.equal(boar.owner, 1);
  assert.equal(ranger.inventory.food, 0);
  // Cleric heals nearby units every second.
  const hurt = w.addUnit(1, "worker", s.x + 2, s.y + 2, false);
  hurt.hp = 10;
  w.addUnit(1, "cleric", s.x + 3, s.y + 2, false);
  steps(w, 50);
  assert.ok(hurt.hp >= 10 + 3 * 4, `healed to ${hurt.hp}`);
  // Training buildings.
  for (const [building, type] of [["mine", "miner"], ["lodge", "ranger"], ["library", "cleric"], ["barracks", "knight"]] as const) {
    const b = w.addBuilding(1, building, p.spawnX - 20, p.spawnY - 20, true);
    const r = w.trainUnit(1, b.id, type);
    assert.ok(r.ok, `${type}: ${r.ok ? "" : r.message}`);
  }
});

test("paddocks over the network and across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-pen-"));
  try {
    const db = join(dir, "w.db");
    const cfg = testConfig(db);
    cfg.world = { ...V3 };
    const s1 = makeServer(db, cfg);
    const a = new TestClient(s1.game);
    a.hello("alice");
    const w = s1.world;
    const p = w.players.get(a.playerId)!;
    p.resources = { wood: 5000, stone: 5000, gold: 5000, food: 5000 };
    const b = w.addBuilding(a.playerId, "paddock", p.spawnX + 6, p.spawnY - 2, true);
    const goat = w.addUnit(a.playerId, "goat", b.x - 1, b.y, false);
    const r = a.request({ t: "unit_cmd", unitId: goat.id, cmd: { kind: "pen", buildingId: b.id } })[0];
    assert.equal(r?.t, "ack", JSON.stringify(r));
    for (let i = 0; i < 60; i++) s1.game.tickOnce();
    assert.equal(goat.pen, b.id);
    const view = a.buildings.get(b.id);
    assert.deepEqual(view?.own?.paddock?.animals, [{ id: goat.id, type: "goat" }]);
    assert.equal(view?.own?.paddock?.capacity, 8);
    assert.equal(a.units.get(goat.id)?.own?.pen, b.id);
    const bad = a.request({ t: "paddock_release", buildingId: b.id, unitId: 999999 })[0];
    assert.equal(bad?.t, "error");
    s1.game.flush();
    s1.game.stop();
    s1.store.close();
    const s2 = makeServer(db, cfg);
    const g2 = s2.world.units.get(goat.id)!;
    assert.equal(g2.pen, b.id, "still in the paddock after a restart");
    assert.ok(s2.world.stat(a.playerId, "gather.stone", 1) > 1, "and its bonus still applies");
    const b2 = new TestClient(s2.game);
    b2.hello("alice", { token: a.token });
    const rel = b2.request({ t: "paddock_release", buildingId: b.id, unitId: goat.id })[0];
    assert.equal(rel?.t, "ack", JSON.stringify(rel));
    assert.equal(g2.pen, null);
    s2.game.stop();
    s2.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
