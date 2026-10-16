import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LESSONS, lessonExample } from "../src/shared/defs/lessons.ts";
import { HERO_DEFS } from "../src/shared/defs/heroes.ts";
import { diagnose, defaultContext } from "../src/script/assist.ts";
import type { BuildingState, UnitState } from "../src/sim/types.ts";
import { World } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig, PARAMS } from "./helpers.ts";

const hallOf = (w: World): BuildingState => [...w.buildingsOf(1)].map((id) => w.buildings.get(id)!).find((b) => b.type === "town_hall")!;

function run(w: World, u: UnitState, src: string, ticks: number): void {
  const r = w.setProgram(1, u.id, src, 1);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.ok(w.controlProgram(1, u.id, "run").ok);
  for (let i = 0; i < ticks && u.program.state === "running"; i++) w.step();
}

test("each lesson's own example completes it when run, awarding experience once", () => {
  const w = new World({ ...PARAMS });
  assert.ok(w.createPlayer(1, "alice", "human").ok);
  for (const u of w.units.values()) w.controlProgram(1, u.id, "stop");
  const p = w.players.get(1)!;
  p.resources = { wood: 500, stone: 200, gold: 100, food: 300 };
  const units = [...w.unitsOf(1)].map((id) => w.units.get(id)!);
  const builder = units.find((u) => u.type === "builder")!;
  const wc = units.find((u) => u.type === "woodcutter")!;
  // The hero lesson needs a hero.
  assert.ok(w.recruitHero(1, hallOf(w).id).ok);
  for (let i = 0; i < 400 && !w.heroOf(1); i++) w.step();
  const hero = w.heroOf(1)!;
  w.controlProgram(1, hero.id, "stop");
  hero.cooldowns = {};
  for (const l of LESSONS) {
    // Every example is valid; only "find" shows a warning (on purpose: the next lesson is about it).
    const example = lessonExample(l, HERO_DEFS.human!.abilities);
    const problems = diagnose(example, defaultContext({ combatEnabled: false, heroAbilities: HERO_DEFS.human!.abilities }));
    assert.deepEqual(problems.filter((d) => d.severity === "error").map((d) => d.message), [], `${l.id} example`);
    assert.equal(problems.length, l.id === "find" ? 1 : 0, `${l.id} warnings: ${problems.map((d) => d.message).join("; ")}`);
    const unit = l.id === "hero" ? hero : l.id === "build" ? builder : wc;
    const xp = p.xp;
    run(w, unit, example, 1500);
    assert.ok(p.lessons.includes(l.id), `${l.id} completed (log: ${unit.log.slice(-4).join(" | ")})`);
    assert.ok(p.xp > xp || p.xp >= 1e12, `${l.id} awarded experience`);
    w.controlProgram(1, unit.id, "stop");
  }
  assert.equal(p.lessons.length, LESSONS.length);
  // The hero example suits every race.
  for (const hd of Object.values(HERO_DEFS)) {
    const ex = lessonExample(LESSONS.find((l) => l.id === "hero")!, hd.abilities);
    assert.equal(diagnose(ex, defaultContext({ unitType: hd.type, heroAbilities: hd.abilities })).length, 0, hd.race);
  }
  // Doing it again awards nothing more.
  const xp = p.xp;
  run(w, wc, 'print("again")\n', 5);
  assert.equal(p.xp, xp);
  assert.ok(w.notices.some((n) => n.playerId === 1 && /Lesson complete: Say hello/.test(n.text)));
});

test("lessons are not completed by programs that miss the point", () => {
  const w = new World({ ...PARAMS });
  assert.ok(w.createPlayer(1, "alice", "human").ok);
  for (const u of w.units.values()) w.controlProgram(1, u.id, "stop");
  const p = w.players.get(1)!;
  const wc = [...w.unitsOf(1)].map((id) => w.units.get(id)!).find((u) => u.type === "woodcutter")!;
  // The built-in default programs (which use loops, checks and if/else) complete nothing.
  for (const u of w.units.values()) if (u.owner === 1) w.controlProgram(1, u.id, "run");
  for (let i = 0; i < 1500; i++) w.step();
  assert.equal(p.lessons.length, 0, "default programs do not count");
  for (const u of w.units.values()) if (u.owner === 1) w.controlProgram(1, u.id, "stop");
  // Harvesting without a None check does not complete "Check before you use it"; deposit without a loop does not complete "Repeat forever".
  run(w, wc, 't = find_nearest("tree")\nharvest(t)\ndeposit()\n', 1500);
  assert.ok(p.lessons.includes("find"));
  assert.ok(!p.lessons.includes("none"));
  assert.ok(!p.lessons.includes("loop"));
  assert.ok(!p.lessons.includes("variables"), "no print");
});

test("lesson progress is sent to the player and survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-lesson-"));
  const db = join(dir, "l.db");
  try {
    const cfg = testConfig(db);
    const s1 = makeServer(db, cfg);
    const c = new TestClient(s1.game);
    c.hello("alice");
    const wc = [...s1.world.unitsOf(c.playerId)].map((id) => s1.world.units.get(id)!).find((u) => u.type === "woodcutter")!;
    const r = c.request({ t: "program_save", unitId: wc.id, source: 'print("hi")\n', run: true });
    assert.equal(r[0]?.t, "ack", JSON.stringify(r));
    for (let i = 0; i < 20; i++) s1.game.tickOnce();
    assert.deepEqual(c.player?.lessons, ["hello"]);
    assert.ok(s1.game.flush());
    s1.game.stop();
    s1.store.close();
    const s2 = makeServer(db, cfg);
    assert.deepEqual(s2.world.players.get(c.playerId)!.lessons, ["hello"]);
    s2.game.stop();
    s2.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
