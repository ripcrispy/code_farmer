import { test } from "node:test";
import assert from "node:assert/strict";
import { NEUTRAL, type BuildingState } from "../src/sim/types.ts";
import { World } from "../src/sim/world.ts";
import { unitDef } from "../src/shared/defs/units.ts";
import { TestClient, makeServer, PARAMS } from "./helpers.ts";

function world(): World {
  const w = new World({ ...PARAMS, generationVersion: 3 });
  assert.ok(w.createPlayer(1, "alice", "human").ok);
  assert.ok(w.createPlayer(2, "bob", "orc").ok);
  for (const u of w.units.values()) if (u.owner !== NEUTRAL) w.controlProgram(u.owner, u.id, "stop");
  w.players.get(1)!.resources = { wood: 1000, stone: 1000, gold: 1000, food: 1000 };
  return w;
}

const hall = (w: World, pid: number): BuildingState => [...w.buildingsOf(pid)].map((id) => w.buildings.get(id)!).find((b) => b.type === "town_hall")!;

test("dismissing units: gone for good, all-or-nothing, heroes stay, tamed animals go back to the wild", () => {
  const w = world();
  const mine = [...w.unitsOf(1)];
  const bobs = [...w.unitsOf(2)];
  // Someone else's unit in the list: nothing happens.
  const bad = w.dismissUnits(1, [mine[0]!, bobs[0]!]);
  assert.ok(!bad.ok && bad.code === "permission_denied");
  assert.equal(w.unitsOf(1).size, 3);
  const r = w.dismissUnits(1, [mine[0]!, mine[1]!]);
  assert.ok(r.ok && r.value === 2);
  assert.equal(w.unitsOf(1).size, 1);
  assert.ok(!w.units.has(mine[0]!));
  // Heroes cannot be dismissed.
  const p = w.players.get(1)!;
  assert.ok(w.recruitHero(1, hall(w, 1).id).ok);
  for (let i = 0; i < 400 && p.hero.unitId === null; i++) w.step();
  assert.ok(p.hero.unitId !== null);
  assert.equal((w.dismissUnits(1, [p.hero.unitId]) as { code: string }).code, "hero");
  // A tamed sheep in a paddock is let out and returns to the wild, running its wild program.
  const pad = w.addBuilding(1, "paddock", p.spawnX + 5, p.spawnY - 3, true);
  const sheep = w.addUnit(1, "sheep", pad.x, pad.y, false);
  sheep.pen = pad.id;
  const r2 = w.dismissUnits(1, [sheep.id]);
  assert.ok(r2.ok);
  assert.equal(sheep.owner, NEUTRAL);
  assert.equal(sheep.pen, null);
  assert.equal(sheep.program.source, unitDef("sheep").creature!.wildProgram);
  assert.equal(sheep.program.state, "running");
  assert.ok(sheep.x < pad.x || sheep.x >= pad.x + pad.w || sheep.y < pad.y || sheep.y >= pad.y + pad.h, "outside the fence");
});

test("demolishing buildings: sites refund half, completed buildings release territory, others' buildings are refused", () => {
  const w = world();
  const p = w.players.get(1)!;
  const spot = w.findBuildSpot(w.units.get([...w.unitsOf(1)][0]!)!, "stockpile")!;
  const site = w.placeBuilding(1, "stockpile", spot.x, spot.y);
  assert.ok(site.ok, site.ok ? "" : site.message);
  const wood = p.resources.wood;
  const cost = w.scaledCost(1, { wood: 40 }, "buildingCost").wood;
  const r = w.demolishBuilding(1, site.value.id);
  assert.ok(r.ok);
  assert.equal(p.resources.wood, wood + Math.floor(cost / 2), "half the site's cost back");
  assert.ok(!w.buildings.has(site.value.id));
  // A completed building: no refund, its territory goes.
  const op = w.addBuilding(1, "outpost", p.spawnX + 22, p.spawnY, true);
  (w as unknown as { claimTerritory: (b: BuildingState) => void }).claimTerritory(op);
  assert.equal(w.territory.ownerAt(op.x + 5, op.y), 1);
  const wood2 = p.resources.wood;
  assert.ok(w.demolishBuilding(1, op.id).ok);
  assert.equal(p.resources.wood, wood2);
  assert.equal(w.territory.ownerAt(op.x + 5, op.y), 0, "territory released");
  // Not yours.
  assert.equal((w.demolishBuilding(1, hall(w, 2).id) as { code: string }).code, "permission_denied");
  // Removing everything you have founds a new settlement (as when it is destroyed).
  assert.ok(w.dismissUnits(1, [...w.unitsOf(1)]).ok);
  for (const id of [...w.buildingsOf(1)]) assert.ok(w.demolishBuilding(1, id).ok);
  w.step();
  assert.equal(w.unitsOf(1).size, 3, "re-founded with three units");
  assert.ok(hall(w, 1));
});

test("dismiss and demolish over the network", () => {
  const s = makeServer();
  const a = new TestClient(s.game);
  a.hello("alice");
  const b = new TestClient(s.game);
  b.hello("bobby");
  for (let i = 0; i < 3; i++) s.game.tickOnce();
  const mine = a.own().map((u) => u.id);
  const theirs = b.own()[0]!.id;
  const bad = a.request({ t: "unit_dismiss", unitIds: [theirs] })[0];
  assert.equal(bad?.t, "error");
  assert.equal(a.request({ t: "unit_dismiss", unitIds: [] })[0]?.t, "error", "an empty list is malformed");
  const ok1 = a.request({ t: "unit_dismiss", unitIds: [mine[0]] })[0];
  assert.ok(ok1?.t === "ack" && /dismissed/.test(ok1.message ?? ""), JSON.stringify(ok1));
  s.game.tickOnce();
  assert.ok(!a.units.has(mine[0]!), "the client is told the unit is gone");
  const spot = s.world.findBuildSpot(s.world.units.get(mine[1]!)!, "stockpile")!;
  const site = a.request({ t: "place_building", type: "stockpile", x: spot.x, y: spot.y })[0];
  assert.equal(site?.t, "ack", JSON.stringify(site));
  s.game.tickOnce();
  const sid = [...a.buildings.values()].find((x) => x.type === "stockpile")!.id;
  const dem = a.request({ t: "building_demolish", buildingId: sid })[0];
  assert.ok(dem?.t === "ack" && /refunded \d+ wood/.test(dem.message ?? ""), JSON.stringify(dem));
  s.game.tickOnce();
  assert.ok(!a.buildings.has(sid));
  s.game.stop();
  s.store.close();
});
