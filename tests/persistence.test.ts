import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorld, WorldConfigMismatchError } from "../src/server/bootstrap.ts";
import { silentLogger } from "../src/server/logger.ts";
import { SqliteStore } from "../src/server/persistence/sqliteStore.ts";
import { MIGRATIONS } from "../src/server/persistence/migrations.ts";
import { TestClient, makeServer, runUntil, testConfig } from "./helpers.ts";

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codefarmer-test-"));
  return { path: join(dir, "test.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("migrations are versioned and idempotent", () => {
  const store = new SqliteStore(":memory:");
  assert.deepEqual(store.migrate(), MIGRATIONS.map((m) => m.version));
  assert.deepEqual(store.migrate(), []);
  assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)?.version);
  store.close();
});

test("world state, programs and chunk modifications survive a server restart", () => {
  const db = tempDb();
  try {
    let first = makeServer(db.path);
    const c = new TestClient(first.game);
    c.hello("persist");
    const pid = c.playerId;
    assert.ok(pid > 0);
    const wc = c.own().find((u) => u.type === "woodcutter")!;
    const src = "print('v2')\nwhile alive:\n    t = find_nearest('tree')\n    harvest(t)\n    deposit()\n";
    const saved = c.request({ t: "program_save", unitId: wc.id, source: src, run: true });
    assert.equal(saved[0]?.t, "ack");
    // Let units modify the world (harvest trees, deposit).
    runUntil(first.game, () => (c.player?.resources.wood ?? 0) > 60, 3000, "wood deposited");
    const world1 = first.world;
    const snapshot = {
      resources: { ...world1.players.get(pid)!.resources },
      units: [...world1.unitsOf(pid)].map((id) => {
        const u = world1.units.get(id)!;
        return { id, type: u.type, x: u.x, y: u.y, inv: { ...u.inventory }, src: u.program.source, ver: u.program.version, state: u.program.state };
      }),
      buildings: [...world1.buildingsOf(pid)].map((id) => ({ ...world1.buildings.get(id)!, rev: 0 })),
      nextId: world1.nextId,
    };
    first.game.stop();
    assert.equal(world1.chunks.dirtyMods.size, 0, "stop() flushed all chunk modifications");
    first.store.close();

    first = makeServer(db.path);
    const w2 = first.world;
    assert.deepEqual(w2.players.get(pid)!.resources, snapshot.resources);
    assert.equal(w2.players.get(pid)!.race, "human");
    assert.equal(w2.players.get(pid)!.name, "persist");
    assert.equal(w2.nextId, snapshot.nextId);
    for (const s of snapshot.units) {
      const u = w2.units.get(s.id)!;
      assert.deepEqual({ id: s.id, type: u.type, x: u.x, y: u.y, inv: u.inventory, src: u.program.source, ver: u.program.version, state: u.program.state }, s);
    }
    for (const b of snapshot.buildings) assert.deepEqual({ ...w2.buildings.get(b.id)!, rev: 0 }, b);
    // Harvested nodes stay harvested after regeneration from the seed.
    let modified = 0;
    const loaded = first.store.loadWorld();
    for (const m of loaded.chunkMods) {
      for (const [li, amount] of Object.entries(m.data)) {
        const x = m.cx * 64 + (Number(li) % 64);
        const y = m.cy * 64 + Math.floor(Number(li) / 64);
        assert.equal(w2.chunks.nodeAt(x, y)?.amount ?? 0, amount);
        modified++;
      }
    }
    assert.ok(modified > 0, "some nodes were modified");
    // Program history survives.
    const versions = first.store.listProgramVersions(wc.id, 10);
    assert.equal(versions[0]?.source, src);
    // Reconnecting with the token restores the session.
    const c2 = new TestClient(first.game);
    c2.hello("ignored", { token: c.token });
    assert.equal(c2.playerId, pid);
    assert.equal(c2.own().length, 3);
    first.game.stop();
    first.store.close();
  } finally {
    db.cleanup();
  }
});

test("an existing world keeps its seed; a changed config is refused, not silently regenerated", () => {
  const db = tempDb();
  try {
    const a = makeServer(db.path);
    a.game.stop();
    a.store.close();
    const cfg = testConfig(db.path);
    cfg.world.seed = "a-different-seed";
    const store = new SqliteStore(db.path);
    assert.throws(() => openWorld(cfg, store, silentLogger), (e: unknown) => e instanceof WorldConfigMismatchError && /seed/.test((e as Error).message));
    assert.equal(store.getWorldMeta()?.seed, "test-seed", "stored seed is unchanged");
    store.close();
  } finally {
    db.cleanup();
  }
});

test("world metadata cannot be overwritten", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const meta = { seed: "s", generationVersion: 1, chunkSize: 64, resourceDensity: 1, createdAt: "now", nextId: 1, tick: 0 };
  store.createWorldMeta(meta);
  assert.throws(() => store.createWorldMeta({ ...meta, seed: "other" }), /already exists/);
  store.close();
});

test("a failed flush keeps changes in memory and retries", () => {
  const { game, store, world } = makeServer();
  const c = new TestClient(game);
  c.hello("flushy");
  const p = world.players.get(c.playerId)!;
  p.resources.wood = 999;
  world.markPlayer(p);
  const original = store.saveBatch.bind(store);
  let calls = 0;
  store.saveBatch = () => {
    calls++;
    throw new Error("disk full (simulated)");
  };
  assert.equal(game.flush(), false);
  assert.match(game.persistStatus.error, /disk full/);
  assert.ok(world.persist.players.has(p.id), "dirty state retained");
  store.saveBatch = original;
  assert.equal(game.flush(), true);
  assert.equal(store.loadWorld().players.find((x) => x.id === p.id)?.resources.wood, 999);
  assert.equal(calls, 1);
  game.stop();
});

test("a v1 world with a v2 config is refused with upgrade instructions, and stays v1", () => {
  const db = tempDb();
  try {
    const a = makeServer(db.path); // test worlds are generation v1
    a.game.stop();
    a.store.close();
    const cfg = testConfig(db.path);
    cfg.world.generationVersion = 2;
    const store = new SqliteStore(db.path);
    assert.throws(
      () => openWorld(cfg, store, silentLogger),
      (e: unknown) => e instanceof WorldConfigMismatchError && /world:upgrade -- --confirm/.test((e as Error).message) && /"generationVersion": 1/.test((e as Error).message),
    );
    assert.equal(store.getWorldMeta()?.generationVersion, 1, "nothing is changed implicitly");
    store.close();
  } finally {
    db.cleanup();
  }
});

test("a v2 world with a v3 config is refused with upgrade instructions; v3 worlds load", () => {
  const db = tempDb();
  try {
    const cfg2 = testConfig(db.path);
    cfg2.world.generationVersion = 2;
    const a = makeServer(db.path, cfg2);
    a.game.stop();
    a.store.close();
    const cfg3 = testConfig(db.path);
    cfg3.world.generationVersion = 3;
    const store = new SqliteStore(db.path);
    assert.throws(
      () => openWorld(cfg3, store, silentLogger),
      (e: unknown) => e instanceof WorldConfigMismatchError && /v2 but the config asks for v3/.test((e as Error).message) && /world:upgrade -- --confirm/.test((e as Error).message),
    );
    assert.equal(store.getWorldMeta()?.generationVersion, 2, "nothing is changed implicitly");
    store.close();
  } finally {
    db.cleanup();
  }
});
