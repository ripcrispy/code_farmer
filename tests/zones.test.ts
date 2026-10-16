import { test } from "node:test";
import assert from "node:assert/strict";
import { ContestedZones, ZONE_MAX_RADIUS, ZONE_MIN_RADIUS, ZONE_REGION, ZONE_SAFE_REGIONS, inCircle } from "../src/shared/zones.ts";
import type { UnitState } from "../src/sim/types.ts";
import { World, type SimConfig } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig, PARAMS } from "./helpers.ts";

const land = (): boolean => true;

function tp(w: World, u: UnitState, x: number, y: number): void {
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, x, y);
}

/** A zone with a passable centre tile plus a passable tile just outside it. */
function findZone(w: World): { x: number; y: number; r: number; outside: { x: number; y: number } } {
  for (let ry = -6; ry < 6; ry++) {
    for (let rx = -6; rx < 6; rx++) {
      const z = w.zones.inRegion(rx, ry);
      if (!z || !w.isPassable(z.x, z.y)) continue;
      for (let d = z.r + 2; d < z.r + 12; d++) if (w.isPassable(z.x + d, z.y)) return { ...z, outside: { x: z.x + d, y: z.y } };
    }
  }
  throw new Error("no usable zone");
}

function setup(over: Partial<SimConfig> = {}): World {
  const w = new World({ ...PARAMS }, { combatEnabled: true, ...over });
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  assert.ok(w.createPlayer(2, "bob", "high_elf").ok);
  for (const u of w.units.values()) w.controlProgram(u.owner, u.id, "stop");
  return w;
}

test("zones are deterministic, small, absent around the world centre and independent of terrain", () => {
  const a = new ContestedZones("seed-1", land);
  const b = new ContestedZones("seed-1", land);
  const c = new ContestedZones("seed-2", land);
  let count = 0;
  let differ = false;
  for (let ry = -10; ry < 10; ry++) {
    for (let rx = -10; rx < 10; rx++) {
      const za = a.inRegion(rx, ry);
      assert.deepEqual(za, b.inRegion(rx, ry), "same seed, same zones");
      if (JSON.stringify(za) !== JSON.stringify(c.inRegion(rx, ry))) differ = true;
      const safe = rx >= -ZONE_SAFE_REGIONS && rx < ZONE_SAFE_REGIONS && ry >= -ZONE_SAFE_REGIONS && ry < ZONE_SAFE_REGIONS;
      if (safe) assert.equal(za, null, "no zones near the world centre");
      if (!za) continue;
      count++;
      assert.ok(za.r >= ZONE_MIN_RADIUS && za.r <= ZONE_MAX_RADIUS);
      // Entirely inside its own region, so a tile can only be in its own region's zone.
      assert.ok(za.x - za.r >= rx * ZONE_REGION && za.x + za.r < (rx + 1) * ZONE_REGION);
      assert.ok(za.y - za.r >= ry * ZONE_REGION && za.y + za.r < (ry + 1) * ZONE_REGION);
      assert.equal(a.at(za.x, za.y)?.id, za.id);
      assert.equal(a.at(za.x + za.r + 1, za.y), null);
    }
  }
  assert.ok(differ, "different seeds give different zones");
  assert.ok(count > 100 && count < 300, `about half the regions have a zone (${count}/400)`);
  // Zones do not change terrain: a v2 world's terrain hash is unaffected by the zone module.
  const w1 = new World({ ...PARAMS, generationVersion: 2 }, { combatEnabled: false });
  const w2 = new World({ ...PARAMS, generationVersion: 2 }, { combatEnabled: true });
  for (let i = 0; i < 200; i++) assert.equal(w1.gen.terrainAt(i * 37, -i * 11), w2.gen.terrainAt(i * 37, -i * 11));
});

test("inside a contested zone anyone may attack, opted in or not; outside the usual rules apply", () => {
  const w = setup();
  const z = findZone(w);
  const s = w.addUnit(1, "soldier", z.x, z.y, false);
  const v = w.addUnit(2, "worker", z.x + 1, z.y, false);
  assert.ok(!w.pvpActive(1) && !w.pvpActive(2), "nobody opted in");
  assert.equal(w.attackBlocker(s, v), null, "PvP is automatic inside the zone");
  assert.equal(w.attackBlocker(v, s), null, "and works both ways");
  assert.ok(w.commandUnit(1, s.id, { kind: "attack", targetId: v.id }).ok);
  for (let i = 0; i < 20; i++) w.step();
  assert.ok(v.hp < 50);
  // The defender runs outside: the attack ends.
  w.commandUnit(1, s.id, { kind: "stop" });
  tp(w, v, z.outside.x, z.outside.y);
  const why = w.attackBlocker(s, v);
  assert.ok(why && /not opted in/.test(why), String(why));
  // A building with any tile inside the zone is attackable; one outside is not.
  const inside = w.addBuilding(2, "stockpile", z.x - 1, z.y + 2, true);
  const outside = w.addBuilding(2, "stockpile", z.outside.x + 3, z.outside.y, true);
  assert.equal(w.buildingAttackBlocker(s, inside), null);
  assert.ok(w.buildingAttackBlocker(s, outside));
  // find_nearest("enemy") sees zone targets.
  tp(w, v, z.x + 2, z.y);
  assert.equal(w.findNearest(s, "enemy")?.id, `u:${v.id}`);
  // Wildlife still only fights back (zones are about players).
  const wolf = w.spawnCreature("wolf", z.x, z.y + 1);
  assert.ok(w.attackBlocker(wolf, v));
});

test("zones reward gathering and are off without combat or with contestedZones false", () => {
  const w = setup();
  const z = findZone(w);
  const u = w.addUnit(1, "worker", z.x, z.y, false);
  const inside = w.gatherRate(u, "wood", z.x, z.y);
  const out = w.gatherRate(u, "wood", z.outside.x, z.outside.y);
  assert.ok(Math.abs(inside / out - 1.5) < 1e-9, "+50% gathering inside");
  for (const over of [{ combatEnabled: false }, { combatEnabled: true, contestedZones: false }]) {
    const w2 = setup(over);
    const s = w2.addUnit(1, "soldier", z.x, z.y, false);
    const v = w2.addUnit(2, "worker", z.x + 1, z.y, false);
    assert.equal(w2.contestedZoneAt(z.x, z.y), null);
    assert.ok(w2.attackBlocker(s, v), JSON.stringify(over));
    assert.equal(w2.gatherRate(v, "wood", z.x, z.y), w2.gatherRate(v, "wood", z.outside.x, z.outside.y));
  }
});

test("new settlements are never founded next to a zone, and zones reach clients only when active", () => {
  const w = new World({ ...PARAMS }, { combatEnabled: true });
  // Crowd the zone-free centre with Town Halls so new settlements must go out among the zones.
  for (let y = -400; y <= 400; y += 40) for (let x = -400; x <= 400; x += 40) w.addBuilding(99, "town_hall", x, y, true);
  let farOut = 0;
  for (let i = 1; i <= 12; i++) {
    assert.ok(w.createPlayer(i, `p${i}`, "orc").ok);
    const p = w.players.get(i)!;
    if (Math.max(Math.abs(p.spawnX), Math.abs(p.spawnY)) > 400) farOut++;
    assert.equal(w.zones.near(p.spawnX, p.spawnY, 48).length, 0, `player ${i} spawned at ${p.spawnX},${p.spawnY}`);
  }
  assert.ok(farOut >= 10, "the settlements were founded in zone country");
  // Network: a chunk overlapping a zone carries it only when combat (and zones) are on.
  const zw = new World({ ...PARAMS }, { combatEnabled: true });
  const z = findZone(zw);
  for (const enabled of [true, false]) {
    const cfg = testConfig();
    cfg.combat.enabled = enabled;
    const { game, world } = makeServer(":memory:", cfg);
    const c = new TestClient(game);
    c.hello("zoe");
    const welcome = c.inbox.find((m) => m.t === "welcome") as { world: { contestedZones: boolean } };
    assert.equal(welcome.world.contestedZones, enabled);
    // Give the player presence near the zone so the chunk is within vision.
    const u = [...world.unitsOf(c.playerId)].map((id) => world.units.get(id)!)[0]!;
    tp(world, u, z.outside.x, z.outside.y);
    c.subscribeAround(z.x, z.y, 0);
    game.tickOnce();
    const chunkMsg = [...c.chunks.values()].find((m) => m.zones.length > 0 || (m.cx === Math.floor(z.x / 64) && m.cy === Math.floor(z.y / 64)));
    assert.ok(chunkMsg, "the zone's chunk arrived");
    assert.equal(chunkMsg.zones.some((q) => inCircle(q, z.x, z.y)), enabled);
    game.stop();
  }
});

test("scripts can ask whether something is in a contested zone", () => {
  const w = setup();
  const z = findZone(w);
  const u = w.addUnit(1, "worker", z.x, z.y, false);
  assert.ok(w.setProgram(1, u.id, `print("zone", in_contested_zone(), in_contested_zone(${z.outside.x}, ${z.outside.y}))\n`, 1).ok);
  w.controlProgram(1, u.id, "run");
  for (let i = 0; i < 5; i++) w.step();
  assert.ok(u.log.some((l) => l.includes("zone True False")), u.log.join("\n"));
});
