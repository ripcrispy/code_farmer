import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEVEL_THRESHOLDS, MAX_LEVEL, MAX_XP, XP_AWARDS, levelForXp, talentPointsForLevel } from "../src/shared/defs/progression.ts";
import { RACES } from "../src/shared/defs/races.ts";
import { TALENT_DEFS } from "../src/shared/defs/talents.ts";
import { unitDef } from "../src/shared/defs/units.ts";
import type { UnitState } from "../src/sim/types.ts";
import { TestClient, makeServer, makeWorld, runUntil, stepWorld } from "./helpers.ts";

test("experience curve: level 1 to 60, one talent point per even level", () => {
  assert.equal(levelForXp(0), 1);
  for (let l = 2; l <= MAX_LEVEL; l++) {
    assert.ok((LEVEL_THRESHOLDS[l] as number) > (LEVEL_THRESHOLDS[l - 1] as number));
    assert.equal(levelForXp(LEVEL_THRESHOLDS[l] as number), l);
    assert.equal(levelForXp((LEVEL_THRESHOLDS[l] as number) - 1), l - 1);
  }
  assert.equal(levelForXp(MAX_XP * 10), MAX_LEVEL);
  let points = 0;
  for (let l = 1; l <= MAX_LEVEL; l++) {
    const gained = talentPointsForLevel(l) - talentPointsForLevel(l - 1);
    assert.equal(gained, l % 2 === 0 ? 1 : 0, `level ${l}`);
    points += gained;
  }
  assert.equal(points, 30);
});

test("normal progression reaches level 60 with exactly 30 talent points, and the cap holds", () => {
  const w = makeWorld();
  w.createPlayer(1, "a", "human");
  const p = w.players.get(1)!;
  // Award experience the way gathering does, in many small amounts.
  let guard = 0;
  while (w.level(p) < MAX_LEVEL && guard++ < 1_000_000) w.awardXp(p, 500, "gathering");
  assert.equal(w.level(p), MAX_LEVEL);
  assert.equal(p.xp, MAX_XP);
  assert.equal(w.talentPoints(p), 30);
  w.awardXp(p, 1_000_000, "gathering");
  assert.equal(p.xp, MAX_XP, "experience is capped");
  assert.equal(w.talentPoints(p), 30, "no points beyond the cap");
  const ups = w.levelUps.filter((l) => l.playerId === 1).map((l) => l.level);
  assert.ok(ups.length > 1 && ups.every((l, i) => i === 0 || l > (ups[i - 1] as number)), "level-up events are increasing");
  assert.equal(ups.at(-1), MAX_LEVEL);
});

test("experience comes from real gameplay: gathering, construction and exploration", () => {
  const w = makeWorld();
  w.createPlayer(1, "a", "high_elf");
  const p = w.players.get(1)!;
  assert.equal(p.xp, 0, "the starting settlement awards nothing");
  const units = [...w.unitsOf(1)].map((id) => w.units.get(id) as UnitState);
  for (const u of units) w.controlProgram(1, u.id, "stop");
  const wc = units.find((u) => u.type === "woodcutter")!;
  const tree = w.findNearest(wc, "tree")!;
  assert.ok(w.commandUnit(1, wc.id, { kind: "gather", x: tree.x, y: tree.y }).ok);
  for (let i = 0; i < 2000 && wc.task.kind !== "idle"; i++) w.step();
  const gathered = wc.inventory.wood;
  assert.ok(gathered > 0);
  const xpFactor = 1 + (RACES.find((r) => r.id === "high_elf")!.passives.find((e) => "stat" in e && e.stat === "xpGain") as { pct: number }).pct;
  assert.ok(Math.abs(p.xp - Math.floor(gathered * XP_AWARDS.perResourceGathered * xpFactor)) <= 1, `xp ${p.xp} for ${gathered} wood`);
  // Farm production does not award experience.
  const xp0 = p.xp;
  const hall = [...w.buildingsOf(1)].map((id) => w.buildings.get(id)!)[0]!;
  const farm = w.addBuilding(1, "farm", hall.x + 6, hall.y + 6, true);
  stepWorld(w, 600);
  assert.ok(p.resources.food > 50);
  assert.equal(p.xp, xp0);
  void farm;
  // Exploration: the first visit to a chunk awards experience once.
  const scout = units.find((u) => u.type === "scout")!;
  const before = p.explored.size;
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(scout, scout.x + 64 * 5, scout.y);
  assert.equal(p.explored.size, before + 1);
  const afterExplore = p.xp;
  assert.ok(afterExplore > xp0);
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(scout, scout.x - 64 * 5, scout.y);
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(scout, scout.x + 64 * 5, scout.y);
  assert.equal(p.xp, afterExplore, "revisiting a chunk awards nothing");
});

test("talent allocation enforces points, level, prerequisites, race and rank limits", () => {
  const w = makeWorld();
  w.createPlayer(1, "a", "human");
  const p = w.players.get(1)!;
  const r0 = w.allocateTalent(1, "lumberjack");
  assert.ok(!r0.ok && r0.code === "level_too_low");
  p.xp = LEVEL_THRESHOLDS[2] as number;
  assert.equal(w.talentPoints(p), 1);
  const wc = [...w.unitsOf(1)].map((id) => w.units.get(id)!).find((u) => u.type === "woodcutter")!;
  const rate0 = w.gatherRate(wc, "wood", wc.x, wc.y);
  assert.ok(w.allocateTalent(1, "lumberjack").ok);
  assert.ok(Math.abs(w.gatherRate(wc, "wood", wc.x, wc.y) / rate0 - (1 + 0.1 + 0.05) / (1 + 0.1)) < 1e-9, "talent effect applied on top of the race bonus");
  const noPts = w.allocateTalent(1, "lumberjack");
  assert.ok(!noPts.ok && noPts.code === "no_points");
  p.xp = LEVEL_THRESHOLDS[30] as number;
  assert.equal(w.talentPoints(p), 15);
  const pre = w.allocateTalent(1, "bargaining");
  assert.ok(!pre.ok && pre.code === "missing_prerequisite");
  assert.ok(w.allocateTalent(1, "thrift").ok);
  assert.ok(w.allocateTalent(1, "bargaining").ok);
  const race = w.allocateTalent(1, "warband");
  assert.ok(!race.ok && race.code === "wrong_race");
  assert.ok(w.allocateTalent(1, "lumberjack").ok);
  assert.ok(w.allocateTalent(1, "lumberjack").ok);
  const max = w.allocateTalent(1, "lumberjack");
  assert.ok(!max.ok && max.code === "max_rank");
  for (const bad of ["nope", "constructor", "__proto__", "toString"]) {
    const r = w.allocateTalent(1, bad);
    assert.ok(!r.ok && r.code === "bad_talent", bad);
  }
  assert.equal(w.spentTalentPoints(p), 5);
  // Reset refunds points for gold.
  p.resources.gold = 10;
  const poor = w.resetTalents(1);
  assert.ok(!poor.ok && poor.code === "insufficient_resources");
  p.resources.gold = 1000;
  const reset = w.resetTalents(1);
  assert.ok(reset.ok && reset.value === 5);
  assert.equal(p.resources.gold, 1000 - 5 * XP_AWARDS.respecGoldPerPoint);
  assert.equal(w.spentTalentPoints(p), 0);
  assert.equal(w.gatherRate(wc, "wood", wc.x, wc.y), rate0);
});

test("racial passives change the simulation", () => {
  const w = makeWorld();
  const races = ["dwarf", "orc", "troll", "human"];
  races.forEach((r, i) => assert.ok(w.createPlayer(i + 1, r, r).ok));
  const builderOf = (pid: number): UnitState => [...w.unitsOf(pid)].map((id) => w.units.get(id)!).find((u) => u.type === "builder")!;
  assert.equal(w.stat(1, "buildRate", 1), 1.25, "dwarves build faster");
  assert.deepEqual(w.scaledCost(2, unitDef("worker").cost!, "trainCost").food, 32, "orcs train cheaper");
  assert.equal(w.stat(3, "senseRadius", 20), 24, "trolls see further");
  assert.equal(w.scaledCost(4, { wood: 40 }, "buildingCost").wood, 36, "humans build cheaper");
  void builderOf;
  for (const r of RACES) assert.ok(r.passives.length >= 2, `${r.id} has passives`);
  for (const t of Object.values(TALENT_DEFS)) if (t.race) assert.ok(RACES.some((r) => r.id === t.race), t.id);
  for (const r of RACES) assert.ok(Object.values(TALENT_DEFS).filter((t) => t.race === r.id).length >= 2, `${r.id} has racial talents`);
});

test("progression over the network: level-up notice, idempotent allocation, persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-prog-"));
  const db = join(dir, "p.db");
  try {
    let s = makeServer(db);
    const a = new TestClient(s.game);
    a.hello("alice", { race: "orc" });
    const p = s.world.players.get(a.playerId)!;
    s.world.awardXp(p, (LEVEL_THRESHOLDS[4] as number) + 5, "test");
    runUntil(s.game, () => a.inbox.some((m) => m.t === "tick" && m.levelUp === 4), 30, "level-up notice");
    assert.equal(a.player?.level, 4);
    assert.equal(a.player?.talentPoints, 2);
    const first = a.request({ t: "talent_allocate", talentId: "lumberjack" }, 900);
    const again = a.request({ t: "talent_allocate", talentId: "lumberjack" }, 900);
    assert.equal(first[0]?.t, "ack");
    assert.deepEqual(again, first);
    assert.equal(p.talents.lumberjack, 1, "a repeated request does not allocate twice");
    const bogus = a.request({ t: "talent_allocate", talentId: "lumberjack", effects: [{ stat: "gather.wood", pct: 99 }] })[0];
    assert.equal(bogus?.t, "ack");
    assert.equal(s.world.mods(a.playerId).pct["gather.wood"], 0.1, "two ranks of 5%; client-supplied effects are ignored");
    const xp = p.xp;
    s.game.stop();
    s.store.close();
    s = makeServer(db);
    const p2 = s.world.players.get(a.playerId)!;
    assert.equal(p2.xp, xp);
    assert.deepEqual(p2.talents, { lumberjack: 2 });
    assert.equal(s.world.level(p2), 4);
    assert.equal(s.world.mods(a.playerId).pct.trainCost, -0.2, "race passives restored");
    s.game.stop();
    s.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
