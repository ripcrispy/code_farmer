import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFix, complete, defaultContext, diagnose, hoverAt, signatureAt, warnings, type AssistContext } from "../src/script/assist.ts";
import { compileSource } from "../src/script/compiler.ts";
import { HERO_DEFS } from "../src/shared/defs/heroes.ts";
import { UNIT_DEFS } from "../src/shared/defs/units.ts";

/** Source with a "|" marking the cursor -> [source, offset]. */
function at(src: string): [string, number] {
  const i = src.indexOf("|");
  return [src.slice(0, i) + src.slice(i + 1), i];
}
const labels = (src: string, ctx: AssistContext = defaultContext(), explicit = false): string[] => {
  const [s, p] = at(src);
  return complete(s, p, ctx, explicit)?.options.map((o) => o.label) ?? [];
};

test("completions: commands, fuzzy matches, insertion with cursor placement", () => {
  const [s, p] = at("node = fin|");
  const r = complete(s, p, defaultContext());
  assert.ok(r);
  const first = r.options[0]!;
  assert.equal(first.label, "find_nearest");
  assert.equal(first.insert, 'find_nearest("")');
  assert.equal(first.cursor, 'find_nearest("'.length, "cursor lands inside the quotes");
  assert.equal(r.from, s.indexOf("fin"));
  assert.ok(labels("x = nearest|").includes("find_nearest"), "typing part of a name finds it");
  assert.ok(labels("x = harv|")[0] === "harvest");
  // Nothing in comments or without a prefix (unless explicitly asked).
  assert.equal(labels("# fin|").length, 0);
  assert.equal(labels("x = |").length, 0);
  assert.ok(labels("x = |", defaultContext(), true).length > 20);
});

test("completions: values inside string arguments", () => {
  const kinds = labels('t = find_nearest("|")');
  for (const k of ["tree", "stone", "gold", "berries", "storage", "construction", "ruin"]) assert.ok(kinds.includes(k), k);
  assert.equal(labels('t = find_nearest("tr|")')[0], "tree");
  const [s, p] = at('t = find_nearest("tr|');
  const r = complete(s, p, defaultContext())!;
  assert.equal(r.options[0]!.insert, 'tree"', "closes the string when it is open");
  assert.deepEqual(labels('withdraw("|")').sort(), ["food", "gold", "stone", "wood"]);
  assert.ok(labels('place("|")').includes("stockpile"));
  assert.ok(labels('train_unit("|")').includes("worker"));
  assert.ok(!labels('train_unit("|")').includes("hero_human"), "heroes are recruited, not trained");
  assert.deepEqual(labels('inventory.count("|")').sort(), ["food", "gold", "stone", "wood"]);
  // A hero's own abilities.
  const hero = defaultContext({ unitType: "hero_human" });
  assert.deepEqual(labels('use_ability("|")', hero).sort(), HERO_DEFS.human!.abilities.map((a) => a.id).sort());
});

test("completions: members, variables, functions, snippets, and notes on what will not work", () => {
  assert.ok(labels("me.|", defaultContext(), true).includes("max_hp"));
  assert.deepEqual(labels("inventory.c|").sort(), ["capacity", "count"]);
  const src = "def gather(kind):\n    pass\nhome = find_nearest(\"storage\")\nwhile alive:\n    ho|";
  assert.ok(labels(src).includes("home"), "variables");
  assert.ok(labels("while alive:\n    gat|".replace("while", "def gather(k):\n    pass\nwhile")).includes("gather"), "functions");
  assert.ok(labels("node.|", defaultContext(), true).includes("x"), "object attributes");
  assert.ok(labels("whi|").includes("while alive: (main loop)"), "snippet at line start");
  // Notes: locked, combat off, wrong unit type.
  const [s, p] = at("sc|");
  const scan = complete(s, p, defaultContext())!.options.find((o) => o.label === "scan")!;
  assert.match(scan.note ?? "", /Locked/);
  const [s2, p2] = at("att|");
  assert.match(complete(s2, p2, defaultContext())!.options.find((o) => o.label === "attack")!.note ?? "", /Combat is off/);
  assert.equal(complete(s2, p2, defaultContext({ combatEnabled: true }))!.options.find((o) => o.label === "attack")!.note, undefined);
  const [s3, p3] = at("use_ab|");
  assert.match(complete(s3, p3, defaultContext({ unitType: "woodcutter" }))!.options.find((o) => o.label === "use_ability")!.note ?? "", /Only your hero/);
  assert.match(complete(...at2("harv|"), defaultContext({ unitType: "hero_human" }))!.options.find((o) => o.label === "harvest")!.note ?? "", /cannot do this/);
});
function at2(src: string): [string, number] {
  return at(src);
}

test("signature help and hover documentation", () => {
  const [s, p] = at("follow(leader, |");
  const sig = signatureAt(s, p)!;
  assert.deepEqual(sig.params, ["target", "seconds=30"]);
  assert.equal(sig.active, 1);
  const [s2, p2] = at("move_to(3, |");
  assert.equal(signatureAt(s2, p2)!.label, "move_to(x, y)", "picks the variant with enough parameters");
  const [s3, p3] = at("def go(a, b):\n    pass\ngo(1, |");
  assert.deepEqual(signatureAt(s3, p3)!.params, ["a", "b"]);
  assert.equal(signatureAt(...at("print(1)|")), null, "closed call");
  const src = "home = find_nearest(\"storage\")\nharvest(home)\nif home is None:\n    pass";
  assert.match(hoverAt(src, src.indexOf("harvest") + 2, defaultContext())!.body, /gather/);
  assert.match(hoverAt(src, src.indexOf("None") + 1, defaultContext())!.body, /Nothing/);
  assert.match(hoverAt(src, src.lastIndexOf("home") + 1, defaultContext())!.body, /line 1/);
  assert.match(hoverAt(src, src.indexOf("storage") + 2, defaultContext())!.body, /storage/);
});

test("the compiler suggests the intended name for typos", () => {
  const r = compileSource("x = find_neares(\"tree\")\n");
  assert.ok(!r.ok && /Did you mean 'find_nearest'\?/.test(r.diagnostics[0]!.message), r.ok ? "" : r.diagnostics[0]!.message);
  const r2 = compileSource("count = 1\nprint(cuont)\n");
  assert.ok(!r2.ok && /Did you mean 'count'/.test(r2.diagnostics[0]!.message));
});

test("errors come with explanations and quick fixes that produce valid code", () => {
  const ctx = defaultContext();
  const cases = [
    "while alive\n    wait(1)\n",
    "if True:\nwait(1)\n",
    "while alive:\n    wait(1)\n      wait(2)\n",
    "x = 1; y = 2\nprint(x, y)\n",
    "node = find_neares(\"tree\")\nprint(node)\n",
  ];
  for (const src of cases) {
    const d = diagnose(src, ctx).find((x) => x.severity === "error");
    assert.ok(d, `error expected for ${JSON.stringify(src)}`);
    assert.ok(d.hint || d.fixes.length, `explanation for: ${d.message}`);
    assert.ok(d.fixes.length > 0, `fix for: ${d.message}`);
    const fixed = applyFix(src, d.fixes[0]!);
    const r = compileSource(fixed);
    assert.ok(r.ok, `fixed code compiles: ${JSON.stringify(fixed)} -> ${r.ok ? "" : r.diagnostics[0]!.message}`);
  }
});

test("warnings: unchecked None, loops without actions, unknown words; fixes remove them", () => {
  const ctx = defaultContext();
  const src = "while alive:\n    node = find_nearest(\"tree\")\n    harvest(node)\n    deposit()\n";
  const w = warnings(src, ctx);
  assert.equal(w.length, 1);
  assert.match(w[0]!.message, /None/);
  const fixed = applyFix(src, w[0]!.fixes[0]!);
  assert.equal(fixed, "while alive:\n    node = find_nearest(\"tree\")\n    if node is not None:\n        harvest(node)\n    deposit()\n");
  assert.ok(compileSource(fixed).ok);
  assert.equal(warnings(fixed, ctx).length, 0);
  // Already checked: no warning.
  assert.equal(warnings("n = find_nearest(\"tree\")\nif n is not None:\n    harvest(n)\n", ctx).length, 0);
  assert.equal(warnings("n = find_nearest(\"tree\")\nif n:\n    harvest(n)\n", ctx).length, 0);
  // A spinning loop.
  const spin = "count = 0\nwhile alive:\n    count += 1\n";
  const ws = warnings(spin, ctx);
  assert.equal(ws.length, 1);
  assert.match(ws[0]!.message, /never does an action/);
  const sf = applyFix(spin, ws[0]!.fixes[0]!);
  assert.equal(sf, "count = 0\nwhile alive:\n    count += 1\n    wait(1)\n");
  assert.equal(warnings(sf, ctx).length, 0);
  // A loop that calls a user function is fine (the function may act).
  assert.equal(warnings("def work():\n    wait(1)\nwhile alive:\n    work()\n", ctx).length, 0);
  // Unknown string value.
  const typo = 'x = find_nearest("tre")\nif x is not None:\n    harvest(x)\n';
  const wt = warnings(typo, ctx);
  assert.equal(wt.length, 1);
  assert.match(wt[0]!.message, /Did you mean "tree"/);
  assert.equal(applyFix(typo, wt[0]!.fixes[0]!), typo.replace('"tre"', '"tree"'));
});

test("every built-in default program is free of errors and warnings", () => {
  for (const def of Object.values(UNIT_DEFS)) {
    const ctx = defaultContext({ unitType: def.type, combatEnabled: true });
    for (const [label, src] of [["default", def.defaultProgram], ["wild", def.creature?.wildProgram ?? ""]] as const) {
      if (!src) continue;
      const d = diagnose(src, ctx);
      assert.deepEqual(d.map((x) => `${x.line}: ${x.message}`), [], `${def.type} ${label} program`);
    }
  }
});

test("every recipe compiles without warnings (the hero recipe for every race) and some run as described", async () => {
  const { RECIPES } = await import("../src/script/recipes.ts");
  const { World } = await import("../src/sim/world.ts");
  const { PARAMS } = await import("./helpers.ts");
  for (const hd of Object.values(HERO_DEFS)) {
    for (const r of RECIPES) {
      const code = r.code({ heroAbilities: hd.abilities });
      const ctx = defaultContext({ combatEnabled: true, unitType: r.for === "your hero" ? hd.type : null, unlocks: new Set(["command:scan"]) });
      assert.deepEqual(diagnose(code, ctx).map((d) => `${d.line}: ${d.message}`), [], `${r.id} (${hd.race})`);
    }
  }
  // The wood recipe gathers and stores wood; the stockpile recipe places and finishes a building.
  const w = new World({ ...PARAMS });
  assert.ok(w.createPlayer(1, "alice", "human").ok);
  for (const u of w.units.values()) w.controlProgram(1, u.id, "stop");
  const p = w.players.get(1)!;
  const units = [...w.unitsOf(1)].map((id) => w.units.get(id)!);
  const wc = units.find((u) => u.type === "woodcutter")!;
  const bd = units.find((u) => u.type === "builder")!;
  const before = p.resources.wood;
  for (const [u, id] of [[wc, "gather_wood"], [bd, "place_stockpile"]] as const) {
    const r = w.setProgram(1, u.id, RECIPES.find((x) => x.id === id)!.code({ heroAbilities: [] }), 1);
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.ok(w.controlProgram(1, u.id, "run").ok);
  }
  for (let i = 0; i < 1500; i++) w.step();
  assert.ok(p.resources.wood > before - 40, `wood ${before} -> ${p.resources.wood} (stockpile costs 36-40)`);
  assert.ok(wc.log.length === 0 || !wc.log.some((l) => /Error/.test(l)), wc.log.join("\n"));
  assert.ok(bd.log.some((l) => l.includes("Stockpile finished!")), bd.log.join("\n"));
  assert.ok([...w.buildingsOf(1)].some((id) => w.buildings.get(id)!.type === "stockpile" && w.buildings.get(id)!.complete));
});
