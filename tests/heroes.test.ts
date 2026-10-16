import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { HERO_DEFS, HERO_TRAINING, heroDefForRace } from "../src/shared/defs/heroes.ts";
import { RACES } from "../src/shared/defs/races.ts";
import { UNIT_DEFS, unitDef } from "../src/shared/defs/units.ts";
import { compileSource } from "../src/script/compiler.ts";
import { NEUTRAL, type BuildingState, type UnitState } from "../src/sim/types.ts";
import { World, type SimConfig } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig, PARAMS } from "./helpers.ts";

type Spot = { x: number; y: number };

function tp(w: World, u: UnitState, x: number, y: number): void {
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, x, y);
}
function near(w: World, x: number, y: number, r = 6): Spot {
  const np = (w as unknown as { nearestPassable: (x: number, y: number, r: number) => Spot | null }).nearestPassable.bind(w);
  return np(x, y, r)!;
}
const steps = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) w.step();
};
const hallOf = (w: World, pid = 1): BuildingState => [...w.buildingsOf(pid)].map((id) => w.buildings.get(id)!).find((b) => b.type === "town_hall")!;

function world(race = "human", over: Partial<SimConfig> = {}, more: [number, string, string][] = []): World {
  const w = new World({ ...PARAMS }, over);
  assert.ok(w.createPlayer(1, "alice", race).ok);
  for (const [id, name, r] of more) assert.ok(w.createPlayer(id, name, r).ok);
  for (const u of w.units.values()) if (u.owner !== NEUTRAL) w.controlProgram(u.owner, u.id, "stop");
  return w;
}

/** Recruit player `pid`'s hero at their Town Hall (resources topped up) and wait for it. */
function recruit(w: World, pid = 1): UnitState {
  const p = w.players.get(pid)!;
  p.resources.food += 500;
  p.resources.gold += 500;
  const r = w.recruitHero(pid, hallOf(w, pid).id);
  assert.ok(r.ok, r.ok ? "" : r.message);
  for (let i = 0; i < 400 && !w.heroOf(pid); i++) w.step();
  const h = w.heroOf(pid);
  assert.ok(h, "hero arrived");
  w.controlProgram(pid, h.id, "stop");
  return h;
}

function runScript(w: World, u: UnitState, src: string, ticks: number): void {
  const r = w.setProgram(u.owner, u.id, src, 1);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.ok(w.controlProgram(u.owner, u.id, "run").ok);
  for (let i = 0; i < ticks && u.program.state === "running"; i++) w.step();
}

test("every race has a distinct hero with three abilities and a compiling default program", () => {
  const names = new Set<string>();
  for (const race of RACES) {
    const hd = heroDefForRace(race.id);
    assert.ok(hd, `${race.id} has a hero`);
    names.add(hd.name);
    assert.equal(hd.abilities.length, 3);
    assert.ok(hd.abilities.some((a) => !a.combat), `${hd.name} has abilities usable without combat`);
    const ud = UNIT_DEFS[hd.type];
    assert.ok(ud?.hero && ud.attack, `${hd.type} is a hero unit`);
    const c = compileSource(ud.defaultProgram, { unlocks: new Set() });
    assert.ok(c.ok, `${hd.name} default program compiles: ${c.ok ? "" : JSON.stringify(c.diagnostics[0])}`);
    // Every ability the default program uses exists.
    for (const m of ud.defaultProgram.matchAll(/"([a-z_]+)"/g)) {
      if (["construction", "unit"].includes(m[1]!)) continue;
      assert.ok(hd.abilities.some((a) => a.id === m[1]), `${hd.name} program uses unknown ability ${m[1]}`);
    }
  }
  assert.equal(names.size, Object.keys(HERO_DEFS).length);
  // Strengths differ: compare a few headline stats.
  assert.ok(unitDef("hero_dwarf").maxHp > unitDef("hero_high_elf").maxHp);
  assert.ok(unitDef("hero_dark_elf").speed > unitDef("hero_dwarf").speed);
  assert.ok(unitDef("hero_orc").attack!.damage > unitDef("hero_troll").attack!.damage);
  assert.ok(unitDef("hero_high_elf").attack!.range > 1);
  assert.ok(unitDef("hero_dark_elf").capabilities.includes("stealth"));
});

test("one hero per player: recruited at the Town Hall, outside the unit limit, grows with level", () => {
  // A server with no fighting at all (combat and PvE both off).
  const w = world("human", { pveEnabled: false });
  const p = w.players.get(1)!;
  const hall = hallOf(w);
  assert.equal(w.unitsOf(1).size, 3, "players still start with exactly three units");
  // A Barracks cannot recruit, only revive.
  const lodge = w.addBuilding(1, "lodge", hall.x + 6, hall.y, true);
  const barracks = w.addBuilding(1, "barracks", hall.x - 6, hall.y, true);
  void lodge;
  const nb = w.recruitHero(1, barracks.id);
  assert.ok(!nb.ok && /Town Hall first/.test(nb.message));
  const before = { ...p.resources };
  const r = w.recruitHero(1, hall.id);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.deepEqual(p.resources, before, "the first recruitment is free");
  const again = w.recruitHero(1, hall.id);
  assert.ok(!again.ok && again.code === "already_queued");
  steps(w, 30 * 10 + 5);
  const h = w.heroOf(1)!;
  assert.equal(h.type, "hero_human");
  assert.equal(w.unitsOf(1).size, 4);
  assert.equal(w.limitedUnits(1), 3, "the hero does not count toward the unit limit");
  assert.ok(p.hero.recruited);
  assert.equal(h.hp, 400);
  assert.equal(h.program.state, "running", "the hero runs its default program");
  const alive = w.recruitHero(1, hall.id);
  assert.ok(!alive.ok && alive.code === "hero_alive");
  // A player at the unit limit can still get (or revive) a hero.
  const full = world("orc", { unitLimitCeiling: 10 });
  const fp = full.players.get(1)!;
  fp.resources.food = 10_000;
  for (let i = 0; i < 7; i++) full.addUnit(1, "worker", fp.spawnX, fp.spawnY + 3, false);
  assert.equal(full.limitedUnits(1), 10);
  assert.ok(!full.trainUnit(1, hallOf(full).id, "worker").ok, "at the limit");
  assert.ok(full.recruitHero(1, hallOf(full).id).ok, "but the hero is still available");
  // Level scaling: +2% health and damage per level above 1.
  p.xp = 10_000_000;
  w.invalidateMods(1);
  const lvl = w.level(p);
  assert.ok(lvl > 10);
  assert.equal(w.unitMaxHp(h), Math.round(400 * (1 + 0.02 * (lvl - 1))));
  assert.equal(w.unitDamage(h), Math.round(14 * (1 + 0.02 * (lvl - 1))));
  steps(w, 10);
  assert.equal(h.hp, w.unitMaxHp(h), "without any fighting the hero simply stays at full health");
});

test("support abilities work without combat; combat abilities and cooldowns are enforced", () => {
  const w = world("human");
  const h = recruit(w);
  const wc = [...w.unitsOf(1)].map((id) => w.units.get(id)!).find((u) => u.type === "woodcutter")!;
  tp(w, wc, h.x + 1, h.y);
  const before = w.gatherRate(wc, "wood", wc.x, wc.y);
  const r = w.castAbility(h, "rally", null);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.ok(Math.abs(w.gatherRate(wc, "wood", wc.x, wc.y) / before - 1.25) < 1e-9, "Rally: +25% gathering");
  const again = w.castAbility(h, "rally", null);
  assert.ok(!again.ok && again.code === "cooldown" && /ready again in 90 s/.test(again.message), again.ok ? "" : again.message);
  // Nobody is hurt, so Holy Light does nothing and keeps its cooldown.
  const heal = w.castAbility(h, "holy_light", null);
  assert.ok(!heal.ok && heal.code === "no_effect");
  assert.equal(w.abilityReadyIn(h, "holy_light"), 0);
  // Not an ability of this hero; not a hero.
  assert.ok(!w.castAbility(h, "whirlwind", null).ok);
  assert.equal((w.castAbility(wc, "rally", null) as { code: string }).code, "not_hero");
  // Buffs run out.
  steps(w, 31 * 10);
  assert.ok(Math.abs(w.gatherRate(wc, "wood", wc.x, wc.y) - before) < 1e-9, "Rally ended");
  assert.equal(wc.buffs.length, 0);
  // Orc: combat-only ability refused without any fighting (combat and PvE off); Muster speeds training.
  const o = world("orc", { pveEnabled: false });
  const oh = recruit(o);
  const ww = o.castAbility(oh, "whirlwind", null);
  assert.ok(!ww.ok && ww.code === "combat_disabled");
  const ohall = hallOf(o);
  tp(o, oh, ohall.x - 1, ohall.y);
  o.players.get(1)!.resources.food += 100;
  assert.ok(o.trainUnit(1, ohall.id, "worker").ok);
  assert.ok(o.castAbility(oh, "muster", null).ok);
  const total = o.orderTime(1, ohall.queue[0]!);
  let t = 0;
  while (ohall.queue.length && t < 1000) {
    o.step();
    t++;
  }
  assert.ok(t <= Math.ceil((total * 10) / 2) + 3, `trained in ${t} ticks, about half of ${total * 10}`);
});

test("each race's support abilities do what they say", () => {
  // Dwarf: Master Mason advances construction; aura speeds building.
  const d = world("dwarf");
  const dh = recruit(d);
  const dhall = hallOf(d);
  const site = d.addBuilding(1, "stockpile", dhall.x + 5, dhall.y + 5, false);
  tp(d, dh, site.x - 1, site.y);
  const mm = d.castAbility(dh, "master_mason", null);
  assert.ok(mm.ok, mm.ok ? "" : mm.message);
  assert.ok(Math.abs(site.progress - 0.25 * 12) < 1e-9);
  const builder = [...d.unitsOf(1)].map((id) => d.units.get(id)!).find((u) => u.type === "builder")!;
  tp(d, builder, dh.x + 1, dh.y);
  assert.ok(Math.abs(d.unitPct(builder, "buildRate") - 0.2) < 1e-9, "Stonework aura");
  tp(d, builder, dh.x + 20, dh.y);
  assert.equal(d.unitPct(builder, "buildRate"), 0);
  // Undead: Dark Ritual turns food into gold (and refuses without food).
  const u = world("undead");
  const uh = recruit(u);
  const up = u.players.get(1)!;
  up.resources.food = 150;
  up.resources.gold = 0;
  assert.ok(u.castAbility(uh, "dark_ritual", null).ok);
  assert.equal(up.resources.food, 50);
  assert.equal(up.resources.gold, 50);
  const broke = (() => {
    uh.cooldowns = {};
    return u.castAbility(uh, "dark_ritual", null);
  })();
  assert.ok(!broke.ok && /Insufficient/.test(broke.message), "not enough food");
  assert.equal(up.resources.food, 50, "a failed ritual takes nothing");
  // Troll: Wild Call tames the nearest boar at once.
  const t = world("troll");
  const th = recruit(t);
  const spot = near(t, th.x + 3, th.y, 3);
  const boar = t.spawnCreature("boar", spot.x, spot.y);
  const wc = t.castAbility(th, "wild_call", null);
  assert.ok(wc.ok, wc.ok ? "" : wc.message);
  assert.equal(boar.owner, 1);
  // High Elf: Farsight lets the player detect a hidden scout far away; Inspiration speeds research.
  const e = world("high_elf", {}, [[2, "bob", "orc"]]);
  const eh = recruit(e);
  const bobScout = [...e.unitsOf(2)].map((id) => e.units.get(id)!).find((x) => x.type === "scout")!;
  const far = near(e, eh.x + 30, eh.y, 4);
  tp(e, bobScout, far.x, far.y);
  assert.ok(e.isHiddenFrom(bobScout, 1));
  const fs = e.castAbility(eh, "farsight", { x: far.x, y: far.y });
  assert.ok(fs.ok, fs.ok ? "" : fs.message);
  assert.ok(!e.isHiddenFrom(bobScout, 1), "revealed by Farsight");
  assert.ok(e.presenceChunks(1).has(`${Math.floor(far.x / 64)},${Math.floor(far.y / 64)}`));
  steps(e, 21 * 10);
  assert.ok(e.isHiddenFrom(bobScout, 1), "the reveal ends");
  eh.cooldowns = {};
  const tooFar = e.castAbility(eh, "farsight", { x: eh.x + 200, y: eh.y });
  assert.ok(!tooFar.ok && tooFar.code === "out_of_range");
  // Dark Elf: Shadowstep moves the hero; Veil of Night hides nearby workers.
  const k = world("dark_elf", {}, [[2, "bob", "orc"]]);
  const kh = recruit(k);
  const dest = near(k, kh.x + 6, kh.y + 2, 2);
  assert.ok(k.castAbility(kh, "shadowstep", { x: dest.x, y: dest.y }).ok);
  assert.ok(Math.abs(kh.x - dest.x) <= 2 && Math.abs(kh.y - dest.y) <= 2);
  const worker = [...k.unitsOf(1)].map((id) => k.units.get(id)!).find((x) => x.type === "woodcutter")!;
  tp(k, worker, kh.x + 1, kh.y);
  assert.ok(!k.isStealthy(worker));
  assert.ok(k.castAbility(kh, "veil_of_night", null).ok);
  assert.ok(k.isStealthy(worker), "veiled");
  assert.ok(k.isStealthy(kh), "the Shadowblade is always stealthy");
});

test("combat abilities respect PvP rules, armor, shields and curses", () => {
  const w = world("high_elf", { combatEnabled: true }, [[2, "bob", "human"]]);
  const eh = recruit(w, 1);
  const ph = recruit(w, 2);
  const spot = near(w, eh.x + 4, eh.y, 3);
  tp(w, ph, spot.x, spot.y);
  // Neither has opted in: refused, nothing happens.
  const no = w.castAbility(eh, "arcane_bolt", { unitId: ph.id });
  assert.ok(!no.ok && /opted in/.test(no.message));
  assert.equal(w.abilityReadyIn(eh, "arcane_bolt"), 0, "no cooldown for a refused ability");
  assert.ok(w.setPvp(1, true).ok && w.setPvp(2, true).ok);
  const hp0 = ph.hp;
  const bolt = w.castAbility(eh, "arcane_bolt", { unitId: ph.id });
  assert.ok(bolt.ok, bolt.ok ? "" : bolt.message);
  // Paladin armor 30% plus his own Devotion aura 15%: 45 * 0.55 = 24.75 -> 25.
  assert.equal(hp0 - ph.hp, Math.round(45 * 0.55));
  // Divine Shield: no damage at all.
  assert.ok(w.castAbility(ph, "divine_shield", null).ok);
  const hp1 = ph.hp;
  eh.cooldowns = {};
  assert.ok(w.castAbility(eh, "arcane_bolt", { unitId: ph.id }).ok);
  assert.equal(ph.hp, hp1, "shielded");
  // Range is enforced.
  const farSpot = near(w, eh.x + 15, eh.y, 3);
  tp(w, ph, farSpot.x, farSpot.y);
  eh.cooldowns = {};
  const oor = w.castAbility(eh, "arcane_bolt", { unitId: ph.id });
  assert.ok(!oor.ok && oor.code === "out_of_range");
  // Troll Hex makes the target take 50% more damage.
  const t = world("troll", { combatEnabled: true }, [[2, "bob", "orc"]]);
  const th = recruit(t, 1);
  const bw = [...t.unitsOf(2)].map((id) => t.units.get(id)!).find((x) => x.type === "woodcutter")!;
  const s2 = near(t, th.x + 2, th.y, 2);
  tp(t, bw, s2.x, s2.y);
  assert.ok(t.setPvp(1, true).ok && t.setPvp(2, true).ok);
  assert.ok(t.castAbility(th, "hex", { unitId: bw.id }).ok);
  assert.ok(t.unitPct(bw, "moveSpeed") < 0, "slowed");
  const raw = 20;
  const dealt = (t as unknown as { damageUnit: (x: UnitState, d: number, a: UnitState) => number }).damageUnit(bw, raw, th);
  assert.equal(dealt, 30);
  // Undead Drain Life heals the Necromancer.
  const n = world("undead", { combatEnabled: true });
  const nh = recruit(n, 1);
  nh.hp = 100;
  const sp = near(n, nh.x + 2, nh.y, 2);
  const deer = n.spawnCreature("deer", sp.x, sp.y);
  const dl = n.castAbility(nh, "drain_life", { unitId: deer.id });
  assert.ok(dl.ok, dl.ok ? "" : dl.message);
  assert.ok(nh.hp > 100, "drained");
});

test("a fallen hero is revived at a Town Hall or Barracks and keeps its battle training", () => {
  const w = world("orc", { combatEnabled: true }, [[2, "bob", "undead"]]);
  const p = w.players.get(1)!;
  const hall = hallOf(w);
  // Battle training needs a recruited hero and a Barracks.
  const barracks = w.addBuilding(1, "barracks", hall.x - 6, hall.y, true);
  const early = w.trainHero(1, barracks.id, "vitality");
  assert.ok(!early.ok && early.code === "no_hero");
  const h = recruit(w, 1);
  p.resources = { wood: 5000, stone: 5000, gold: 5000, food: 5000 };
  assert.ok(!w.trainHero(1, hall.id, "vitality").ok, "Town Halls do not train heroes");
  assert.ok(!w.trainHero(1, barracks.id, "speed").ok, "unknown track");
  for (let i = 0; i < 5; i++) {
    const r = w.trainHero(1, barracks.id, "vitality");
    assert.ok(r.ok, r.ok ? "" : r.message);
    if (barracks.queue.length >= 5) break;
  }
  const max = w.trainHero(1, barracks.id, "vitality");
  assert.ok(!max.ok, "rank 6 does not exist");
  for (let i = 0; i < 3000 && barracks.queue.length; i++) w.step();
  assert.equal(p.hero.ranks.vitality, HERO_TRAINING.vitality!.maxRank);
  const max1 = w.unitMaxHp(h);
  assert.equal(max1, Math.round(340 * (1 + 0.02 * (w.level(p) - 1)) * 1.75));
  assert.equal(h.hp, max1, "training raised current health too");
  // The hero falls.
  const killer = w.addUnit(2, "soldier", h.x + 1, h.y, false);
  (w as unknown as { killUnit: (t: UnitState, k: UnitState) => void }).killUnit(h, killer);
  assert.equal(p.hero.unitId, null);
  assert.equal(p.hero.deaths, 1);
  assert.ok(w.notices.some((n) => n.playerId === 1 && /has fallen/.test(n.text)));
  // Revived at the Barracks for gold; training kept.
  const cost = w.heroOrderCost(1);
  assert.ok(cost.revive && cost.cost.gold > 0);
  const goldBefore = p.resources.gold;
  assert.ok(w.recruitHero(1, barracks.id).ok);
  assert.equal(p.resources.gold, goldBefore - cost.cost.gold);
  for (let i = 0; i < 2000 && !w.heroOf(1); i++) w.step();
  const h2 = w.heroOf(1)!;
  assert.ok(h2 && h2.id !== h.id);
  assert.equal(w.unitMaxHp(h2), max1, "training survived death");
  // Undead revive for half; Rites of Return cheapens it further.
  const bob = w.players.get(2)!;
  bob.hero.recruited = true;
  const undead = w.heroOrderCost(2);
  const orcBase = (() => {
    const save = bob.race;
    bob.race = "orc";
    const c = w.heroOrderCost(2);
    bob.race = save;
    return c;
  })();
  assert.ok(undead.cost.gold < orcBase.cost.gold && undead.time < orcBase.time);
  bob.techs.push("rites_of_return");
  w.invalidateMods(2);
  assert.ok(w.heroOrderCost(2).cost.gold < undead.cost.gold);
});

test("scripts: use_ability, ability_ready and hero()", () => {
  const w = world("human");
  const h = recruit(w);
  runScript(w, h, `print("ready", ability_ready("rally"), ability_ready("nope"))\nprint("used", use_ability("rally"))\nprint("again", ability_ready("rally"), use_ability("rally"))\nprint("bolt", use_ability("divine_shield"))\n`, 50);
  assert.ok(h.log.some((l) => l.includes("ready True False")), h.log.join("\n"));
  assert.ok(h.log.some((l) => l.includes("used True")), h.log.join("\n"));
  assert.ok(h.log.some((l) => l.includes("again False False")), h.log.join("\n"));
  assert.ok(h.log.some((l) => /use_ability failed: Rally is ready again/.test(l)), h.log.join("\n"));
  const wc = [...w.unitsOf(1)].map((id) => w.units.get(id)!).find((u) => u.type === "woodcutter")!;
  runScript(w, wc, `x = hero()\nprint("hero", x.kind, x.id)\nprint("use", use_ability("rally"))\n`, 30);
  assert.ok(wc.log.some((l) => l.includes(`hero hero_human u:${h.id}`)), wc.log.join("\n"));
  assert.ok(wc.log.some((l) => /Only your hero has abilities/.test(l)), wc.log.join("\n"));
  // The default hero program uses its abilities on its own.
  const d = world("dwarf");
  const dh = recruit(d);
  d.controlProgram(1, dh.id, "run");
  const hall = hallOf(d);
  const site = d.addBuilding(1, "stockpile", hall.x + 4, hall.y + 4, false);
  void site;
  steps(d, 200);
  assert.ok(dh.log.some((l) => /Master Mason|Rich Seam/.test(l)), dh.log.join("\n"));
});

test("heroes over the network and across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-hero-"));
  const db = join(dir, "h.db");
  try {
    const cfg = testConfig(db);
    cfg.combat.enabled = true;
    const s1 = makeServer(db, cfg);
    const a = new TestClient(s1.game);
    a.hello("alice", { race: "troll" });
    const b = new TestClient(s1.game);
    b.hello("bob", { race: "human" });
    s1.game.tickOnce();
    assert.equal(a.player?.hero?.type, "hero_troll");
    assert.equal(a.player?.hero?.unitId, null);
    assert.equal(a.player?.hero?.cost.food, 0, "first recruitment is free");
    const hall = [...s1.world.buildingsOf(a.playerId)].map((id) => s1.world.buildings.get(id)!).find((x) => x.type === "town_hall")!;
    const res = a.request({ t: "hero_recruit", buildingId: hall.id });
    assert.equal(res[0]?.t, "ack", JSON.stringify(res));
    const bad = b.request({ t: "hero_recruit", buildingId: hall.id });
    assert.equal(bad[0]?.t, "error", "cannot recruit at someone else's hall");
    for (let i = 0; i < 400 && !s1.world.heroOf(a.playerId); i++) s1.game.tickOnce();
    const h = s1.world.heroOf(a.playerId)!;
    s1.game.tickOnce();
    const hv = a.units.get(h.id);
    assert.ok(hv?.own?.abilities?.length === 3, JSON.stringify(hv?.own));
    assert.equal(hv.own.maxHp, s1.world.unitMaxHp(h));
    assert.ok(typeof hv.own.damage === "number" && typeof hv.own.armor === "number");
    // Bob sees the hero's public view only.
    const bv = b.units.get(h.id);
    if (bv) assert.equal(bv.own, undefined);
    // Malformed and foreign ability requests.
    assert.equal(a.request({ t: "ability", unitId: h.id, ability: 5 })[0]?.t, "error");
    assert.equal(a.request({ t: "ability", unitId: h.id, ability: "hex", target: { x: "a" } })[0]?.t, "error");
    const bobUnit = [...s1.world.unitsOf(b.playerId)][0]!;
    const hidden = a.request({ t: "ability", unitId: h.id, ability: "hex", target: { unitId: bobUnit } });
    assert.equal(hidden[0]?.t, "error");
    assert.match((hidden[0] as { message: string }).message, /No such target nearby|opted in|reaches/);
    assert.equal(b.request({ t: "ability", unitId: h.id, ability: "spirit_totem" })[0]?.t, "error", "not your hero");
    // Training ranks persist; the hero survives a restart as the same unit.
    s1.world.players.get(a.playerId)!.hero.ranks = { strength: 2 };
    s1.world.invalidateMods(a.playerId);
    s1.world.markPlayer(s1.world.players.get(a.playerId)!);
    const dmg = s1.world.unitDamage(h);
    assert.ok(s1.game.flush());
    s1.game.stop();
    s1.store.close();
    const s2 = makeServer(db, cfg);
    const p2 = s2.world.players.get(a.playerId)!;
    assert.equal(p2.hero.unitId, h.id);
    assert.deepEqual(p2.hero.ranks, { strength: 2 });
    assert.equal(s2.world.unitDamage(s2.world.heroOf(a.playerId)!), dmg);
    // A hero record pointing at a missing unit is cleared on load (revivable).
    s2.world.players.get(a.playerId)!.hero.unitId = 999999;
    s2.world.markPlayer(p2);
    assert.ok(s2.game.flush());
    s2.game.stop();
    s2.store.close();
    const s3 = makeServer(db, cfg);
    assert.equal(s3.world.players.get(a.playerId)!.hero.unitId, null);
    assert.ok(s3.world.players.get(a.playerId)!.hero.recruited);
    s3.game.stop();
    s3.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the SCRIPTING.md hero program runs as documented", () => {
  const doc = readFileSync(join(import.meta.dirname, "..", "docs", "SCRIPTING.md"), "utf8");
  const m = doc.match(/### A hero program\n\n```python\n([\s\S]*?)```/);
  assert.ok(m, "example found");
  const w = world("human");
  const h = recruit(w);
  const wc = [...w.unitsOf(1)].map((id) => w.units.get(id)!).find((u) => u.type === "woodcutter")!;
  tp(w, wc, h.x + 1, h.y);
  wc.hp = 20;
  runScript(w, h, m[1]!, 100);
  assert.equal(h.program.state, "running", h.log.join("\n"));
  assert.ok(h.log.some((l) => l.startsWith("[") && l.includes("Rally:")), h.log.join("\n"));
  void wc;
});
