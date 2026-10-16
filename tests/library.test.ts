import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { parseImport } from "../src/server/library.ts";
import { TestClient, makeServer, runUntil } from "./helpers.ts";

const GATHER = `while alive:
    if inventory.is_full():
        deposit()
    else:
        t = find_nearest("tree")
        if t is None:
            explore()
        else:
            harvest(t)
`;

function ack(r: ServerMessage[]): Extract<ServerMessage, { t: "ack" }> {
  const m = r[0];
  assert.ok(m && m.t === "ack", JSON.stringify(r));
  return m as Extract<ServerMessage, { t: "ack" }>;
}

test("library programs are versioned, validated and assignable to groups of units", () => {
  const { game, world } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const saved = ack(a.request({ t: "lib_save", name: "Lumberjack", description: "Gather wood", unitTypes: [], shared: false, source: GATHER }));
  const pidProg = saved.id!;
  // A second save with changed source creates v2; unchanged source does not create a version.
  ack(a.request({ t: "lib_save", programId: pidProg, name: "Lumberjack", description: "Gather wood forever", unitTypes: [], shared: false, source: GATHER + "# v2\n" }));
  ack(a.request({ t: "lib_save", programId: pidProg, name: "Lumberjack", description: "same", unitTypes: [], shared: false, source: GATHER + "# v2\n" }));
  const got = a.request({ t: "lib_get", programId: pidProg })[0];
  assert.ok(got?.t === "library_program");
  if (got?.t === "library_program") {
    assert.equal(got.version, 2);
    assert.equal(got.versions.length, 2);
    assert.equal(got.program.description, "same");
  }
  // Validation
  const bad = a.request({ t: "lib_save", name: "Broken", description: "", unitTypes: [], shared: false, source: "while alive\n  pass" })[0];
  assert.ok(bad?.t === "error" && bad.code === "syntax_error");
  const badType = a.request({ t: "lib_save", name: "X", description: "", unitTypes: ["dragon"], shared: false, source: "wait(1)" })[0];
  assert.ok(badType?.t === "error" && /Unknown unit type/.test(badType.message));
  const dup = a.request({ t: "lib_save", name: "lumberjack", description: "", unitTypes: [], shared: false, source: "wait(1)" })[0];
  assert.ok(dup?.t === "error" && dup.code === "name_taken");
  // Assign v1 to every unit (group assignment by id list) and run.
  const ids = a.own().map((u) => u.id);
  const as = ack(a.request({ t: "lib_assign", programId: pidProg, version: 1, unitIds: ids, run: true }));
  assert.match(as.message ?? "", /to 3 units/);
  for (const id of ids) {
    const u = world.units.get(id)!;
    assert.equal(u.program.source, GATHER);
    assert.deepEqual(u.program.library, { id: pidProg, version: 1, name: "Lumberjack" });
    assert.equal(u.program.state, "running");
  }
  // The programs genuinely automate gathering.
  const wood0 = world.players.get(a.playerId)!.resources.wood;
  runUntil(game, () => world.players.get(a.playerId)!.resources.wood >= wood0 + 30, 3000, "library program gathers wood");
  // Unit-type compatibility is enforced.
  const scoutOnly = ack(a.request({ t: "lib_save", name: "Scout loop", description: "", unitTypes: ["scout"], shared: false, source: "while alive:\n    explore()\n" })).id!;
  const r = ack(a.request({ t: "lib_assign", programId: scoutOnly, unitIds: ids, run: false }));
  assert.match(r.message ?? "", /to 1 unit \(2 skipped/);
  const byType = ack(a.request({ t: "lib_assign", programId: pidProg, unitType: "woodcutter", run: true }));
  assert.match(byType.message ?? "", /to 1 unit/);
  game.stop();
});

test("sharing: others can read and copy shared programs but never edit or read private ones", () => {
  const { game } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const b = new TestClient(game);
  b.hello("bob");
  const priv = ack(a.request({ t: "lib_save", name: "Secret", description: "", unitTypes: [], shared: false, source: "wait(2)" })).id!;
  const pub = ack(a.request({ t: "lib_save", name: "Public", description: "for all", unitTypes: [], shared: true, source: GATHER })).id!;
  const list = b.request({ t: "lib_list" })[0];
  assert.ok(list?.t === "library");
  if (list?.t === "library") {
    assert.deepEqual(list.programs.map((p) => p.name), ["Public"]);
    assert.equal(list.programs[0]!.ownerName, "alice");
    assert.equal(list.programs[0]!.own, false);
  }
  const secret = b.request({ t: "lib_get", programId: priv })[0];
  assert.ok(secret?.t === "error" && secret.code === "not_found");
  assert.ok(!JSON.stringify(b.inbox).includes("wait(2)"), "private source never sent to another player");
  const edit = b.request({ t: "lib_save", programId: pub, name: "Public", description: "hacked", unitTypes: [], shared: true, source: "wait(1)" })[0];
  assert.ok(edit?.t === "error" && edit.code === "permission_denied");
  const del = b.request({ t: "lib_delete", programId: pub })[0];
  assert.ok(del?.t === "error" && del.code === "permission_denied");
  const assignOther = b.request({ t: "lib_assign", programId: pub, unitIds: a.own().map((u) => u.id), run: true })[0];
  assert.ok(assignOther?.t === "error" && assignOther.code === "permission_denied");
  const copy = ack(b.request({ t: "lib_copy", programId: pub }));
  const mine = b.request({ t: "lib_get", programId: copy.id! })[0];
  assert.ok(mine?.t === "library_program" && mine.program.own && mine.source === GATHER && mine.versions[0]!.note.includes("alice"));
  // A shared program can be assigned directly to your own units.
  ack(b.request({ t: "lib_assign", programId: pub, unitType: "builder", run: false }));
  game.stop();
});

test("export/import round-trips through the validated format; malformed imports are rejected", () => {
  const { game } = makeServer();
  const a = new TestClient(game);
  a.hello("alice");
  const id = ack(a.request({ t: "lib_save", name: "Exporter", description: "d", unitTypes: ["worker"], shared: false, source: GATHER })).id!;
  const ex = a.request({ t: "lib_export", programId: id })[0];
  assert.ok(ex?.t === "library_export");
  if (ex?.t !== "library_export") return;
  assert.match(ex.filename, /^Exporter\.v1\.cfprog\.json$/);
  const imp = ack(a.request({ t: "lib_import", text: ex.text }));
  assert.match(imp.message ?? "", /Imported "Exporter \(2\)"/);
  const back = a.request({ t: "lib_get", programId: imp.id! })[0];
  assert.ok(back?.t === "library_program" && back.source === GATHER && back.program.unitTypes[0] === "worker");
  const obj = JSON.parse(ex.text) as Record<string, unknown>;
  const cases: [unknown, RegExp][] = [
    ["{nope", /not valid JSON/],
    [{ ...obj, format: "other" }, /Not a Code Farmer program/],
    [{ ...obj, extra: 1 }, /Unknown field 'extra'/],
    [{ ...obj, languageVersion: 99 }, /language version 99/],
    [{ ...obj, source: "import os" }, /does not compile/],
    [{ ...obj, unitTypes: ["dragon"] }, /Unknown unit type/],
    [{ ...obj, source: 5 }, /must be strings/],
  ];
  for (const [c, re] of cases) {
    const text = typeof c === "string" ? c : JSON.stringify(c);
    const r = parseImport(text);
    assert.ok(!r.ok && re.test(r.message), `${text.slice(0, 60)} -> ${r.ok ? "ok" : r.message}`);
    const net = a.request({ t: "lib_import", text })[0];
    assert.ok(net?.t === "error" && net.code === "bad_import");
  }
  game.stop();
});

test("library and unit library links survive a restart; batch program control", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-lib-"));
  const db = join(dir, "lib.db");
  try {
    let s = makeServer(db);
    const a = new TestClient(s.game);
    a.hello("alice");
    const id = ack(a.request({ t: "lib_save", name: "Keep", description: "", unitTypes: [], shared: true, source: GATHER })).id!;
    ack(a.request({ t: "lib_assign", programId: id, unitType: "scout", run: true }));
    const ids = a.own().map((u) => u.id);
    const stop = ack(a.request({ t: "units_control", unitIds: ids, action: "stop" }));
    assert.match(stop.message ?? "", /stop: 3 units/);
    s.game.stop();
    s.store.close();
    s = makeServer(db);
    const scout = [...s.world.units.values()].find((u) => u.type === "scout")!;
    assert.deepEqual(scout.program.library, { id, version: 1, name: "Keep" });
    assert.equal(scout.program.state, "stopped");
    const a2 = new TestClient(s.game);
    a2.hello("", { token: a.token });
    const list = a2.request({ t: "lib_list" })[0];
    assert.ok(list?.t === "library" && list.programs.length === 1 && list.programs[0]!.shared);
    s.game.stop();
    s.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
