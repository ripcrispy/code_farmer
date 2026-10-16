# Architecture

## Module boundaries

```
src/
  shared/    Pure, deterministic code used by both client and server
    rng.ts, coords.ts         integer hashing, value noise, coordinate helpers
    worldgen.ts               seeded chunk generator (GENERATION_VERSION 3; supports 1, 2 and 3)
    zones.ts                  contested zones: a pure function of the seed (own hash), never touch terrain
    lairs.ts                  PvE lair positions (generation v3): a pure function of the seed (own hash)
    defs/                     data: terrain, resources, units (incl. creatures), buildings, races,
                              techs, talents, progression, discoveries, effects, balance, lairs (monster
                              camps, bosses, trophies), lessons
    protocol.ts               network message types + strict validator
  script/    The Code Farmer language (no game state access)
    lexer.ts, parser.ts, ast.ts   source -> AST with positions
    compiler.ts                   AST -> bytecode, name/arity/lock checks
    vm.ts                         budgeted, resumable stack VM (try/except, event handler)
    values.ts                     lists, dicts, object refs
    commands.ts                   registry of every script-visible name (incl. locked commands)
  sim/       Authoritative simulation (no I/O)
    world.ts                  entities, commands, tasks, step(), territory claims, XP, wildlife
    chunks.ts                 chunk cache, modification layer, berry regrowth, ruins
    pathfinding.ts            bounded exact A*
    coarse.ts                 hierarchical corridor routing over 8x8-tile cells
    territory.ts              per-tile ownership map
    modifiers.ts              aggregated effects (race, techs, talents, discoveries, trophies, paddock animals)
    phaseTimes.ts             rolling per-phase tick timings for /admin/status
    scriptHost.ts             query/action bridge between a unit's VM and the world
    types.ts
  server/    Node process: transport, sessions, persistence
    gameServer.ts             sessions, validation, interest management, broadcast, flush
    library.ts                code library requests
    views.ts                  what each player may see of units, buildings, players
    transport.ts              HTTP + WebSocket (library: ws)
    bootstrap.ts              open/create world, refuse config mismatches
    config.ts                 load + validate config/server.json and env
    persistence/              GameStore interface, SqliteStore, migrations (10)
    tools/                    migrate, world:info, world:reset, world:upgrade
  client/    Browser
    net/connection.ts         WebSocket + reqId correlation + reconnect
    state/gameState.ts        mirror of server state (never authoritative)
    actions.ts                player intents -> server requests
    render/                   PixiJS WorldRenderer (imperative), ground-painting Web Workers, frame profiler
    ui/                       React panels, editor, library, stats, talents, minimap, login
```

Dependency direction: `shared` <- `script` <- `sim` <- `server`; `client` depends on `shared` and `script` (for the editor's local diagnostics and command reference) but never on `sim` or `server`.

## Simulation

- Fixed tick (`simulation.tickRate`, default 10 Hz). `World.step()` runs: berry regrowth, wildlife spawning (a few newly active chunks per tick), the active-chunk refresh (once a second), guard zones, scripts, unit tasks, then buildings (training, research, production).
- All rules are integer tile-based and deterministic given the same command sequence. No `Math.random()`; random choices use seeded PRNGs keyed by unit id and tick.
- Entities: `PlayerState`, `UnitState`, `BuildingState` (`src/sim/types.ts`). Unit capabilities come from `UnitDef.capabilities` (`gather`, `build`, `explore`, `follow`, `guard`), not from type names. Wild creatures are ordinary units owned by the wildlife player (id 0) and run ordinary programs.
- **Wildlife activity is bounded:** creatures only update when their chunk is within 2 chunks of a player's presence ("active"). Chunks are populated the first time they become active, never on generation, so pathfinding or subscriptions far away create nothing.
- **Effects:** every bonus is an `Effect` (`{stat, pct}`, `{stat, add}` or `{unlock}`). `Modifiers` aggregates race passives, researched techs, talent ranks and discoveries per player, cached and invalidated on change; `value(stat, base) = (base + add) × max(0.2, 1 + pct)`.
- **Territory:** a completed building claims unowned tiles within its influence radius (+ territory-radius bonuses); the first claim wins. On load the map is rebuilt from completed buildings ordered by completion tick, then id, so it is identical across restarts.
- Indices: units and buildings by chunk and by owner; building footprint occupancy by numeric tile key. Nearby queries scan rings bounded by sensing radius; nothing scans the whole world.
- Passability: terrain passable, no resource node, no building. Units do not block one another.
- **Task lifecycle:** a task is set (validated), progresses each tick, and finishes with a `TaskResult {ok, value, reason}`. Failures set `unit.blocked`, log a line, append to the trace and (for script tasks) resume the VM with the failure value, calling `on_action_failed` first if defined. An action that cannot start becomes a task that fails on the next tick, so every action takes at least one tick.
- **Optional combat** (`World.cfg.combatEnabled`, from config `combat.enabled`): every attack goes through `attackBlocker` / `buildingAttackBlocker`, which require combat enabled, a unit that can fight, and for player-vs-player both players `pvpActive` (opted in, or still inside their opt-out delay). Wild creatures may only attack owners that provoked them in the last 30 s. Hits record `lastHit` on the target (`last_attacker()`), extend opt-out delays, and at 0 health `killUnit` / `destroyBuilding` remove the entity, notify both owners (`World.notices`, drained by the server into `tick.notices`), award experience, and re-derive territory from the remaining buildings. Players left with nothing are re-founded at the end of the tick. With combat disabled none of this code runs except the refusals.
- **Contested zones** (`World.zones`, active when combat and `combat.contestedZones` are on): `attackBlocker` allows any player unit to attack a unit standing in a zone, and `buildingAttackBlocker` any building touching one, before the opt-in checks. `gatherRate` adds 50% for nodes inside a zone. `findSpawn` rejects sites within 48 tiles of any zone (active or not). Chunk messages and the minimap overview carry the zones (only zones touching explored chunks for the overview).
- **Stealth:** `isHiddenFrom(unit, viewer)` is true for a stealthy unit (Scout capability, or Dark Elf in forest, not revealed by recent fighting) with no unit of the viewer within 5 tiles and no building within 5 (Watchtower 12). The broadcaster and chunk snapshots skip such units for that viewer, attack targeting refuses them, and the server's target check answers "not found". Stealth-capable units are re-checked once a second so detection follows everyone's movement.
- **Wildlife renewal:** once a second one active, populated chunk is checked (round robin); if it has fewer live creatures (by home chunk) than its generated list, one returns at its original spot on unclaimed land, at most every 5 minutes per chunk.
- **Storage** (`World.cfg.storageMode`, from config `economy.storage`). In `"shared"` mode `PlayerState.resources` is the stock and buildings' `stock` stays empty. In `"networks"` mode each storage building's `BuildingState.stock` is authoritative and `PlayerState.resources` is kept equal to their sum (for the top bar and `stock()`); every change goes through `changeStock`. `storageNetworks(owner)` groups completed storage buildings whose footprints are within `storageLinkRange` (24) tiles, transitively. All spending goes through `payAt(owner, rect, cost)` (construction, training, research: the network of the nearest storage within `supplyRange`, 48 tiles), `payAnywhere` (talent respec) and gains through `deliver` / `grantAt` (salvage, production, reclaiming, plunder), so the two modes differ only inside these functions. Capacity is a building stat (`storageCapacity`, Warehousing +50%); deposits stop at capacity. Destroying storage removes its contents (`plunderFraction` 25% to the attacker's nearest storage). `applyStorageMode()` runs after load and converts stock losslessly in either direction.
- **Limits:** `unitCap(owner)` and `buildingCap(owner)` are effect stats (`unitCap` base 60, `buildingCap` base 80; Administration, Bureaucracy, Grand Council add to them), clamped to the server ceilings `economy.unitLimitCeiling` / `buildingLimitCeiling`. Training, placement and taming check them; `PlayerView.limits` sends them to the owner.
- **Heroes** (`shared/defs/heroes.ts`): `PlayerState.hero` records the living hero unit id, whether it was ever recruited, battle training ranks and deaths. Recruiting/reviving is a building queue order (`kind: "hero"`), battle training another (`kind: "hero_training"`). Ranks and hero techs are effects (`heroHp`, `heroDamage`, `heroCooldown`, `heroAura`, `heroRevive`) folded into `World.mods()`. `unitMaxHp`, `unitDamage` and `unitArmor` add the level scaling and modifiers. Abilities are data (`AbilityDef.effect`) applied by `castAbility`, which validates everything (owner, hero, combat, cooldown, range, PvP via `attackBlocker`) before changing anything and starts the cooldown only on success. Timed effects are `Buff`s on units and buildings (transient; ended once a second); `unitPct(u, stat)` sums a unit's buffs and its owner's hero aura and is applied to gathering, movement, building, repair, regeneration, damage, armor and the script budget; `orderSpeed` applies building buffs to training and research. Farsight adds a temporary reveal area to `presenceChunks` and `detects`. Removing the hero unit (death) clears `hero.unitId`; the hero is outside the unit limit (`limitedUnits`).
- **Fault containment:** each unit and building update runs inside a guard. An unexpected exception (a bug) cancels that unit's task with a clear log line, increments `stats.internalErrors` and is reported through `World.onInternalError` to the server log; the tick and every other entity continue.
- Change tracking: two `ChangeSet`s. `net` is cleared after each broadcast; `persist` after each successful flush.

## Pathfinding

1. **Direct:** exact 8-way A* without corner cutting, limited to `simulation.pathRadius` (48) tiles.
2. **Long range:** `CoarseMap` treats the world as 8×8-tile cells (open when at least 5 of 16 sampled tiles are passable; cluttered cells cost more) and finds a corridor with A* over cells. The unit walks exact legs to the furthest corridor waypoint within reach, re-planning as it goes. Cells are sampled from the chunk cache when the chunk is loaded and directly from the generator otherwise, so planning never generates chunks.
3. **Near but blocked:** one wider exact search (2× radius, 40k expansions) finds local detours.
4. **Moving targets** (`observe`, `tame`, `follow`, training) re-plan only when the target has drifted by more than a quarter of the distance, and use long-range routing only when far away.

Cost controls: per-tick budgets (30 ms of all path planning, 15 ms and 4 searches of long-range planning; over budget, units wait one tick), failure backoff per unit and goal (5 s, or 20 s after a failed long search, with per-unit jitter so retries spread), failed corridors cached for 30 s, an early "enclosed goal" exit (a 400-cell reverse search from the goal), and a 6,000-cell budget per corridor search.

## Script interpreter

See [SCRIPTING.md](SCRIPTING.md) for the language. Execution model:

1. Source is parsed and compiled to bytecode. Unknown names, wrong arity, locked commands (with the unlock hint), assignment to built-ins and `return`/`break` misuse are compile errors with line/column. Unit programs compile with the owner's unlocks; library programs compile with all unlocks and are re-checked when assigned.
2. Each running unit owns a `VM`. The scheduler gives each VM at most `scriptOpsPerUnitTick` instructions per tick (scaled by the `scriptOps` modifier), and all VMs together at most `scriptOpsPerTick`; units beyond the global budget are deferred round-robin.
3. **Queries** are answered synchronously by `UnitScriptHost` with read-only snapshots (`ObjectRef`). Locked queries are also refused at run time.
4. **Actions** suspend the VM. The simulation turns the action into a task; when it finishes, the VM resumes with the result. **Events:** `on_action_failed` runs as part of resuming a failed action; `on_attacked` uses `VM.interrupt`, which abandons the pending action and runs the handler, after which the abandoned call returns `None`.
5. Budgets: 50,000 instructions without an action, call depth, stack, list/dict sizes, live items, string length, variable count, source size. Limit violations are uncatchable.
6. Errors stop the program (`state = error`, message + line/column), leave the unit idle and responsive, and never change world state. `try/except` catches only game (non-limit) errors.

Security boundary: the VM is a hand-written interpreter over a closed instruction set. There is no path from a script to JavaScript evaluation, Node APIs, the filesystem, network or database. Attribute access is whitelisted per value type; names are resolved against an explicit registry using own-property checks (prototype names such as `constructor` are rejected; covered by tests).

## World generation

- `WorldGenerator.terrainAt(x, y)` is a pure function of `(seed, chunkSize, resourceDensity, x, y)` using integer hashing and fBm value noise (identical across engines). Chunks are windows over that function; there are no seams and request order does not matter.
- Terrain: water, sand, grass, forest floor, hills, rock (impassable), fertile soil. Resource nodes: trees, stone, gold (clustered), berries (clustered).
- **Generation v2** adds features from an independent hash (`seed|features`): ruins (about one chunk in three, 15% ancient) and creature spawn lists by biome. Terrain and nodes keep the v1 hash, so v1 and v2 are identical apart from the features; this is what makes the v1 -> v2 upgrade safe.
- A world stores its generation version; the server only loads versions it supports (1 and 2) and refuses a config that differs from the world, with upgrade instructions for v1 -> v2.
- Only modifications are persisted (`chunk_mods`: remaining amount per changed node, plus the regrowth stamp for bushes). Evicted chunks regenerate and re-apply them. Looted ruins and populated chunks are stored separately.

## Network protocol

JSON text frames over WebSocket at `/ws`. Types in `src/shared/protocol.ts`. Every client message passes `parseClientMessage()` (type, range and size checks) before the server acts.

Client -> server:

| Message | Purpose |
| --- | --- |
| `hello {v, name, token?, race?}` | Create an account (no token) or log in with a token |
| `subscribe {chunks}` | Replace the set of observed chunks (max 64; only chunks within vision are granted) |
| `unit_cmd {reqId, unitId, cmd}` | Manual order: move / gather / build / deposit / stop / investigate / observe / tame / attack / attack_building / repair (stops the unit's program). Unit or building targets outside the player's vision get the same answer as missing ones. |
| `units_control {reqId, unitIds, action}` | Run / pause / resume / stop many units' programs |
| `place_building {reqId, type, x, y}` | Place a construction site (cost charged once) |
| `train {reqId, buildingId, unitType}` / `research {reqId, buildingId, techId}` | Queue training or research (cost charged once) |
| `talent_allocate {reqId, talentId}` / `talent_reset {reqId}` | Talents |
| `stats_get {reqId}` | Territory statistics, leaderboard, expansion history |
| `overview_get {reqId, cx, cy, radius}` | Minimap data for explored chunks around a chunk (radius <= 12) |
| `inspect_species {reqId, type}` | A species' behaviour program (only if this player observed it) |
| `combat_optin {reqId, enabled}` | Opt in to PvP (immediate) or out (after the configured delay) |
| `program_save / program_control / program_get / program_restore` | Unit programs and their versions |
| `lib_list / lib_get / lib_save / lib_delete / lib_copy / lib_assign / lib_export / lib_import` | Code library |
| `ping {reqId}` | Latency check |

Server -> client: `welcome` (includes `world.combatEnabled`), `chunk` (terrain digits, nodes, territory runs, ruins), `chunk_denied`, `tick` (incremental unit/building upserts and removals, node, territory and ruin changes, player view, owner names with PvP status, level-up notice, notices such as "your unit was killed"), `ack`, `error {reqId?, code, message}`, `program`, `species`, `stats`, `overview`, `library`, `library_program`, `library_export`, `pong`, `kicked`.

Requests carrying a `reqId` are idempotent per player: a repeated `reqId` returns the cached response without re-executing (prevents duplicate purchases on retries).

### Interest management

A player may subscribe to chunks within `network.visionChunkRadius` (Chebyshev, in chunks) of any chunk containing one of their units or buildings, plus each completed building's extra `vision` (Watchtower: +2). Every second, subscriptions outside vision are revoked. Each tick a session receives only: own entities that changed, other entities that changed inside its subscribed chunks, removals for entities that left its interest, and node/territory/ruin changes in subscribed chunks. Unchanged entities are never resent (revision numbers). Unit logs and traces are sent only when they change.

Other players' units expose only id, owner, type, position, facing, activity, a `carrying` flag and health as a percentage; inventories, programs, logs, traces, tasks, trained abilities and queues are owner-only (`src/server/views.ts`). The minimap overview covers only chunks the player has explored and lists only the player's own units and buildings.

## Persistence

- `GameStore` interface (`server/persistence/store.ts`); `SqliteStore` uses Node's built-in `node:sqlite` with WAL mode and parameterised statements.
- Migrations: 1 initial schema, 2 code library, 3 territory/research/exploration, 4 progression, 5 wildlife and discovery (adds the wildlife account/player with id 0), 6 optional combat (players' PvP choice and opt-out deadline), 7 storage networks (each building's `stock`, JSON), 8 heroes (each player's `hero` record, JSON), 9 coding lessons (completed lesson ids, JSON), 10 lairs, trophies and paddocks (`players.trophies`, `units.pen_id`, `buildings.pen`, and a `lairs` table holding only the state of woken lairs).
- Dead units and destroyed buildings are deleted in the same flush transaction as everything else.
- Durable: accounts, players (race, resources, spawn, techs, XP, talents, discoveries, observed species, hero record), units (position, inventory, program, library link, learned abilities, home), buildings (progress, completion tick, queue, stock), chunk modifications, explored chunks, territory events, populated chunks, looted ruins, program versions, library programs and versions, audit log, world meta.
- Reconstructed on load: territory (from buildings), a hero record pointing at a missing unit is cleared (the hero can then be revived); transient: ability cooldowns and buffs, Farsight reveals, VM state (programs restart from the top), paths, tasks, logs, traces, client revisions.
- The server flushes dirty state every `persistence.flushIntervalMs` in **one transaction**. A failed flush is logged, reported on `/health`, and retried with the dirty sets intact. Shutdown (SIGINT/SIGTERM) performs a final flush.

## Frontend

- React renders the HUD (top bar, sidebar, editor, library, stats, talents, minimap, notifications). Components subscribe to `GameState.uiVersion`, which changes when the player record, selection, selected entity, notifications or connection status change, not on every unit movement.
- `@pixi/react`'s `<Application>` hosts the canvas; `WorldRenderer` draws imperatively with PixiJS containers, graphics and sprites, reading `GameState` each frame.
- **Isometric view** (`render/iso.ts`): a 2:1 dimetric projection (tile diamond 64×32 px). Flat layers live in a ground container whose affine matrix maps ground space (16 px per tile) to the screen: painted terrain, territory (a faint wash with a dashed border), contested zones, hover/placement/selection marks, aura and ability ranges. Upright objects (trees, rocks, bushes, ruins, buildings, units) are sprites in one depth-sorted layer (depth = x + y of their footprint's front). Units hidden behind a building get a silhouette in the owner's colour drawn on top. Picking tests unit and building sprites (front-most wins) before falling back to the ground tile, so clicking a tall building or a tree canopy selects it.
- **Painted terrain** (`render/terrainPainter.ts`): 8 px per tile per chunk texture; each terrain has painted detail from table-based value noise, and neighbouring terrains blend over a jittered edge (foam where water meets land). Painting runs in Web Workers (`render/groundJobs.ts`, `groundWorker.ts`): the renderer sends self-contained jobs (terrain and node kinds of the tiles plus a one-tile border), nearest chunk first, jobs for one chunk always go to the same worker so they arrive in order, and finished pixels are drawn a few per frame. If workers cannot start, the same code paints on the main thread. Node changes repaint one tile; neighbours' borders are repainted when a chunk arrives.
- **Culling and caching**: trees and rocks get sprites for the view plus a 10-tile margin and are rebuilt only when the view leaves that region (sprites are pooled); units off screen get no sprite and no animation; health bars, tool textures, tints and depth are only touched when they change; territory redraws are limited to three chunks per frame; the client forgets chunks (and their textures) beyond 120, farthest first, and the server resends them when they are needed again.
- **F3 performance overlay** (`render/perf.ts`, `ui/PerfOverlay.tsx`): frame rate, smoothed and worst time per renderer stage and for the PixiJS render, slow frames and main-thread long tasks in the last 5 s, and what is being drawn.
- **Art** (`render/art.ts`): all textures are drawn in code with Canvas2D (gradients, outlines, highlights) at 3× resolution and cached: six tree variants, rocks and gold, bushes, ruins, ten building types in four construction stages with per-race palettes, people per unit type and race (skin, ears, tusks, beards, headgear, armour, robes, capes), three creatures, tools and weapons. Owner colours are never baked in: capes, tabards, shield faces and flags are white layers tinted per owner. No external image assets are used.
- Units are containers animated from the server-reported `activity` (tool swings, walking bob, spyglass, basket, attack swings and bow draws), mirrored to face left or right; heroes are larger with a gold ring and a health bar. Positions are smoothed toward authoritative tiles for display only.
- **Code editor** (`ui/CodeArea.tsx`): CodeMirror 6 with extensions fed by `src/script/assist.ts`, a pure module (no DOM, unit-tested) that derives completions, parameter hints, hover text, explained diagnostics, quick fixes and beginner warnings from the command registry (`commands.ts`), the compiler and the game definitions, so the editor and the server never disagree about what is valid. `ui/assistContext.ts` supplies the unit type, unlocks, combat setting, hero abilities and buildable types. The running line comes from the unit's action trace (no extra protocol).
- **Lessons** (`shared/defs/lessons.ts`): the simulation reports lesson events (`print`, a script action finishing, the `on_action_failed` handler running) through `World.lessonEvent`, which checks them against the program's text features (cached per unit) and completes lessons, awarding experience. Only programs the player saved count (version > 0 and not the unit's default program). Completed lesson ids are on `PlayerState.lessons` (migration 9) and in `PlayerView.lessons`.
- **Animated water** (`render/waterFilter.ts`): the painter stores how much of each pixel is water in its alpha (255 dry, 254 a trace at the shore down to 241 open water; ordered one way so texture filtering between neighbours stays meaningful). One PixiJS filter on the terrain layer replaces those pixels with drawn water in the painted terrain's palette: slowly drifting patches of deep and shallow water, a moving cell pattern whose borders form caustic lines in the light wave colour (brighter blobs where three cells meet, edges bent by two layers of slow waves), a finer broken web, the terrain's fine grain, and a foam line that laps along the shore where the painted ground takes over. The pattern is computed from world coordinates (the renderer passes the camera origin and zoom each frame), so it stays on the map while panning, and fades to a flat colour when zoomed so far out that it would shimmer. The shaders are compiled and linked once with WebGL before the filter is attached; if that fails (the compiler's message is logged as a console warning) or the renderer is WebGPU, the painted water shows instead (up to about 5% translucent because of the alpha marking).
- **Fonts:** the game title, headers and sub-headers use New Rocker (SIL Open Font License), bundled from the `@fontsource/new-rocker` package so no font server is contacted at runtime; the code editor keeps the interface font (`.code-editor` resets it).
- The minimap draws the server overview into an offscreen canvas and overlays units, buildings and the viewport (a diamond, since the view is isometric) four times a second.

- **Lairs and paddocks**: lairs (from chunk and tick messages) are drawn as ground circles with a landmark sprite; monsters use the person or beast art by type. A paddock is two sprites, the back half sorted behind its animals and the front fences in front, so penned animals (ordinary units on the paddock's tiles) appear inside it.

## Security boundaries

| Boundary | Enforcement |
| --- | --- |
| Network input | Strict schema validation, size limit (`maxMessageBytes`), token-bucket rate limit, disconnect on sustained abuse |
| Identity | Random 192-bit token per account, stored only as SHA-256 hash; one live session per player |
| Ownership | Every command checks owner against the session's player id |
| Information | Server-side view filtering; chunk access limited to vision; behaviour code only for observed species; overview only for explored chunks |
| Scripts | Closed interpreter; budgets; no host access; actions validated by the simulation |
| Database | Parameterised statements; CHECK constraints on non-negative resources; audit log |
| Origins | `server.allowedOrigins` for WebSocket upgrades (default `*` for development) |

## Performance notes (measured)

Measured on the development machine's Linux VM (Node 24) on 2026-10-10, replaying a copy of a real 2-player world (107 player units, 117 creatures at load, 125 buildings) for 6,000 ticks (10 minutes of game time):

| | Before the fixes of 2026-10-10 | After |
| --- | --- | --- |
| Average tick | 3.7 ms | 3.3 ms |
| 99th percentile | 40 ms | 17 ms |
| Worst tick after load | 794 ms (340 chunks generated by one route search) | 55 ms |
| Creatures after 10 min | 365 (spawned in far chunks) | ~150-200 (near players only) |

Server ticks are now broken down by phase in `/admin/status` (`tickPhasesMs`: world upkeep, active chunks, scripts, units, buildings, network, persistence; mean, 99th percentile and worst over the last 300 ticks). In the container with 456 units (200 extra player units plus wildlife), the whole tick averaged 3.7 ms with a 99th percentile of 16 ms (2026-10-14).

Client frame times (headless Chromium, software WebGL, 200 extra units, 2026-10-14), worst single frame per renderer stage over 5 s: before the performance pass, ground painting 73-93 ms and tree/rock rebuilding while panning 19 ms; after it, at most about 13 ms for any stage. Software WebGL caps that environment at about 10 fps whatever the renderer does, so frame rate on real GPUs still has to be checked (F3).

The first tick after loading takes 200-250 ms (initial chunk generation and every program starting at once). A single-player world with 47 units averages about 1 ms per tick. These are baselines, not scalability claims. `/admin/status` reports tick time, script ops, deferred units, path searches, cached/generated chunks, network counters and flush latency.
