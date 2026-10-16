import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGenerator } from "../src/shared/worldgen.ts";
import { ChunkStore } from "../src/sim/chunks.ts";
import { localIndex } from "../src/shared/coords.ts";
import { PARAMS } from "./helpers.ts";

const gen = (seed = "test-seed") => new WorldGenerator({ ...PARAMS, seed });
const digest = (c: { tiles: Uint8Array; nodes: unknown[] }) => `${Buffer.from(c.tiles).toString("base64")}|${JSON.stringify(c.nodes)}`;

test("identical seeds produce identical chunks", () => {
  const a = gen();
  const b = gen();
  for (const [cx, cy] of [[0, 0], [3, -2], [-5, 7]] as const) assert.equal(digest(a.generateChunk(cx, cy)), digest(b.generateChunk(cx, cy)));
});

test("different seeds produce meaningfully different terrain", () => {
  const a = gen("alpha").generateChunk(0, 0);
  const b = gen("beta").generateChunk(0, 0);
  let diff = 0;
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) diff++;
  assert.ok(diff / a.tiles.length > 0.25, `only ${diff} of ${a.tiles.length} tiles differ`);
});

test("generation is independent of chunk request order", () => {
  const order1 = gen();
  const order2 = gen();
  const coords: [number, number][] = [[0, 0], [1, 0], [-1, -1], [2, 5]];
  const r1 = coords.map(([x, y]) => digest(order1.generateChunk(x, y)));
  const r2 = [...coords].reverse().map(([x, y]) => digest(order2.generateChunk(x, y))).reverse();
  assert.deepEqual(r1, r2);
});

test("negative coordinates and chunk boundaries agree with per-tile generation (no seams)", () => {
  const g = gen();
  const size = PARAMS.chunkSize;
  for (const [cx, cy] of [[-1, -1], [-1, 0], [0, -1], [-3, 2]] as const) {
    const c = g.generateChunk(cx, cy);
    for (const [lx, ly] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1], [17, 42]] as const) {
      const x = cx * size + lx;
      const y = cy * size + ly;
      assert.equal(c.tiles[ly * size + lx], g.terrainAt(x, y), `tile ${x},${y}`);
      assert.equal(localIndex(x, y, size), ly * size + lx);
    }
  }
  // Adjacent chunks are continuous: the tile left of a chunk boundary comes from the neighbour chunk.
  const left = g.generateChunk(-1, 0);
  const right = g.generateChunk(0, 0);
  assert.equal(left.tiles[size - 1], g.terrainAt(-1, 0));
  assert.equal(right.tiles[0], g.terrainAt(0, 0));
});

test("terrain forms regions rather than uniform noise", () => {
  const g = gen();
  const c = g.generateChunk(0, 0);
  let same = 0;
  let total = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 63; x++) {
    total++;
    if (c.tiles[y * 64 + x] === c.tiles[y * 64 + x + 1]) same++;
  }
  assert.ok(same / total > 0.75, `neighbour coherence ${(same / total).toFixed(2)}`);
});

test("chunk modifications survive eviction and regeneration", () => {
  const store = new ChunkStore(gen(), 16);
  const c = store.getChunk(0, 0);
  const [li, node] = [...c.nodes.entries()][0] ?? assert.fail("no nodes in chunk");
  const x = li % 64;
  const y = Math.floor(li / 64);
  const taken = store.takeFromNode(x, y, 5);
  assert.equal(taken, 5);
  const remaining = node.amount;
  for (let i = 1; i <= 40; i++) store.getChunk(i, i); // evict chunk 0,0
  assert.equal(store.nodeAt(x, y)?.amount, remaining);
  // Persisted modifications re-applied in a fresh store.
  const fresh = new ChunkStore(gen(), 16);
  fresh.loadMods(0, 0, store.exportMods("0,0"));
  assert.equal(fresh.nodeAt(x, y)?.amount, remaining);
});

test("exploration only generates the chunks it touches", () => {
  const store = new ChunkStore(gen(), 64);
  store.terrainAt(10_000, -20_000);
  assert.equal(store.generatedCount, 1);
});

test("invalid generation parameters are rejected", () => {
  assert.throws(() => new WorldGenerator({ ...PARAMS, seed: "" }), /seed/);
  assert.throws(() => new WorldGenerator({ ...PARAMS, generationVersion: 99 }), /generationVersion/);
  assert.throws(() => new WorldGenerator({ ...PARAMS, chunkSize: 7 }), /chunkSize/);
  assert.throws(() => new WorldGenerator({ ...PARAMS, resourceDensity: 50 }), /resourceDensity/);
});
