import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/script/compiler.ts";
import { VM, ScriptRuntimeError, type ScriptHost, type RunResult } from "../src/script/vm.ts";
import { repr, type Value } from "../src/script/values.ts";
import { UNIT_DEFS } from "../src/shared/defs/units.ts";

function host(log: string[] = []): ScriptHost {
  return {
    query(name, args) {
      if (name === "print") {
        log.push(args.map((a) => repr(a)).join(" "));
        return null;
      }
      if (name === "stock") return 7;
      throw new ScriptRuntimeError(`no ${name}`);
    },
    namespaceValue: (ns, attr) => (ns === "me" && attr === "x" ? 3 : undefined),
    validateAction: () => {},
  };
}

function run(src: string, results: Value[] = []): { log: string[]; last: RunResult; actions: string[] } {
  const c = compileSource(src);
  if (!c.ok) throw new Error(JSON.stringify(c.diagnostics));
  const log: string[] = [];
  const vm = new VM(c.program, host(log));
  const actions: string[] = [];
  let last = vm.run(1_000_000);
  while (last.status === "action") {
    actions.push(`${last.action.name}(${last.action.args.map((a) => repr(a, 1)).join(",")})`);
    vm.resume(results.shift() ?? true);
    last = vm.run(1_000_000);
  }
  return { log, last, actions };
}

test("default unit programs compile", () => {
  for (const d of Object.values(UNIT_DEFS)) assert.ok(compileSource(d.defaultProgram).ok, d.type);
});

test("supported syntax parses and evaluates", () => {
  const { log, last } = run(`
def add(a, b):
    return a + b
total = 0
for i in range(5):
    if i == 2:
        continue
    total += i
n = 0
while True:
    n += 1
    if n >= 3:
        break
xs = [1, 2]
xs.append(3)
xs[0] = 10
s = "abc"
print(add(total, 1), n, xs, len(xs), xs[-1], 7 // 2, 7 / 2, -7 % 3, s[1], "b" in s, 3 in range(5), not False)
print(1 < 2 and 2 < 3, None is None, 0 or "fallback", abs(-4), min(3, 1, 2), max([4, 9]), int("12"), str(5) + "!", round(2.6))
x = 5
if x > 10:
    print("big")
elif x > 3:
    print("medium")
else:
    print("small")
print(me.x, stock("wood"))
`);
  assert.equal(last.status, "done");
  assert.deepEqual(log, ["9 3 [10, 2, 3] 3 3 3 3.5 2 b True True True", "True True fallback 4 1 9 12 5! 3", "medium", "3 7"]);
});

test("actions suspend the VM and resume with results", () => {
  const { actions, log } = run(`r = move_to(4, 5)\nprint("arrived", r)\nwait(2)\nprint(harvest == harvest)`, [false]);
  assert.deepEqual(actions, ["move_to(4,5)", "wait(2)"]);
  assert.equal(log[0], "arrived False");
});

test("unsupported syntax produces diagnostics with line and column", () => {
  const cases: [string, number, number, RegExp][] = [
    ["import os", 1, 1, /import/],
    ["x = 1\nclass A:\n    pass", 2, 1, /class/],
    ["while True\n    pass", 1, 11, /Expected ':'/],
    ["f = lambda x: x", 1, 5, /lambda/],
    ["x = {1, 2}", 1, 7, /dictionary key/],
    ["a, b = 1, 2", 1, 2, /Tuples/],
    ["print(x=1)", 1, 7, /Keyword/],
    ["x = 2 ** 3", 1, 7, /power/],
    ["if True:\n  x = 1\n x = 2", 3, 2, /Unindent/],
    ["x = __import__", 1, 5, /reserved/],
  ];
  for (const [src, line, col, re] of cases) {
    const r = compileSource(src);
    assert.equal(r.ok, false, src);
    if (!r.ok) {
      const d = r.diagnostics[0];
      assert.ok(d, src);
      assert.match(d.message, re, src);
      assert.equal(d.line, line, `${src}: ${d.message}`);
      assert.equal(d.col, col, `${src}: ${d.message}`);
    }
  }
});

test("invalid commands are rejected at compile time", () => {
  const unknown = compileSource("launch_missiles()");
  assert.ok(!unknown.ok && /Unknown name 'launch_missiles'/.test(unknown.diagnostics[0]!.message));
  const arity = compileSource("harvest()");
  assert.ok(!arity.ok && /takes 1 argument/.test(arity.diagnostics[0]!.message));
  const redefine = compileSource("move_to = 3");
  assert.ok(!redefine.ok && /built-in/.test(redefine.diagnostics[0]!.message));
  const attr = compileSource("t = find_nearest('tree')\nt.x = 4");
  assert.ok(!attr.ok && /read-only/.test(attr.diagnostics[0]!.message));
});

test("instruction budgets are enforced per run() call", () => {
  const c = compileSource("i = 0\nwhile True:\n    i += 1\n");
  assert.ok(c.ok);
  const vm = new VM(c.program, host());
  const r = vm.run(250);
  assert.equal(r.status, "budget");
  assert.ok(r.ops <= 260);
});

test("an infinite loop without actions is stopped with a clear error, not a hang", () => {
  const c = compileSource("while alive:\n    x = 1\n");
  assert.ok(c.ok);
  const vm = new VM(c.program, host());
  const t0 = Date.now();
  let r: RunResult;
  let calls = 0;
  do {
    r = vm.run(400);
    calls++;
  } while (r.status === "budget" && calls < 10_000);
  assert.equal(r.status, "error");
  if (r.status === "error") {
    assert.match(r.error.message, /Instruction budget exceeded/);
    assert.equal(r.error.line, 1);
  }
  assert.ok(Date.now() - t0 < 2000);
});

test("runaway recursion and memory are bounded", () => {
  const rec = compileSource("def f(n):\n    return f(n + 1)\nf(0)");
  assert.ok(rec.ok);
  const r1 = new VM(rec.program, host()).run(1_000_000);
  assert.ok(r1.status === "error" && /call depth/.test(r1.error.message));
  const mem = compileSource("a = []\nfor i in range(100):\n    a.append([0] * 1000)\n    wait(0)\n");
  assert.ok(mem.ok);
  const vm = new VM(mem.program, host());
  let r = vm.run(1_000_000);
  while (r.status === "action") {
    vm.resume(null);
    r = vm.run(1_000_000);
  }
  assert.ok(r.status === "error" && /Memory limit/.test(r.error.message), JSON.stringify(r));
  const big = compileSource("x = [0] * 5000");
  assert.ok(big.ok);
  const r3 = new VM(big.program, host()).run(1000);
  assert.ok(r3.status === "error" && /too long/.test(r3.error.message));
});

test("runtime errors report the failing line", () => {
  const c = compileSource("x = 1\ny = None\nprint(y.x)\n");
  assert.ok(c.ok);
  const r = new VM(c.program, host()).run(1000);
  assert.ok(r.status === "error");
  if (r.status === "error") {
    assert.equal(r.error.line, 3);
    assert.match(r.error.message, /None/);
  }
  const z = compileSource("x = 1 / 0");
  assert.ok(z.ok);
  const r2 = new VM(z.program, host()).run(100);
  assert.ok(r2.status === "error" && /Division by zero/.test(r2.error.message));
});

test("scripts cannot reach server resources", () => {
  // No names exist for process, require, globalThis, fetch, eval, etc.
  for (const name of ["process", "require", "globalThis", "fetch", "constructor", "open", "getattr", "setattr", "exec", "eval"]) {
    const r = compileSource(`x = ${name}`);
    assert.equal(r.ok, false, name);
  }
  // Attribute access on values is whitelisted.
  const c = compileSource("x = 'abc'\ny = x.constructor");
  assert.ok(c.ok);
  const r = new VM(c.program, host()).run(100);
  assert.ok(r.status === "error" && /has no attribute/.test(r.error.message));
  const c2 = compileSource("l = []\ny = l.__proto__");
  assert.equal(c2.ok, false);
});

test("program size limits", () => {
  const r = compileSource("x = 1\n".repeat(5000));
  assert.ok(!r.ok && /too long|too many|too complex/i.test(r.diagnostics[0]!.message));
});

test("dictionaries: literals, indexing, methods, iteration and membership", () => {
  const { log, last } = run(`
d = {"wood": 3, "stone": 1}
d["gold"] = 7
d["wood"] += 2
total = 0
for k in d:
    total += d[k]
print(len(d), d["wood"], d.get("food", 0), "gold" in d, "food" not in d, total)
print(d.keys(), d.values(), d.items()[0], d.pop("stone"), len(d))
e = {}
e[1] = True
print(e, {"a": [1, 2]} == {"a": [1, 2]})
`);
  assert.equal(last.status, "done");
  assert.deepEqual(log, ["3 5 0 True True 13", '["wood", "stone", "gold"] [5, 1, 7] ["wood", 5] 1 2', "{1: True} True"]);
});

test("try/except catches game errors and exposes the message", () => {
  const { log, last } = run(`
try:
    x = None
    print(x.amount)
except Exception as e:
    print("caught:", e)
try:
    d = {}
    v = d["missing"]
except:
    print("missing key handled")
n = 0
while n < 3:
    n += 1
    try:
        if n == 2:
            continue
        print("n", n)
    except:
        pass
print("after", n)
def risky():
    try:
        return 1 / 0
    except:
        return -1
print(risky())
`);
  assert.equal(last.status, "done", JSON.stringify(last));
  assert.equal(log[0], "caught: Cannot read '.amount' of None - check the value is not None first");
  assert.deepEqual(log.slice(1), ["missing key handled", "n 1", "n 3", "after 3", "-1"]);
});

test("limit violations cannot be caught by try/except", () => {
  const c = compileSource("try:\n    while True:\n        x = 1\nexcept:\n    print('swallowed')\n");
  assert.ok(c.ok);
  const vm = new VM(c.program, host());
  let r: RunResult;
  do r = vm.run(10_000);
  while (r.status === "budget");
  assert.equal(r.status, "error");
  if (r.status === "error") assert.match(r.error.message, /Instruction budget exceeded/);
  const rec = compileSource("def f():\n    return f()\ntry:\n    f()\nexcept:\n    pass\n");
  assert.ok(rec.ok);
  const r2 = new VM(rec.program, host()).run(1_000_000);
  assert.ok(r2.status === "error" && /call depth/.test(r2.error.message));
});

test("on_action_failed runs before the failed action returns", () => {
  const c = compileSource(`
fails = []
def on_action_failed(action, reason):
    fails.append(action + ": " + reason)
    wait(1)
r = harvest(None)
print("returned", r, fails)
`);
  assert.ok(c.ok);
  const log: string[] = [];
  const vm = new VM(c.program, host(log));
  let r = vm.run(100_000);
  assert.equal(r.status, "action");
  vm.resume(0, { action: "harvest", reason: "Resource exhausted" });
  r = vm.run(100_000);
  assert.ok(r.status === "action" && r.action.name === "wait", "handler issued its own action");
  vm.resume(null);
  r = vm.run(100_000);
  assert.equal(r.status, "done");
  assert.deepEqual(log, ['returned 0 ["harvest: Resource exhausted"]']);
  const bad = compileSource("def on_action_failed(a):\n    pass\n");
  assert.ok(!bad.ok && /exactly 2 parameters/.test(bad.diagnostics[0]!.message));
});

test("new syntax diagnostics", () => {
  for (const [src, re] of [
    ["try:\n    x = 1\nfinally:\n    pass", /'finally' is not supported/],
    ["except:\n    pass", /without a matching 'try'/],
    ["try:\n    x = 1\nexcept ValueError:\n    pass", /Only 'except:'/],
    ["x = {1, 2}", /between a dictionary key/],
  ] as const) {
    const r = compileSource(src);
    assert.ok(!r.ok && re.test(r.diagnostics[0]!.message), `${src}: ${r.ok ? "ok" : r.diagnostics[0]!.message}`);
  }
});
