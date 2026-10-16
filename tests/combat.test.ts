import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSource } from "../src/script/compiler.ts";
import { NEUTRAL, type UnitState } from "../src/sim/types.ts";
import { World, type SimConfig } from "../src/sim/world.ts";
import { TestClient, makeServer, testConfig, PARAMS } from "./helpers.ts";

function world(over: Partial<SimConfig> = { combatEnabled: true }): World {
  return new World({ ...PARAMS }, over);
}

function tp(w: World, u: UnitState, x: number, y: number): void {
  (w as unknown as { moveUnitTo: (u: UnitState, x: number, y: number) => void }).moveUnitTo(u, x, y);
}

function stopAll(w: World): void {
  for (const u of w.units.values()) if (u.owner !== NEUTRAL) w.controlProgram(u.owner, u.id, "stop");
}

/** Two players whose bases are set up; returns a free tile pair near player 1's hall. */
function twoPlayers(w: World): { a: number; b: number; spot: { x: number; y: number } } {
  assert.ok(w.createPlayer(1, "alice", "high_elf").ok);
  assert.ok(w.createPlayer(2, "bob", "high_elf").ok);
  stopAll(w);
  const p = w.players.get(1)!;
  const np = (w as unknown as { nearestPassable: (x: number, y: number, r: number) => { x: number; y: number } | null }).nearestPassable.bind(w);
  const spot = np(p.spawnX + 6, p.spawnY + 6, 6)!;
  return { a: 1, b: 2, spot };
}

function runScript(w: World, u: UnitState, src: string, ticks: number): void {
  const r = w.setProgram(u.owner, u.id, src, 1);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.ok(w.controlProgram(u.owner, u.id, "run").ok);
  for (let i = 0; i < ticks && u.program.state === "running"; i++) w.step();
}

const steps = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) w.step();
};

test("combat is off unless the server enables it", () => {
  const w = world({ pveEnabled: false });
  const { spot } = twoPlayers(w);
  const a = w.addUnit(1, "soldier", spot.x, spot.y, false);
  const v = w.addUnit(2, "worker", spot.x + 1, spot.y, false);
  assert.equal(w.cfg.combatEnabled, false);
  const r = w.commandUnit(1, a.id, { kind: "attack", targetId: v.id });
  assert.ok(!r.ok && /Combat is disabled/.test(r.message));
  const pvp = w.setPvp(1, true);
  assert.ok(!pvp.ok && pvp.code === "combat_disabled");
  runScript(w, a, 'print("enemy", find_nearest("enemy"))\nprint("ok", attack(find_nearest("unit")))\n', 30);
  assert.ok(a.log.some((l) => l.includes("enemy None")), a.log.join("\n"));
  assert.equal(v.hp, 50, "nobody gets hurt");
  // Military units are unavailable. (The Barracks itself can be built: it also trains and revives heroes.)
  const lodge = w.addBuilding(1, "lodge", spot.x + 5, spot.y + 5, true);
  void lodge;
  const barracks = w.addBuilding(1, "barracks", spot.x - 6, spot.y - 6, true);
  w.players.get(1)!.resources.food = 500;
  w.players.get(1)!.resources.wood = 500;
  const t = w.trainUnit(1, barracks.id, "soldier");
  assert.ok(!t.ok && t.code === "combat_disabled");
  // Hunting is combat too.
  const deer = w.spawnCreature("deer", spot.x, spot.y + 1);
  assert.ok(!w.commandUnit(1, a.id, { kind: "attack", targetId: deer.id }).ok);
});

test("PvP needs both players to opt in; hunting wild animals does not", () => {
  const w = world();
  const { spot } = twoPlayers(w);
  const s = w.addUnit(1, "soldier", spot.x, spot.y, false);
  const v = w.addUnit(2, "worker", spot.x + 1, spot.y, false);
  let r = w.commandUnit(1, s.id, { kind: "attack", targetId: v.id });
  assert.ok(!r.ok && /You have not opted in/.test(r.message));
  assert.ok(w.setPvp(1, true).ok);
  r = w.commandUnit(1, s.id, { kind: "attack", targetId: v.id });
  assert.ok(!r.ok && /bob has not opted in/.test(r.message), r.ok ? "" : r.message);
  assert.ok(w.setPvp(2, true).ok);
  assert.ok(w.commandUnit(1, s.id, { kind: "attack", targetId: v.id }).ok);
  steps(w, 15);
  assert.ok(v.hp < 50, "damage was dealt");
  // Player 3 never opts in, yet may hunt; the deer cannot fight back.
  assert.ok(w.createPlayer(3, "carol", "troll").ok);
  const hunter = [...w.unitsOf(3)].map((id) => w.units.get(id)!).find((u) => u.type === "woodcutter")!;
  w.controlProgram(3, hunter.id, "stop");
  hunter.inventory = { wood: 0, stone: 0, gold: 0, food: 0 };
  const deer = w.spawnCreature("deer", hunter.x + 1, hunter.y);
  w.controlProgram(NEUTRAL, deer.id, "stop");
  const xp0 = w.players.get(3)!.xp;
  assert.ok(w.commandUnit(3, hunter.id, { kind: "attack", targetId: deer.id }).ok);
  for (let i = 0; i < 300 && w.units.has(deer.id); i++) w.step();
  assert.ok(!w.units.has(deer.id), "the deer was hunted");
  assert.equal(hunter.inventory.food, 15, "the hunter carries what meat fits (capacity 15)");
  assert.ok(hunter.log.some((l) => /Hunted a deer: 15 food \(25 left behind/.test(l)), hunter.log.join("\n"));
  assert.ok(w.players.get(3)!.xp > xp0);
  assert.equal(w.pvpActive(3), false, "hunting does not opt you in");
});

test("a fight ends when the target falls; the dead unit is gone and both owners are told", () => {
  const w = world();
  const { spot } = twoPlayers(w);
  w.setPvp(1, true);
  w.setPvp(2, true);
  const s = w.addUnit(1, "soldier", spot.x, spot.y, false);
  const v = w.addUnit(2, "worker", spot.x + 3, spot.y, false);
  w.notices = [];
  runScript(w, s, `t = find_nearest("enemy")\nprint("target", t.kind, can_attack(t))\nprint("won", attack(t))\n`, 400);
  assert.ok(s.log.some((l) => l.includes("target worker True")), s.log.join("\n"));
  assert.ok(s.log.some((l) => l.includes("won True")), s.log.join("\n"));
  assert.ok(!w.units.has(v.id) && !w.unitsOf(2).has(v.id));
  assert.ok(w.net.removedUnits.has(v.id) || w.persist.removedUnits.has(v.id));
  assert.ok(w.notices.some((n) => n.playerId === 2 && /Your worker #\d+ was killed by alice's soldier/.test(n.text)));
  assert.ok(w.notices.some((n) => n.playerId === 1 && /defeated bob's worker/.test(n.text)));
  assert.ok(w.audit.some((e) => e.action === "unit_killed"));
  // Referring to the dead unit later fails cleanly.
  runScript(w, s, `print("again", attack(find_nearest("enemy")))\n`, 20);
  assert.equal(s.program.state, "error", "find_nearest returns None, and attack(None) is a script error");
});

test("wild animals fight back only against whoever attacked them", () => {
  const w = world();
  const { spot } = twoPlayers(w);
  const bystander = w.addUnit(2, "worker", spot.x, spot.y + 1, false);
  const wolf = w.spawnCreature("wolf", spot.x + 1, spot.y + 1);
  steps(w, 100);
  assert.equal(bystander.hp, 50, "wolves never attack unprovoked");
  const hunter = w.addUnit(1, "worker", wolf.x + 1, wolf.y, false);
  assert.ok(w.commandUnit(1, hunter.id, { kind: "attack", targetId: wolf.id }).ok);
  steps(w, 60);
  assert.ok(hunter.hp < 50 || !w.units.has(hunter.id), "the wolf fought back");
  assert.equal(bystander.hp, 50, "only the attacker's units are fought");
  const why = w.attackBlocker(wolf, bystander);
  assert.ok(why && /only fight back/.test(why));
});

test("opting out takes effect after a delay, which fighting extends", () => {
  const w = world({ combatEnabled: true, pvpOptOutSeconds: 10 });
  const { spot } = twoPlayers(w);
  w.setPvp(1, true);
  w.setPvp(2, true);
  const s = w.addUnit(1, "soldier", spot.x, spot.y, false);
  const v = w.addUnit(2, "builder", spot.x + 1, spot.y, false);
  assert.ok(w.setPvp(2, false).ok);
  assert.equal(w.pvpActive(2), true, "still attackable right after opting out");
  assert.ok(w.commandUnit(1, s.id, { kind: "attack", targetId: v.id }).ok);
  steps(w, 30);
  w.commandUnit(1, s.id, { kind: "stop" });
  const until = w.players.get(2)!.pvpUntil!;
  assert.ok(until >= w.tick + 70, "the fight pushed the opt-out back");
  steps(w, 80);
  assert.equal(w.pvpActive(2), true);
  steps(w, 40);
  assert.equal(w.pvpActive(2), false, "out of PvP once the delay passed without fighting");
  assert.ok(w.notices.some((n) => n.playerId === 2 && /left PvP/.test(n.text)));
  const r = w.commandUnit(1, s.id, { kind: "attack", targetId: v.id });
  assert.ok(!r.ok && /bob has not opted in/.test(r.message));
  // Opting back in is immediate.
  w.setPvp(2, true);
  assert.equal(w.pvpActive(2), true);
});

test("buildings can be destroyed (territory is released) and repaired for resources", () => {
  const w = world();
  twoPlayers(w);
  w.setPvp(1, true);
  w.setPvp(2, true);
  // Bob's outpost far from both halls claims its own territory.
  const p2 = w.players.get(2)!;
  const out = w.addBuilding(2, "outpost", p2.spawnX + 20, p2.spawnY, true);
  (w as unknown as { claimTerritory: (b: unknown) => void }).claimTerritory(out);
  const tile = { x: out.x + 6, y: out.y };
  assert.equal(w.territory.ownerAt(tile.x, tile.y), 2);
  const s = w.addUnit(1, "soldier", out.x - 1, out.y, false);
  w.notices = [];
  assert.ok(w.commandUnit(1, s.id, { kind: "attack_building", buildingId: out.id }).ok);
  for (let i = 0; i < 800 && w.buildings.has(out.id); i++) w.step();
  assert.ok(!w.buildings.has(out.id), "destroyed");
  assert.equal(w.territory.ownerAt(tile.x, tile.y), 0, "its territory is released");
  assert.equal(w.territory.ownerAt(p2.spawnX, p2.spawnY), 2, "territory of other buildings stays");
  assert.ok(w.notices.some((n) => n.playerId === 2 && /Outpost #\d+ was destroyed by alice/.test(n.text)));
  assert.equal(w.buildingAt(out.x, out.y), undefined, "the footprint is free again");
  // Repair: damage Bob's town hall, then his builder repairs it, paying as it goes.
  const hall = [...w.buildingsOf(2)].map((id) => w.buildings.get(id)!).find((b) => b.type === "town_hall")!;
  hall.hp = 500;
  const builder = [...w.unitsOf(2)].map((id) => w.units.get(id)!).find((u) => u.type === "builder")!;
  tp(w, builder, hall.x - 1, hall.y);
  p2.resources = { wood: 0, stone: 0, gold: 0, food: 0 };
  assert.ok(w.commandUnit(2, builder.id, { kind: "repair", buildingId: hall.id }).ok);
  steps(w, 60);
  assert.ok(builder.log.some((l) => /Not enough (wood|stone) to continue repairs/.test(l)), builder.log.join("\n"));
  const hp0 = hall.hp;
  p2.resources = { wood: 500, stone: 500, gold: 0, food: 0 };
  runScript(w, builder, `print("repaired", repair(find_nearest("storage")))\n`, 3000);
  assert.ok(builder.log.some((l) => l.includes("repaired True")), builder.log.join("\n"));
  assert.equal(hall.hp, w.buildingMaxHp(hall));
  const spentWood = 500 - p2.resources.wood;
  const expected = Math.round((200 * 0.5 * (hall.hp - hp0)) / w.buildingMaxHp(hall));
  assert.ok(Math.abs(spentWood - expected) <= 1, `paid ${spentWood} wood, expected about ${expected}`);
});

test("a player who loses everything is re-founded and keeps their progress", () => {
  const w = world();
  twoPlayers(w);
  const p = w.players.get(2)!;
  p.xp = 500;
  p.techs.push("masonry");
  const killer = w.addUnit(1, "soldier", p.spawnX + 30, p.spawnY, false);
  // Remove everything via the combat paths.
  const internal = w as unknown as { killUnit: (t: UnitState, k: UnitState) => void; destroyBuilding: (b: unknown, by: UnitState) => void };
  for (const id of [...w.unitsOf(2)]) internal.killUnit(w.units.get(id)!, killer);
  for (const id of [...w.buildingsOf(2)]) internal.destroyBuilding(w.buildings.get(id)!, killer);
  w.step();
  assert.equal(w.unitsOf(2).size, 3, "three new starting units");
  const halls = [...w.buildingsOf(2)].map((id) => w.buildings.get(id)!);
  assert.ok(halls.length === 1 && halls[0]!.type === "town_hall" && halls[0]!.complete);
  assert.equal(p.xp >= 500, true);
  assert.ok(p.techs.includes("masonry"));
  assert.ok(w.notices.some((n) => n.playerId === 2 && /new one has been founded/.test(n.text)));
  assert.ok(w.territory.countOf(2) > 0);
});

test("scripts: last_attacker(), me.hp, flee(); the default soldier program defends itself", () => {
  const w = world();
  const { spot } = twoPlayers(w);
  w.setPvp(1, true);
  w.setPvp(2, true);
  const guard = w.addUnit(2, "soldier", spot.x, spot.y, true); // runs its default program
  const raider = w.addUnit(1, "worker", spot.x + 1, spot.y, false);
  assert.ok(w.commandUnit(1, raider.id, { kind: "attack", targetId: guard.id }).ok);
  for (let i = 0; i < 400 && w.units.has(raider.id); i++) w.step();
  assert.ok(!w.units.has(raider.id), "the soldier's default program fought back and won");
  assert.ok(guard.hp < 140);
  // A worker that is hit reads its attacker and runs away.
  const runner = w.addUnit(2, "worker", spot.x + 3, spot.y + 3, false);
  const s = w.addUnit(1, "soldier", spot.x + 4, spot.y + 3, false);
  w.commandUnit(1, s.id, { kind: "attack", targetId: runner.id });
  steps(w, 12);
  runScript(w, runner, `a = last_attacker()\nprint("hit by", a.kind, me.hp < me.max_hp)\nprint("fled", flee(a))\n`, 200);
  assert.ok(runner.log.some((l) => l.includes("hit by soldier True")), runner.log.join("\n"));
  assert.ok(compileSource("print(me.hp, me.max_hp, last_attacker(), can_attack(None))").ok);
});

test("damaged units heal once out of combat", () => {
  const w = world();
  const { spot } = twoPlayers(w);
  const u = w.addUnit(1, "worker", spot.x, spot.y, false);
  u.hp = 20;
  u.lastHit = { by: 999, owner: 2, tick: w.tick };
  steps(w, 50);
  assert.equal(u.hp, 20, "no healing within 10 s of a hit");
  steps(w, 100);
  assert.ok(u.hp > 20 && u.hp <= 50);
});

test("combat over the network: opt-in, public health, owner PvP flags, notices and persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-combat-"));
  const db = join(dir, "c.db");
  try {
    const cfg = testConfig(db);
    cfg.combat.enabled = true;
    const s1 = makeServer(db, cfg);
    const a = new TestClient(s1.game);
    a.hello("alice");
    const b = new TestClient(s1.game);
    b.hello("bob");
    const w = s1.world;
    assert.equal((a.inbox.find((m) => m.t === "welcome") as { world: { combatEnabled: boolean } }).world.combatEnabled, true);
    assert.ok(a.request({ t: "combat_optin", enabled: true })[0]?.t === "ack");
    assert.ok(b.request({ t: "combat_optin", enabled: true })[0]?.t === "ack");
    s1.game.tickOnce();
    assert.equal(a.player?.combat.active, true);
    // Put a soldier of Alice's right next to Bob's base, visible to Bob.
    const bobHall = [...w.buildingsOf(b.playerId)].map((id) => w.buildings.get(id)!)[0]!;
    const victim = [...w.unitsOf(b.playerId)].map((id) => w.units.get(id)!)[0]!;
    for (const id of w.unitsOf(b.playerId)) w.controlProgram(b.playerId, id, "stop");
    const soldier = w.addUnit(a.playerId, "soldier", victim.x + 1, victim.y, false);
    b.subscribeAround(bobHall.x, bobHall.y, 1);
    a.subscribeAround(bobHall.x, bobHall.y, 1);
    for (let i = 0; i < 5; i++) s1.game.tickOnce();
    // A target outside Alice's vision gets exactly the same answer as one that does not exist.
    const far = w.addUnit(b.playerId, "worker", soldier.x + 64 * 30, soldier.y, false);
    const rFar = a.request({ t: "unit_cmd", unitId: soldier.id, cmd: { kind: "attack", targetId: far.id } })[0];
    const rNone = a.request({ t: "unit_cmd", unitId: soldier.id, cmd: { kind: "attack", targetId: 987654 } })[0];
    assert.ok(rFar?.t === "error" && rNone?.t === "error" && rFar.code === rNone.code && rFar.message === rNone.message);
    const r = a.request({ t: "unit_cmd", unitId: soldier.id, cmd: { kind: "attack", targetId: victim.id } })[0];
    assert.equal(r?.t, "ack", JSON.stringify(r));
    for (let i = 0; i < 20; i++) s1.game.tickOnce();
    const seen = b.units.get(soldier.id);
    assert.ok(seen && seen.own === undefined, "Bob sees the soldier but not its private data");
    const hurt = a.units.get(victim.id);
    assert.ok(hurt && hurt.hpPct < 100 && hurt.own === undefined, "Alice sees how hurt Bob's unit is, nothing more");
    assert.ok(a.inbox.some((m) => m.t === "tick" && m.owners?.some((o) => o.id === b.playerId && o.pvp)), "owner info carries the PvP flag");
    for (let i = 0; i < 200 && w.units.has(victim.id); i++) s1.game.tickOnce();
    assert.ok(!w.units.has(victim.id));
    s1.game.tickOnce();
    assert.ok(b.inbox.some((m) => m.t === "tick" && m.notices?.some((n) => /was killed by alice/.test(n.text))), "Bob is told");
    assert.ok(!b.units.has(victim.id), "the dead unit is removed from clients");
    // Opting out is reported with its delay, and persisted.
    const off = b.request({ t: "combat_optin", enabled: false })[0];
    assert.ok(off?.t === "ack" && /stay attackable for \d+ more seconds/.test(off.message ?? ""), JSON.stringify(off));
    s1.game.flush();
    s1.game.stop();
    s1.store.close();
    const s2 = makeServer(db, cfg);
    assert.ok(!s2.world.units.has(victim.id), "the death survives a restart");
    assert.ok(s2.world.units.has(soldier.id));
    assert.equal(s2.world.players.get(a.playerId)!.pvp, true);
    const pb = s2.world.players.get(b.playerId)!;
    assert.equal(pb.pvp, false);
    assert.ok(pb.pvpUntil !== null && s2.world.pvpActive(b.playerId), "still leaving PvP after the restart");
    s2.game.stop();
    s2.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on_attacked(attacker) interrupts the current action, at most every 2 seconds", () => {
  const w = world();
  const { spot } = twoPlayers(w);
  w.setPvp(1, true);
  w.setPvp(2, true);
  const v = w.addUnit(2, "builder", spot.x, spot.y, false);
  const src = `def on_attacked(a):
    print("attacked by", a.kind, me.hp < me.max_hp)
    flee(a)

r = wait(30)
print("wait returned", r)
`;
  assert.ok(w.setProgram(2, v.id, src, 1).ok);
  w.controlProgram(2, v.id, "run");
  w.step();
  const s = w.addUnit(1, "soldier", spot.x + 1, spot.y, false);
  assert.ok(w.commandUnit(1, s.id, { kind: "attack", targetId: v.id }).ok);
  for (let i = 0; i < 25; i++) w.step();
  const calls = v.log.filter((l) => l.includes("attacked by soldier True")).length;
  assert.equal(calls, 1, v.log.join("\n"));
  assert.ok(v.trace.some((e) => e.call.startsWith("wait(") && e.result === "interrupted: attacked"), JSON.stringify(v.trace));
  for (let i = 0; i < 60 && v.program.state === "running"; i++) w.step();
  assert.ok(v.log.some((l) => l.includes("wait returned None")), v.log.join("\n"));
  // Wrong arity is a compile error, like other handlers.
  const bad = compileSource("def on_attacked():\n    pass\n");
  assert.ok(!bad.ok);
});
