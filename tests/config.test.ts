import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, simConfigOf } from "../src/server/config.ts";

function withFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cf-cfg-"));
  const p = join(dir, "server.json");
  writeFileSync(p, content);
  try {
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults are used when no config file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-cfg-"));
  const { config, source } = loadConfig({}, dir);
  assert.equal(source, "built-in defaults");
  assert.deepEqual(config, DEFAULT_CONFIG);
  rmSync(dir, { recursive: true });
});

test("the shipped config/server.json is valid", () => {
  const { config } = loadConfig({}, process.cwd());
  assert.equal(config.world.generationVersion, 2);
  assert.equal(config.combat.enabled, false, "combat ships switched off");
  assert.equal(config.economy.storage, "shared", "storage networks ship switched off");
});

test("partial config files merge over defaults; env overrides apply", () => {
  withFile(JSON.stringify({ world: { seed: "my-seed" }, simulation: { tickRate: 20 } }), (p) => {
    const { config } = loadConfig({ CODEFARMER_CONFIG: p, CODEFARMER_PORT: "4000" });
    assert.equal(config.world.seed, "my-seed");
    assert.equal(config.world.chunkSize, 64);
    assert.equal(config.simulation.tickRate, 20);
    assert.equal(config.server.port, 4000);
  });
});

test("economy settings reach the simulation config", () => {
  withFile(JSON.stringify({ economy: { storage: "networks", unitLimitCeiling: 120 } }), (p) => {
    const { config } = loadConfig({ CODEFARMER_CONFIG: p });
    const sim = simConfigOf(config);
    assert.equal(sim.storageMode, "networks");
    assert.equal(sim.unitLimitCeiling, 120);
    assert.equal(sim.buildingLimitCeiling, 400);
  });
});

test("invalid configuration produces clear errors", () => {
  const cases: [unknown, RegExp][] = [
    [{ world: { seed: "" } }, /seed/],
    [{ world: { chunkSize: 1000 } }, /chunkSize/],
    [{ world: { generationVersion: 7 } }, /generationVersion/],
    [{ simulation: { tickRate: 0 } }, /tickRate/],
    [{ simulation: { tickRate: 500 } }, /tickRate/],
    [{ simulation: { tickRate: "fast" } }, /must be a number/],
    [{ server: { port: 70000 } }, /port/],
    [{ wrold: {} }, /unknown setting 'config.wrold'/],
    [{ world: { sead: "x" } }, /unknown setting 'config.world.sead'/],
    [{ combat: { enabled: "yes" } }, /combat.enabled' must be a boolean/],
    [{ combat: { optOutDelaySeconds: 1 } }, /optOutDelaySeconds/],
    [{ simulation: { combatEnabled: true } }, /unknown setting 'config.simulation.combatEnabled'/],
    [{ economy: { storage: "per-building" } }, /economy.storage must be "shared" or "networks"/],
    [{ economy: { storage: 3 } }, /economy.storage/],
    [{ economy: { unitLimitCeiling: 5 } }, /unitLimitCeiling/],
    [{ economy: { buildingLimitCeiling: 2.5 } }, /buildingLimitCeiling/],
    [{ simulation: { storageMode: "networks" } }, /unknown setting 'config.simulation.storageMode'/],
  ];
  for (const [c, re] of cases) withFile(JSON.stringify(c), (p) => assert.throws(() => loadConfig({ CODEFARMER_CONFIG: p }), re, JSON.stringify(c)));
  withFile("{ not json", (p) => assert.throws(() => loadConfig({ CODEFARMER_CONFIG: p }), /not valid JSON/));
  assert.throws(() => loadConfig({ CODEFARMER_CONFIG: "/nonexistent/x.json" }), /does not exist/);
});
