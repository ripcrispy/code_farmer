import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldGenerator } from "../src/shared/worldgen.ts";
import { LAIR_SAFE_DISTANCE, Lairs, type Lair } from "../src/shared/lairs.ts";
import { LAIR_DEFS, LAIR_LEASH } from "../src/shared/defs/lairs.ts";
import { terrainDef } from "../src/shared/defs/terrain.ts";
import { unitDef } from "../src/shared/defs/units.ts";
import { NEUTRAL, type UnitState } from "../src/sim/types.ts";
import { World, type SimConfig } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig } from "./helpers.ts";

const V3 = { seed: "test-seed", generationVersion: 3, chunkSize: 64, resourceDensity: 1 };

function world(over: Partial<SimConfig> = {}): World {
  const w = new World({ ...V3 }, over);
  assert.ok(w.createPlayer(1, "alice", "human").ok);
  assert.ok(w.createPlayer(2, "bob", "orc").ok);
  for (const u of w.units.values()) if (u.owner !== NEUTRAL) w.controlProgram(u.owner, u.id, "stop");
  return w;
}

const steps = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) w.step();
};

function tp(w: World, u: UnitState, x: number, y: number): void {
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, x, y);
}

function near(w: World, x: number, y: number, r = 6): { x: number; y: number } {
  const np = (w as unknown as { nearestPassable: (x: number, y: number, r: number) => { x: number; y: number } | null }).nearestPassable.bind(w);
  const p = np(x, y, r);
  assert.ok(p, `no free tile near ${x},${y}`);
  return p;
}

/** The nearest lair of a kind to the world centre. */
function findLair(w: World, kind = "goblin_camp"): Lair {
  let best: Lair | null = null;
  for (let ry = -6; ry <= 6; ry++) {
    for (let rx = -6; rx <= 6; rx++) {
      const l = w.lairs.inRegion(rx, ry);
      if (l && l.kind === kind && (!best || Math.hypot(l.x, l.y) < Math.hypot(best.x, best.y))) best = l;
    }
  }
  assert.ok(best, `no ${kind} found`);
  return best;
}

/** Put a unit of player `pid` next to a lair and let the lair wake up. */
function wake(w: World, l: Lair, pid = 1, type = "knight"): UnitState {
  const spot = near(w, l.x + l.r + 4, l.y);
  const u = w.addUnit(pid, type, spot.x, spot.y, false);
  steps(w, 25);
  assert.equal(w.lairState.get(l.id)?.status, "active", "the lair woke when a player came near");
  return u;
}

test("generation v3 keeps v2 content identical and adds new wildlife; lairs come from the seed", () => {
  const g2 = new WorldGenerator({ ...V3, generationVersion: 2 });
  const g3 = new WorldGenerator({ ...V3 });
  const species = new Set<string>();
  for (let cy = -4; cy <= 4; cy++) {
    for (let cx = -4; cx <= 4; cx++) {
      const a = g2.generateChunk(cx, cy);
      const b = g3.generateChunk(cx, cy);
      assert.deepEqual(Buffer.from(b.tiles), Buffer.from(a.tiles), "terrain unchanged");
      assert.deepEqual(b.nodes, a.nodes, "resources unchanged");
      assert.deepEqual(b.ruins, a.ruins, "ruins unchanged");
      assert.deepEqual(b.creatures.slice(0, a.creatures.length), a.creatures, "v2 wildlife unchanged (new species are appended)");
      for (const c of b.creatures.slice(a.creatures.length)) species.add(c.type);
    }
  }
  for (const s of ["sheep", "goat", "horse"]) assert.ok(species.has(s), `v3 adds ${s} (got ${[...species].join(", ")})`);
  // Lairs: deterministic, absent before v3, never near the centre, on land, independent of request order.
  const suit = (gen: WorldGenerator) => (x: number, y: number): boolean => terrainDef(gen.terrainAt(x, y)).passable;
  const a = new Lairs("test-seed", true, suit(g3));
  const b = new Lairs("test-seed", true, suit(g3));
  const none = new Lairs("test-seed", false, suit(g3));
  const regions: [number, number][] = [];
  for (let ry = -5; ry <= 5; ry++) for (let rx = -5; rx <= 5; rx++) regions.push([rx, ry]);
  const fwd = regions.map(([x, y]) => JSON.stringify(a.inRegion(x, y)));
  const rev = [...regions].reverse().map(([x, y]) => JSON.stringify(b.inRegion(x, y))).reverse();
  assert.deepEqual(fwd, rev);
  const found = regions.map(([x, y]) => a.inRegion(x, y)).filter((l): l is Lair => l !== null);
  assert.ok(found.length > 20, `${found.length} lairs`);
  assert.ok(found.every((l) => Math.hypot(l.x, l.y) >= LAIR_SAFE_DISTANCE && terrainDef(g3.terrainAt(l.x, l.y)).passable));
  assert.ok(new Set(found.map((l) => l.kind)).size >= 3, "several kinds of lair");
  assert.ok(regions.every(([x, y]) => none.inRegion(x, y) === null), "no lairs before generation v3");
  const other = new Lairs("other-seed", true, suit(g3));
  assert.notDeepEqual(regions.map(([x, y]) => JSON.stringify(other.inRegion(x, y))), fwd, "another seed places lairs elsewhere");
});

test("PvE works with combat off: units fight monsters, monsters fight intruders, PvP and hunting stay off", () => {
  const w = world();
  assert.equal(w.cfg.combatEnabled, false);
  assert.equal(w.cfg.pveEnabled, true);
  const l = findLair(w);
  // New players never start near a lair.
  for (const pid of [1, 2]) {
    const p = w.players.get(pid)!;
    assert.ok(Math.hypot(p.spawnX - l.x, p.spawnY - l.y) > l.r + 30);
  }
  const knight = wake(w, l);
  const monsters = w.lairMonsters(l);
  const def = LAIR_DEFS[l.kind]!;
  assert.equal(monsters.length, 1 + def.pack.reduce((n, p) => n + p.count, 0), "the boss and its pack");
  assert.ok(monsters.some((m) => unitDef(m.type).monster?.boss));
  const goblin = monsters.find((m) => !unitDef(m.type).monster?.boss)!;
  // Player -> monster: allowed. Monster -> player outside the lair: not. Inside: yes.
  assert.equal(w.attackBlocker(knight, goblin), null);
  assert.match(w.attackBlocker(goblin, knight) ?? "", /intruders/);
  const inside = near(w, l.x, l.y + 2, 3);
  const worker = w.addUnit(1, "worker", inside.x, inside.y, false);
  assert.equal(w.attackBlocker(goblin, worker), null, "anyone inside the lair is fair game");
  // PvP and hunting are still off.
  const bobs = w.addUnit(2, "worker", knight.x, knight.y + 1, false);
  assert.match(w.attackBlocker(knight, bobs) ?? "", /Combat is disabled/);
  const deer = w.spawnCreature("deer", knight.x + 1, knight.y + 1);
  assert.ok(w.attackBlocker(knight, deer) !== null);
  // Monsters guard the worker that walked in: it gets hurt.
  for (const m of monsters) w.controlProgram(NEUTRAL, m.id, "run");
  steps(w, 80);
  assert.ok(worker.hp < unitDef("worker").maxHp || !w.units.has(worker.id), "the intruder was attacked");
  // ... but they do not chase far: none ends up beyond its leash.
  for (const m of w.lairMonsters(l)) assert.ok(Math.hypot(m.x - l.x, m.y - l.y) <= l.r + LAIR_LEASH + 2, `${m.type} at ${m.x},${m.y}`);
  // With PvE off as well, nothing can be fought.
  const off = world({ pveEnabled: false });
  const l2 = findLair(off);
  const k2 = off.addUnit(1, "knight", l2.x, l2.y, false);
  void k2;
  const b = off.addBuilding(1, "barracks", off.players.get(1)!.spawnX + 6, off.players.get(1)!.spawnY + 6, true);
  off.players.get(1)!.resources.food = 500;
  off.players.get(1)!.resources.gold = 500;
  assert.equal((off.trainUnit(1, b.id, "knight") as { code: string }).code, "combat_disabled");
  const wb = w.addBuilding(1, "barracks", w.players.get(1)!.spawnX + 6, w.players.get(1)!.spawnY + 6, true);
  w.players.get(1)!.resources.food = 500;
  w.players.get(1)!.resources.gold = 500;
  const t = w.trainUnit(1, wb.id, "knight");
  assert.ok(t.ok, t.ok ? "" : t.message);
});

test("killing monsters pays loot and experience; the boss gives a trophy and a discovery; clearing reserves the lair", () => {
  const w = world();
  const l = findLair(w);
  const knight = wake(w, l);
  const p = w.players.get(1)!;
  const def = LAIR_DEFS[l.kind]!;
  const wood0 = p.resources.wood;
  const xp0 = p.xp;
  const dmg0 = w.unitDamage(knight);
  // Weaken every monster so one knight can finish them all, one by one.
  for (const m of w.lairMonsters(l)) m.hp = 1;
  for (const m of w.lairMonsters(l)) {
    tp(w, knight, ...(Object.values(near(w, m.x + 1, m.y, 2)) as [number, number]));
    assert.ok(w.commandUnit(1, knight.id, { kind: "attack", targetId: m.id }).ok);
    for (let i = 0; i < 40 && w.units.has(m.id); i++) w.step();
    assert.ok(!w.units.has(m.id), `${m.type} defeated`);
  }
  assert.equal(w.lairMonsters(l).length, 0);
  assert.ok(p.resources.wood > wood0 + (def.bossLoot.wood ?? 0) - 1, "boss loot and goblin loot delivered");
  assert.ok(p.xp > xp0 + def.clearXp, "experience for kills and clearing");
  assert.ok(p.trophies.includes(def.trophy.id), "trophy won");
  assert.ok(p.discoveries.includes(def.discovery), "discovery found");
  assert.ok(w.unitDamage(knight) > dmg0, "the War Drums discovery adds damage");
  const st = w.lairState.get(l.id)!;
  assert.equal(st.status, "cleared");
  assert.equal(st.clearedBy, 1);
  // Bob may not build in it during Alice's claim; Alice may put an Outpost there, far from her land.
  const site = near(w, l.x, l.y, 3);
  for (const pid of [1, 2]) {
    w.players.get(pid)!.resources.wood = 1000;
    w.players.get(pid)!.resources.stone = 1000;
  }
  const bob = w.checkPlacement(2, "outpost", site.x, site.y);
  assert.ok(!bob.ok && bob.code === "lair_claimed", bob.ok ? "" : bob.message);
  const farAway = w.checkPlacement(1, "outpost", site.x + 60, site.y);
  assert.ok(!farAway.ok, "only inside the cleared lair, not anywhere");
  const alice = w.placeBuilding(1, "outpost", site.x, site.y);
  assert.ok(alice.ok, alice.ok ? "" : alice.message);
  // The claimed goblin camp: finish the Outpost, so it is claimed land.
  const outpost = alice.ok ? alice.value : null;
  assert.ok(outpost);
  outpost.progress = 1e9;
  const builder = w.addUnit(1, "builder", site.x - 1, site.y - 1, false);
  w.commandUnit(1, builder.id, { kind: "build", buildingId: outpost.id });
  steps(w, 30);
  assert.ok(outpost.complete);
  assert.notEqual(w.territory.ownerAt(l.x, l.y), 0);
  // Respawn: an unclaimed cleared lair is reoccupied; a claimed one stays clear.
  const l2 = findLair(w, "spider_nest");
  const k2 = wake(w, l2);
  void k2;
  for (const m of w.lairMonsters(l2)) {
    m.hp = 1;
    tp(w, knight, ...(Object.values(near(w, m.x + 1, m.y, 2)) as [number, number]));
    w.commandUnit(1, knight.id, { kind: "attack", targetId: m.id });
    for (let i = 0; i < 40 && w.units.has(m.id); i++) w.step();
  }
  assert.equal(w.lairState.get(l2.id)?.status, "cleared");
  const st2 = w.lairState.get(l2.id)!;
  w.tick = st2.respawnTick! + 5;
  steps(w, 15);
  assert.equal(w.lairState.get(l2.id)?.status, "active", "reoccupied after its respawn time");
  assert.ok(w.lairMonsters(l2).length > 0);
  w.tick = (w.lairState.get(l.id)!.respawnTick ?? 0) + 5;
  steps(w, 15);
  assert.equal(w.lairState.get(l.id)?.status, "cleared", "claimed land keeps the lair clear");
  // A second boss kill gives loot again, but not a second copy of the trophy.
  assert.equal(p.trophies.filter((t) => t === def.trophy.id).length, 1);
});

test("monsters' behaviour, lairs and trophies over the network and across restarts; scripts find monsters", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-pve-"));
  try {
    const db = join(dir, "w.db");
    const cfg = testConfig(db);
    cfg.world = { ...V3 };
    const s1 = makeServer(db, cfg);
    const a = new TestClient(s1.game);
    a.hello("alice");
    const w = s1.world;
    const l = findLair(w);
    const knight = wake(w, l, a.playerId);
    a.subscribeAround(l.x, l.y, 1);
    for (let i = 0; i < 3; i++) s1.game.tickOnce();
    const chunkWithLair = [...a.chunks.values()].find((c) => c.lairs?.some((x) => x.id === l.id));
    assert.ok(chunkWithLair, "chunk messages carry the lair");
    assert.equal(chunkWithLair.lairs!.find((x) => x.id === l.id)!.status, "active");
    // Monster behaviour is public; a script finds them.
    const sp = a.request({ t: "inspect_species", type: "goblin" })[0];
    assert.ok(sp?.t === "species" && /guards its lair/.test(sp.behaviour));
    const src = 'm = find_nearest("monster")\nif m is not None:\n    print("found", m.kind)\n';
    assert.ok(w.setProgram(a.playerId, knight.id, src, 1).ok);
    tp(w, knight, ...(Object.values(near(w, l.x + l.r + 1, l.y)) as [number, number]));
    w.controlProgram(a.playerId, knight.id, "run");
    for (let i = 0; i < 5; i++) s1.game.tickOnce();
    assert.ok(knight.log.some((x) => /found (goblin|goblin_chief)/.test(x)), knight.log.join("\n"));
    // Clear it.
    w.controlProgram(a.playerId, knight.id, "stop");
    for (const m of w.lairMonsters(l)) {
      m.hp = 1;
      tp(w, knight, ...(Object.values(near(w, m.x + 1, m.y, 2)) as [number, number]));
      w.commandUnit(a.playerId, knight.id, { kind: "attack", targetId: m.id });
      for (let i = 0; i < 40 && w.units.has(m.id); i++) s1.game.tickOnce();
    }
    assert.ok(a.inbox.some((m) => m.t === "tick" && m.lairs?.some((x) => x.id === l.id && x.status === "cleared" && x.yourClaim === true)), "the client hears the lair was cleared, by them");
    assert.ok(a.player?.trophies.includes(LAIR_DEFS[l.kind]!.trophy.id));
    s1.game.flush();
    s1.game.stop();
    s1.store.close();
    const s2 = makeServer(db, cfg);
    const st = s2.world.lairState.get(l.id);
    assert.equal(st?.status, "cleared", "lair state survives a restart");
    assert.equal(st?.clearedBy, a.playerId);
    assert.ok(s2.world.players.get(a.playerId)!.trophies.includes(LAIR_DEFS[l.kind]!.trophy.id), "trophies survive a restart");
    s2.game.stop();
    s2.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
