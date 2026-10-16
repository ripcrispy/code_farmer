import { test } from "node:test";
import { LESSONS } from "../src/shared/defs/lessons.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldGenerator } from "../src/shared/worldgen.ts";
import { compileSource } from "../src/script/compiler.ts";
import { NEUTRAL, type UnitState } from "../src/sim/types.ts";
import { World } from "../src/sim/world.ts";
import { TestClient, makeServer, runUntil, stepWorld, testConfig } from "./helpers.ts";

const V2 = { seed: "test-seed", generationVersion: 2, chunkSize: 64, resourceDensity: 1 };

function v2World(): World {
  return new World(V2);
}

function setup(race = "high_elf"): { w: World; units: UnitState[] } {
  const w = v2World();
  assert.ok(w.createPlayer(1, "alice", race).ok);
  const units = [...w.unitsOf(1)].map((id) => w.units.get(id) as UnitState);
  for (const u of units) w.controlProgram(1, u.id, "stop");
  w.step();
  return { w, units };
}

function tp(w: World, u: UnitState, x: number, y: number): void {
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, x, y);
}

function runScript(w: World, u: UnitState, src: string, ticks: number): void {
  const r = w.setProgram(u.owner, u.id, src, 1);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.ok(w.controlProgram(u.owner, u.id, "run").ok);
  for (let i = 0; i < ticks && u.program.state === "running"; i++) w.step();
}

test("generation v2 keeps v1 terrain and nodes identical and adds deterministic features", () => {
  const v1 = new WorldGenerator({ ...V2, generationVersion: 1 });
  const v2 = new WorldGenerator(V2);
  let ruins = 0;
  let creatures = 0;
  for (let cy = -3; cy < 3; cy++) {
    for (let cx = -3; cx < 3; cx++) {
      const a = v1.generateChunk(cx, cy);
      const b = v2.generateChunk(cx, cy);
      assert.deepEqual(Buffer.from(b.tiles), Buffer.from(a.tiles));
      assert.deepEqual(b.nodes, a.nodes);
      assert.equal(a.ruins.length + a.creatures.length, 0, "v1 has no features");
      assert.deepEqual(new WorldGenerator(V2).generateChunk(cx, cy).ruins, b.ruins, "features are deterministic");
      ruins += b.ruins.length;
      creatures += b.creatures.length;
      for (const r of b.ruins) assert.ok(!b.nodes.some((n) => n.x === r.x && n.y === r.y));
    }
  }
  assert.ok(ruins >= 4 && ruins <= 24, `ruins ${ruins}`);
  assert.ok(creatures >= 5, `creatures ${creatures}`);
});

test("wildlife spawns once per chunk, runs its own program near players, and sleeps elsewhere", () => {
  const { w } = setup();
  stepWorld(w, 20);
  const wild = [...w.unitsOf(NEUTRAL)].map((id) => w.units.get(id)!);
  assert.ok(wild.length > 0, "creatures spawned in generated chunks");
  assert.ok(wild.every((c) => c.program.state === "running" && c.home));
  const count = wild.length;
  // Generating far-away chunks (eviction churn, pathfinding) populates nothing, and
  // regenerating chunks near the player (after eviction) never re-spawns their creatures.
  for (let i = 0; i < 600; i++) w.chunks.getChunk(1000 + i, 1000);
  stepWorld(w, 15);
  assert.equal([...w.unitsOf(NEUTRAL)].length, count, "no spawns far from players, no duplicates after regeneration");
  // Creatures far from every player are dormant (no script instructions, no movement).
  const p = w.players.get(1)!;
  const sleeper = w.spawnCreature("deer", p.spawnX + 64 * 8, p.spawnY);
  stepWorld(w, 15);
  const pos = { x: sleeper.x, y: sleeper.y };
  const ops = sleeper.vm?.totalOps ?? 0;
  stepWorld(w, 100);
  assert.deepEqual({ x: sleeper.x, y: sleeper.y }, pos);
  assert.equal(sleeper.vm?.totalOps ?? 0, ops);
});

test("ruins: salvage once per world, inscription unlocks scan() for everyone who reads it", () => {
  const w = v2World();
  assert.ok(w.createPlayer(1, "a", "undead").ok);
  assert.ok(w.createPlayer(2, "b", "high_elf").ok);
  w.step();
  const a = [...w.unitsOf(1)].map((id) => w.units.get(id)!).find((u) => u.type === "scout")!;
  const b = [...w.unitsOf(2)].map((id) => w.units.get(id)!).find((u) => u.type === "scout")!;
  for (const u of [...w.unitsOf(1), ...w.unitsOf(2)].map((id) => w.units.get(id)!)) w.controlProgram(u.owner, u.id, "stop");
  // Find a common ruin near the first player's scout by scanning chunks around it.
  let ruin = null;
  for (let r = 0; r < 6 && !ruin; r++) {
    for (let dy = -r; dy <= r && !ruin; dy++) for (let dx = -r; dx <= r && !ruin; dx++) {
      const c = w.chunks.getChunk(Math.floor(a.x / 64) + dx, Math.floor(a.y / 64) + dy);
      ruin = c.ruins.find((x) => x.tier === "common" && w.isPassable(x.x + 1, x.y)) ?? null;
    }
  }
  assert.ok(ruin, "a ruin nearby");
  // scan() is locked before the discovery.
  const locked = compileSource('x = scan("tree")', { unlocks: w.mods(1).unlocks });
  assert.ok(!locked.ok && /locked.*Surveyor's Lens/.test(locked.diagnostics[0]!.message));
  tp(w, a, ruin.x + 1, ruin.y);
  const gold0 = w.players.get(1)!.resources.gold;
  runScript(w, a, 'r = find_nearest("ruin")\nfound = investigate(r)\nprint("found", found)\n', 400);
  assert.equal(a.program.state, "finished", a.log.join("\n"));
  assert.ok(a.log.some((l) => l.includes("found Surveyor's Lens")), a.log.join("\n"));
  assert.equal(w.players.get(1)!.resources.gold, gold0 + Math.round(15 * 1.5), "undead salvage bonus");
  assert.ok(w.players.get(1)!.discoveries.includes("surveyors_lens"));
  assert.ok(w.lootedRuins.has(`${ruin.x},${ruin.y}`));
  // The unlock is a real capability: scan() compiles and returns objects.
  runScript(w, a, 'xs = scan("tree")\nprint("scanned", len(xs), xs[0].kind)\n', 20);
  assert.ok(a.log.some((l) => /scanned \d+ tree/.test(l)), a.log.join("\n"));
  // Another player reads the same inscription but gets no salvage.
  tp(w, b, ruin.x - 1, ruin.y);
  const gold2 = w.players.get(2)!.resources.gold;
  runScript(w, b, 'investigate(find_nearest("ruin"))\n', 400);
  assert.equal(w.players.get(2)!.resources.gold, gold2);
  assert.ok(w.players.get(2)!.discoveries.includes("surveyors_lens"));
  // Re-reading a ruin that gives nothing new awards no experience (no XP farming).
  // (Coding lessons are marked done so the print() below cannot earn lesson experience.)
  w.players.get(2)!.lessons = LESSONS.map((l) => l.id);
  const xp = w.players.get(2)!.xp;
  runScript(w, b, 'print("again", investigate(find_nearest("ruin")))\n', 400);
  assert.ok(b.log.some((l) => l.includes("again")), b.log.join("\n"));
  assert.equal(w.players.get(2)!.xp, xp);
});

test("manual orders: right-click investigate/observe/tame are validated by the server", () => {
  const { w, units } = setup();
  const scout = units.find((u) => u.type === "scout")!;
  const worker = units.find((u) => u.type === "woodcutter")!;
  const deer = w.spawnCreature("deer", scout.x + 3, scout.y);
  const boar = w.spawnCreature("boar", scout.x + 3, scout.y + 1);
  w.controlProgram(NEUTRAL, deer.id, "stop");
  w.controlProgram(NEUTRAL, boar.id, "stop");
  const far = w.spawnCreature("wolf", scout.x + 200, scout.y);
  // A manual order stops the program; the action it was waiting on is closed in the trace.
  runScript(w, scout, "wait(100)\n", 5);
  assert.equal(scout.trace.at(-1)?.result, "");
  assert.ok(w.commandUnit(1, scout.id, { kind: "move", x: scout.x + 1, y: scout.y }).ok);
  assert.equal(scout.trace.at(-1)?.result, "cancelled (program stopped)");
  // Vision is enforced by the server (see multiplayer tests); here a far creature is a valid target.
  assert.ok(far.owner === NEUTRAL);
  const r2 = w.commandUnit(1, scout.id, { kind: "observe", targetId: 999999 });
  assert.ok(!r2.ok && r2.code === "not_found");
  // Not a creature / not someone else's unit.
  assert.ok(!w.commandUnit(1, scout.id, { kind: "observe", targetId: worker.id }).ok);
  assert.ok(!w.commandUnit(1, scout.id, { kind: "investigate", x: scout.x, y: scout.y }).ok || !!w.chunks.ruinAt(scout.x, scout.y));
  // Taming an unobserved species is refused with the reason.
  worker.inventory.food = 50;
  const t0 = w.commandUnit(1, worker.id, { kind: "tame", targetId: deer.id });
  assert.ok(!t0.ok && /cannot be tamed/.test(t0.message), t0.ok ? "" : t0.message);
  const t = w.commandUnit(1, worker.id, { kind: "tame", targetId: boar.id });
  assert.ok(!t.ok && /Observe a wild boar first/.test(t.message), t.ok ? "" : t.message);
  assert.ok(w.commandUnit(1, scout.id, { kind: "observe", targetId: boar.id }).ok);
  for (let i = 0; i < 400 && !w.players.get(1)!.observed.includes("boar"); i++) w.step();
  assert.ok(w.players.get(1)!.observed.includes("boar"));
  assert.ok(w.commandUnit(1, worker.id, { kind: "tame", targetId: boar.id }).ok);
  for (let i = 0; i < 400 && boar.owner !== 1; i++) w.step();
  assert.equal(boar.owner, 1, "tamed by manual order");
});

test("creature chain: observe reveals behaviour, taming needs food, training a wolf to guard keeps boars away", () => {
  const { w, units } = setup();
  const p = w.players.get(1)!;
  const scout = units.find((u) => u.type === "scout")!;
  const worker = units.find((u) => u.type === "woodcutter")!;
  const wolf = w.spawnCreature("wolf", scout.x + 4, scout.y);
  const boar = w.spawnCreature("boar", scout.x - 4, scout.y);
  // Keep the test creatures where they are.
  w.controlProgram(NEUTRAL, wolf.id, "stop");
  // Taming before observing is refused with a clear reason.
  worker.inventory.food = 60;
  runScript(w, worker, 'ok = tame(find_nearest("wolf"))\nprint("tame", ok)\n', 50);
  assert.ok(worker.log.some((l) => /Observe a wolf first/.test(l)), worker.log.join("\n"));
  runScript(w, scout, 'ok = observe(find_nearest("wolf"))\nprint("observed", ok)\n', 400);
  assert.ok(scout.log.some((l) => l.includes("observed True")), scout.log.join("\n"));
  assert.deepEqual(p.observed, ["wolf"]);
  // Not enough food carried -> refused; with food -> tamed, ownership transfers atomically.
  worker.inventory.food = 10;
  runScript(w, worker, 'print("tame", tame(find_nearest("wolf")))\n', 50);
  assert.ok(worker.log.some((l) => /needs 50 food/.test(l)));
  worker.inventory.food = 60;
  runScript(w, worker, 'print("tame", tame(find_nearest("wolf")))\n', 600);
  assert.ok(worker.log.some((l) => l.includes("tame True")), worker.log.join("\n"));
  assert.equal(wolf.owner, 1);
  assert.equal(worker.inventory.food, 10);
  assert.ok(w.unitsOf(1).has(wolf.id) && !w.unitsOf(NEUTRAL).has(wolf.id));
  assert.equal(wolf.program.state, "running", "tamed creatures run their tamed program");
  // A wolf cannot guard until trained.
  w.controlProgram(1, wolf.id, "stop");
  runScript(w, wolf, "print('guard', guard(0, 0, 5))\n", 30);
  assert.ok(wolf.log.some((l) => /not been trained to guard/.test(l)), wolf.log.join("\n"));
  worker.inventory.food = 40;
  // Put the (now owned) wolf right next to the worker so find_nearest("unit") picks it.
  tp(w, wolf, worker.x + 1, worker.y);
  runScript(w, worker, 'w = find_nearest("unit")\nprint("kind", w.kind)\nprint("train", train_creature(w, "guard"))\n', 600);
  assert.ok(worker.log.some((l) => l.includes("train True")), worker.log.join("\n"));
  assert.deepEqual(wolf.learned, ["guard"]);
  assert.ok(p.discoveries.includes("pack_discipline"));
  // Guarding: a wild boar ignores berries within 8 tiles of the guarding wolf.
  const bush = w.findNearest(scout, "berries")!;
  tp(w, boar, bush.x + 2, bush.y);
  runScript(w, wolf, `guard(${bush.x}, ${bush.y}, 60)\n`, 1);
  for (let i = 0; i < 100 && wolf.activity !== "guarding"; i++) w.step();
  assert.equal(wolf.activity, "guarding");
  w.step(); // guard zones are collected at the start of each tick
  const seen = w.findNearest(boar, "berries");
  assert.ok(!seen || Math.max(Math.abs(seen.x - bush.x), Math.abs(seen.y - bush.y)) > 8, "boar avoids guarded berries");
  assert.ok(w.findNearest(scout, "berries"), "your own units are unaffected");
});

test("hidden discovery: observing a boar while it forages", () => {
  const { w, units } = setup();
  const scout = units.find((u) => u.type === "scout")!;
  const bush = w.findNearest(scout, "berries")!;
  const boar = w.spawnCreature("boar", bush.x + 1, bush.y);
  tp(w, scout, bush.x + 3, bush.y + 1);
  runScript(w, scout, 'observe(find_nearest("boar"))\n', 600);
  assert.ok(w.players.get(1)!.observed.includes("boar"));
  assert.ok(w.players.get(1)!.discoveries.includes("foragers_instinct"), `boar activity was ${boar.activity}; log: ${scout.log.join(" | ")}`);
  assert.ok(Math.abs(w.mods(1).pct["gather.food"] - 0.1) < 1e-9, "the discovery is a real bonus");
});

test("behaviour code is only revealed to players who observed the species; state persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-disc-"));
  const db = join(dir, "d.db");
  try {
    const cfg = testConfig(db);
    cfg.world = { ...V2 };
    let s = makeServer(db, cfg);
    const a = new TestClient(s.game);
    a.hello("alice");
    const r1 = a.request({ t: "inspect_species", type: "wolf" })[0];
    assert.ok(r1?.t === "error" && r1.code === "not_observed");
    const p = s.world.players.get(a.playerId)!;
    p.observed.push("wolf");
    p.discoveries.push("surveyors_lens");
    s.world.invalidateMods(p.id);
    s.world.markPlayer(p);
    const r2 = a.request({ t: "inspect_species", type: "wolf" })[0];
    assert.ok(r2?.t === "species" && /wander\(10\)/.test(r2.behaviour));
    runUntil(s.game, () => [...s.world.unitsOf(NEUTRAL)].length > 0, 50, "wildlife spawned");
    a.subscribeAround(a.spawn.x, a.spawn.y, 1);
    s.game.tickOnce();
    assert.ok([...a.units.values()].some((u) => u.owner === NEUTRAL), "wild creatures are visible");
    assert.ok([...a.units.values()].filter((u) => u.owner === NEUTRAL).every((u) => u.own === undefined));
    const wildCount = s.world.unitsOf(NEUTRAL).size;
    s.game.stop();
    s.store.close();
    s = makeServer(db, cfg);
    const p2 = s.world.players.get(a.playerId)!;
    assert.deepEqual(p2.observed, ["wolf"]);
    assert.deepEqual(p2.discoveries, ["surveyors_lens"]);
    assert.ok(s.world.mods(p2.id).has("command:scan"));
    assert.equal(s.world.unitsOf(NEUTRAL).size, wildCount, "wildlife persisted, not re-spawned");
    s.game.stop();
    s.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observing a creature beyond the short path radius uses long-range routing", () => {
  const { w, units } = setup();
  const scout = units.find((u) => u.type === "scout")!;
  const np = (w as unknown as { nearestPassable: (x: number, y: number, r: number) => { x: number; y: number } | null }).nearestPassable.bind(w);
  // Pick a spot ~70 tiles away that a plain move can reach (some directions are cut off by water).
  const sx = scout.x;
  const sy = scout.y;
  let spot: { x: number; y: number } | null = null;
  for (const [dx, dy] of [[70, 0], [0, 70], [-70, 0], [0, -70], [50, 50], [-50, 50], [50, -50], [-50, -50]] as const) {
    const c = np(sx + dx, sy + dy, 6);
    if (!c) continue;
    tp(w, scout, sx, sy);
    assert.ok(w.commandUnit(1, scout.id, { kind: "move", x: c.x, y: c.y }).ok);
    for (let i = 0; i < 2000 && scout.task.kind !== "idle"; i++) w.step();
    if (scout.x === c.x && scout.y === c.y) {
      spot = c;
      break;
    }
  }
  assert.ok(spot, "a reachable spot ~70 tiles away");
  tp(w, scout, sx, sy);
  const deer = w.spawnCreature("deer", spot.x, spot.y);
  w.controlProgram(NEUTRAL, deer.id, "stop");
  assert.ok(w.commandUnit(1, scout.id, { kind: "observe", targetId: deer.id }).ok);
  for (let i = 0; i < 3000 && !w.players.get(1)!.observed.includes("deer"); i++) w.step();
  assert.ok(w.players.get(1)!.observed.includes("deer"), scout.log.join("\n"));
});

test("hunted or tamed wildlife slowly returns to wild land near players", () => {
  const { w } = setup();
  stepWorld(w, 40);
  const size = 64;
  const homeKey = (c: UnitState): string => `${Math.floor(c.home!.x / size)},${Math.floor(c.home!.y / size)}`;
  // Pick a populated chunk that has creatures, and remove them all.
  const byChunk = new Map<string, UnitState[]>();
  for (const id of w.unitsOf(NEUTRAL)) {
    const c = w.units.get(id)!;
    const k = homeKey(c);
    byChunk.set(k, [...(byChunk.get(k) ?? []), c]);
  }
  const [key, list] = [...byChunk].sort((a, b) => b[1].length - a[1].length)[0]!;
  assert.ok(list.length > 0);
  const remove = (w as unknown as { removeUnit: (u: UnitState) => void }).removeUnit.bind(w);
  for (const c of list) remove(c);
  const count = (): number => [...w.unitsOf(NEUTRAL)].filter((id) => homeKey(w.units.get(id)!) === key).length;
  assert.equal(count(), 0);
  // Within a minute at most one comes back (renewal is per chunk, once per 5 minutes).
  stepWorld(w, 600);
  const first = count();
  assert.ok(first <= 1, `${first} returned within a minute`);
  stepWorld(w, 3000);
  assert.ok(count() > first || count() >= 1, "creatures return over time");
  assert.ok(count() <= list.length, "never more than the chunk started with");
  for (const id of w.unitsOf(NEUTRAL)) {
    const c = w.units.get(id)!;
    if (homeKey(c) === key) assert.equal(w.territory.ownerAt(c.home!.x, c.home!.y), 0, "only on unclaimed land");
  }
});
