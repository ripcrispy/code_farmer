import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUND, GROUND_MATRIX, depthOf, toScreen, toTile } from "../src/client/render/iso.ts";

test("isometric projection: screen and tile coordinates are inverses; ground layer matches", () => {
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [12.5, -7.25], [-300, 4000]] as const) {
    const s = toScreen(x, y);
    const t = toTile(s.x, s.y);
    assert.ok(Math.abs(t.x - x) < 1e-9 && Math.abs(t.y - y) < 1e-9, `${x},${y}`);
    // The ground container maps ground pixels (tile * GROUND) to the same screen point.
    const m = GROUND_MATRIX;
    const gx = x * GROUND;
    const gy = y * GROUND;
    assert.ok(Math.abs(m.a * gx + m.c * gy - s.x) < 1e-9 && Math.abs(m.b * gx + m.d * gy - s.y) < 1e-9);
  }
  // A tile is a 2:1 diamond: +x goes right-down, +y goes left-down.
  assert.deepEqual(toScreen(1, 0), { x: 32, y: 16 });
  assert.deepEqual(toScreen(0, 1), { x: -32, y: 16 });
  // Things further down the screen are drawn later.
  assert.ok(depthOf(5, 5) > depthOf(5, 4) && depthOf(5, 4) > depthOf(4, 4));
});
