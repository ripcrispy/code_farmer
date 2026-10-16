# Phase 0 assessment (2026-10-09)

## 1. Current project structure

The project folder was **empty**: no files, no git repository, no existing code, dependencies, configuration or tests. Per the project specification, the project was initialised from scratch.

## 2. Existing working functionality

None.

## 3. Missing or incomplete systems

Everything in the project specification. The first milestone targets the central loop (§25): three starting units -> inspectable programs -> movement -> gathering -> storage -> construction -> persistent progress. Races (beyond selection), levels, talents, discovery, territory, the code library and combat are out of scope for this milestone.

## 4. Dependency and compatibility concerns

| Concern | Resolution |
| --- | --- |
| Build environment had no npm registry access | Server-side code uses only packages available locally (`ws`, `typescript`, `tsx`) plus Node built-ins; client dependencies are declared but could not be installed or verified (DECISIONS D12). |
| Native SQLite modules often fail to build on Windows | Use Node's built-in `node:sqlite` (Node >= 22.13). |
| PixiJS 8 / @pixi/react 8 API sensitivity | Checked the @pixi/react README: v8 targets React 19 and pixi.js ^8.2.6; `useApplication()` returns `{ app }`; `resizeTo` accepts a React ref. The renderer uses a small, stable subset of the PixiJS 8 API (Container, Graphics, Sprite, Texture.from(canvas)). |
| TypeScript type stripping | Code uses only erasable syntax (no enums or parameter properties), so it runs under `tsx` and Node's native type stripping alike. |

## 5. Architectural risks

1. **Script execution cost at scale:** mitigated by per-unit and global instruction budgets with fair deferral; needs load testing (Phase 8).
2. **Pathfinding cost:** bounded A* (48-tile radius) per path. Long journeys need hierarchical pathfinding later.
3. **Single-process server and SQLite:** fine for development and modest player counts; a PostgreSQL `GameStore` is the migration path (D3).
4. **Information leakage:** all views are produced server-side and filtered by ownership and vision; tests assert that other players' programs never reach a client.
5. **Generation changes breaking worlds:** guarded by `GENERATION_VERSION` and the stored world meta.
6. **Client unverified with real PixiJS:** the main open risk from this session.

## 6. Recommended implementation sequence

1. Deterministic shared core (hashing, worldgen, data definitions).
2. The language: lexer -> parser -> compiler -> VM, with tests.
3. Simulation: units, tasks, pathfinding, gathering, storage, construction, training.
4. Server: protocol validation, sessions, interest management, persistence, migrations.
5. Client: connection, state mirror, renderer, panels, editor.
6. Tests at every layer, a headless smoke bot, and browser verification.
7. Then Phases 4-9 (ROADMAP.md).

Because the simulation was built transport-free and hosted on the server from the start, Phases 1-3 largely collapse into this first milestone (D1).

## 7. First vertical slice

A player connects in a browser, gets a Town Hall and three units running default programs, opens a unit's code, edits and runs it, watches units gather and deposit, places a Stockpile or Farm that a Builder constructs, trains a Worker, sees a second player in the same world, and finds everything intact after a server restart.

## 8. Acceptance criteria and tests

| Criterion | Evidence |
| --- | --- |
| Exactly three starting units defined in data | `sim.test.ts` |
| Program edits change behaviour in the world | `sim.test.ts` ("custom script deposits wood"), `integration.test.ts`, smoke bot, browser harness |
| Gathering, capacity, depletion, deposit are correct and atomic | `sim.test.ts` |
| Construction validated and charged exactly once | `sim.test.ts`, `multiplayer.test.ts` |
| Broken or infinite programs cannot freeze units or the server | `script.test.ts`, `sim.test.ts` |
| Two clients share one consistent world; no unauthorised control or leakage | `multiplayer.test.ts`, `integration.test.ts` |
| State survives restart; seed cannot silently change | `persistence.test.ts`, manual restart check |
| A player can do all of this from the browser UI | Browser harness (real PixiJS pending; see TESTING.md) |
