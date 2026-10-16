# Design decisions

## D1. Server-authoritative from the first milestone (2026-10-09)

Phase 1 in the project specification describes a "playable local simulation" and Phase 2 adds the server. Building a client-side simulation first and moving it to the server later would mean writing the simulation twice. Instead, the simulation is a transport-free module (`src/sim`) that has always run inside the Node server. The first milestone therefore delivers the Phase 1 loop *and* the core of Phases 2-3 (server, WebSocket, sessions, persistence). This changes the order of work, not the requirements.

## D2. WebSocket library: `ws` (2026-10-09)

`ws` is the de-facto Node WebSocket server: mature, small, no native dependencies, supports `maxPayload` and permessage-deflate. The browser uses the native `WebSocket`; the smoke bot uses Node 22's built-in `WebSocket` client. The transport is isolated in `src/server/transport.ts` behind the `Connection` interface, so tests drive `GameServer` without sockets.

## D3. SQLite driver: Node's built-in `node:sqlite` (2026-10-09)

Chosen over `better-sqlite3` because it needs no native compilation (a frequent installation failure on Windows) and has a synchronous API suited to batched flushes. Cost: Node >= 22.13 is required, and Node prints an "experimental" warning. If the API changes, only `SqliteStore` is affected; switching to `better-sqlite3` is a one-file change because both are synchronous with near-identical semantics.

**Scale limits / migration path:** one server process, one writer. WAL mode and a 2 s batched flush keep writes small. When the target exceeds what one process can simulate, or when operational needs (replication, point-in-time recovery) appear, implement `GameStore` for PostgreSQL. The interface already batches writes per flush and keeps SQL out of the simulation.

## D4. Persist modifications, regenerate terrain (2026-10-09)

Only changed resource nodes are stored (`chunk_mods`). Everything else is regenerated from the seed. The world meta stores seed, generation version, chunk size and density; a mismatch with config stops the server with an explanation. `npm run world:reset -- --confirm` archives (never deletes) the database.

## D5. Bytecode VM rather than a tree-walking interpreter (2026-10-09)

Unit programs must pause in the middle of loops and function calls whenever an action is issued, and resume later. A stack VM with explicit frames makes suspension trivial and makes instruction counting exact. The compiler also performs static checks (unknown names, arity, misuse of `return`/`break`, assignment to built-ins) that give early diagnostics.

## D6. Actions take at least one tick (2026-10-09)

An action that cannot start (bad target, nothing to deposit) becomes a task that fails on the next tick instead of returning instantly. This prevents tight failure loops from burning budget while game time stands still, and gives each unit a natural maximum of one action per tick.

## D7. Global player stock (2026-10-09; 2026-10-10: still the default, see D23)

Deposited resources join a per-player stock usable anywhere, as in classic RTS games. `withdraw()` (Phase 5) moves resources from the stock into a unit at one of your storage buildings, which is what taming and training need. Per-building inventories are still deferred: they add hauling gameplay but also many failure modes, and nothing yet requires them.

## D8. Interim build-range rule instead of territory (2026-10-09; superseded 2026-10-10 by D16)

Until territory ownership exists (Phase 5), placements must be within 16 tiles of an owned completed building. This prevents players from claiming arbitrary distant land and will be replaced by (not layered beside) the territory model.

## D9. Development authentication (2026-10-09)

Accounts are a unique name plus a random token held by the browser (SHA-256 hash stored server-side). This is enough for development and multi-client testing. Real authentication (passwords/OAuth, recovery, session expiry) is required before public hosting.

## D10. Units do not block each other (2026-10-09)

Simplifies pathfinding and avoids deadlocks around busy storage buildings. Revisit with combat.

## D11. Renderer stays imperative under `@pixi/react` (2026-10-09)

`@pixi/react` provides the `<Application>` and React integration; world objects are managed imperatively in `WorldRenderer` so unit movement never triggers React reconciliation. Terrain is baked into one texture per chunk.

## D12. Verification constraints in the first session (2026-10-09; resolved 2026-10-10)

The build environment had no access to the npm registry, so `pixi.js`, `@pixi/react`, `vite`, `@types/react` and ESLint could not be installed. The server, simulation, scripting and persistence were fully tested with locally available packages (`ws`, `typescript`, `tsx`). The client was bundled with esbuild and run in Chromium with a Canvas2D stand-in implementing the subset of the PixiJS scene-graph API the renderer uses. Real PixiJS rendering, Vite, ESLint and the client typecheck remain to be verified (IMPLEMENTATION_STATUS: Blocked / Implemented, unverified).

Resolved: since 2026-10-10 the project is built and tested on the development machine with the real dependencies. `npm run typecheck`, `npm run lint` and `vite build` pass, and the client has been exercised with real PixiJS in headless Chromium (docs/TESTING.md).

## D13. Hierarchical pathfinding with hard cost bounds (2026-10-10)

Exact A* is limited to 48 tiles, so units far from home could never return. A coarse corridor over 8×8-tile cells, walked in exact legs, solves that cheaply. A long-range search must never be able to stall the server, so it is bounded in four ways: it reads terrain from the generator instead of generating chunks; a small reverse search rejects enclosed goals (lakes, islands) early; corridor searches have a 6,000-cell budget and failures are cached; and all path planning shares a per-tick time budget, beyond which units simply wait a tick. Measured on a real world, the worst tick after load dropped from 794 ms to 55 ms. Trade-off: the corridor ignores harvested trees outside loaded chunks, and rare dense-forest pockets can still defeat it (the unit reports "No route found").

## D14. Wildlife is a player (id 0) running ordinary programs (2026-10-10)

Creatures are units owned by a reserved wildlife player. They reuse movement, tasks, the VM, budgets, persistence and network views, and their behaviour is literally inspectable code (project specification §10). To bound cost on an infinite map, creatures only act within 2 chunks of a player's presence, and a chunk gets its creatures the first time it becomes active (never on mere generation, which pathfinding and subscriptions also cause). Populated chunks are persisted, so creatures never respawn.

## D15. Generation v2 adds features on an independent hash (2026-10-10)

Ruins and creature spawns come from `hash(seed|features)` while terrain and nodes keep the v1 hash. v1 and v2 worlds are therefore identical tile for tile, which makes an in-place upgrade safe (no player loses a building to a new lake). The upgrade is still an explicit admin action with a backup (`npm run world:upgrade -- --confirm`), as the specification requires; the server never upgrades silently.

## D16. Territory: first claim wins, recomputed on load (2026-10-10)

A completed building claims unowned tiles within its radius; claims never take land from another player. Only claim events are logged; the ownership map is rebuilt on start from completed buildings in completion order, so persisted state cannot drift from the rules. Expansion buildings (Outpost, Town Hall, Watchtower) may be placed up to 24 tiles beyond your territory; everything else must be inside it. This replaces the interim 16-tile build-range rule (D8).

## D17. Locked commands are checked at compile time and at run time (2026-10-10)

Discoveries can grant commands (e.g. `scan()`). A locked command is a compile error with the unlock hint, so players learn what to do immediately. Library programs compile with every command so they can be shared freely, and are checked again with the owner's unlocks when assigned. The script host refuses locked queries at run time as well, so a stale compiled program cannot bypass the lock.

## D18. Contain internal errors per entity (2026-10-10)

On 2026-10-10 a pathfinding bug (an empty corridor indexed when unit and goal shared a cell) threw inside the tick loop and stopped the server. The bug is fixed and has a regression test. Separately, every unit and building update now runs inside a guard: an unexpected exception cancels that unit's task, tells its owner, logs the full error at ERROR and is counted in `/admin/status`. The rest of the tick continues. Hiding bugs is not the goal (they are logged loudly); keeping a shared world running for everyone is.

## D19. Experience only for gains; no retroactive experience (2026-10-10)

Experience is awarded only when something is gained (resources, buildings, new chunks, new territory, a new discovery or species, salvage), so repeating an action that yields nothing (re-reading a looted ruin) gives nothing. Existing players start at level 1 after the upgrade: reconstructing past experience from the audit log would be guesswork.

## D20. Combat is optional twice over (2026-10-10)

The user asked for combat to be "entirely optional". It is off by default for the whole world (`combat.enabled`), and when an operator turns it on, each player still decides for themselves: units and buildings can only be attacked when **both** players have opted in to PvP. Consequences of that choice:

- Opting out cannot be used to escape a fight: it takes effect after a delay (default 2 minutes) that every hit restarts.
- Hunting animals needs no opt-in, because it is initiated by the hunter. Animals never attack first; they only fight back against units of the player who attacked them (for 30 s). This keeps a peaceful player's units safe from wildlife too.
- Military units and the Barracks exist only on combat servers, and the UI hides them elsewhere, so peaceful worlds look and play exactly as before. (Since D25 the Barracks exists everywhere for hero training; Soldiers and Archers still need combat.)
- Retaliation is written as ordinary script code (the wild programs and the Soldier's default program call `last_attacker()` and `attack()`), so it is inspectable like all other behaviour. A dedicated `on_attacked` event handler was not added: interrupting a running action safely needs a design of its own, and polling `last_attacker()` covers the need.
- A player who loses everything is re-founded instead of eliminated, keeping experience, research, talents and discoveries. Experience for kills is tied to resources the victim paid (starting units and Town Halls give none), so friends cannot farm each other.

## D21. Contested zones from the seed, small and away from settlements (2026-10-10)

The user asked for areas where PvP is automatically on, "usually not too large", that players expand into at their own risk. Zones are computed from the world seed with their own hash (like ruins in D15), so they are deterministic and never alter terrain. They are only in force when combat is enabled (and `combat.contestedZones` is true), so peaceful servers are unaffected.

- Size and placement: at most one per 256×256-tile region, half the regions, radius 14-36 (mostly about 20), placed fully inside its region (so a tile belongs to at most one zone and lookups are O(1)).
- Fairness: no zones within 256 tiles of the world centre, where players start, and no new settlement within 48 tiles of a zone. Before enabling, existing worlds should be checked; the user's world had no building or unit inside any zone (checked on a copy, 2026-10-10).
- Incentive: +50% gathering inside zones. Without a reward nobody would contest them.
- Rules are positional: a unit is fair game while it stands in a zone; a building is fair game if any of its tiles is in a zone. Opt-in status does not matter there; wildlife behaviour does not change.

## D22. Stealth is enforced by the server (2026-10-10)

Hidden units are filtered out of what other players receive (not just drawn invisibly), so modified clients cannot reveal them, and the server's answers to attack orders do not distinguish a hidden unit from a missing one. Detection uses short fixed radii (5 tiles; 12 for Watchtowers) and fighting reveals a unit for 10 s, so stealth helps scouting and ambushes without making units untouchable. This also delivered the Dark Elf "Shadowcraft" passive the specification planned, and with combat in place the Troll regeneration and Undead "reuse the defeated" passives, so no race has planned-but-missing passives any more.

## D23. Per-building storage as optional "storage networks" (2026-10-10)

Per-building storage is a server option (`economy.storage: "networks"`), not a replacement for the shared stock (D7), which stays the default. Reasons: it changes the economy for every existing program (scripts written for a global stock would stall on "insufficient resources here"), it needs play-testing before it can be the norm, and operators of small servers may simply not want hauling.
- Storage buildings within 24 tiles of each other share their contents (a "network"), so a base with a few stockpiles behaves like one store and hauling is only needed between bases. Costs are paid from the network nearest the work (within 48 tiles), which keeps the rule explainable in one sentence and checkable before placement.
- All gains and payments go through a handful of functions (`payAt`, `payAnywhere`, `deliver`, `grantAt`, `changeStock`), so both modes share every caller and differ only inside those functions; the shared-mode test suite ran unchanged.
- `PlayerState.resources` is kept as the sum of building stock in networks mode, so the top bar, `stock()` and existing UI stay meaningful.
- Switching mode on an existing world is lossless and explicit (logged at startup): shared → networks puts the whole stock in the Town Hall even past its capacity rather than discarding anything; networks → shared adds everything back up.
- Destroyed storage loses its contents and the attacker plunders 25%: this is what makes storage worth defending in PvP and contested zones.
- The design (capacities, link and supply ranges, plunder, the Warehousing tech) was started by another editor working in this folder at the same time; it was taken over with the user's agreement, completed (deposit/withdraw/production/persistence/client/script commands) and tested.

## D24. Unit and building limits raised by research (2026-10-10)

The fixed 60-unit / 80-building limits were abuse prevention. They are now effect stats (`unitCap`, `buildingCap`) so the Library's Administration → Bureaucracy → Grand Council line can raise them (+30/+40, +40/+60, +50/+80; 180 units and 260 buildings with all three), the same way every other bonus works. Server-wide ceilings (`economy.unitLimitCeiling` 300, `buildingLimitCeiling` 400) keep the operator in control of the total load; the effective limit is the smaller of the two. Research rather than levels or talents because the user suggested the Library and because research has a clear resource cost that scales with the size it unlocks.

## D25. Heroes: one per race, useful on peaceful servers too (2026-10-10)

The user asked for a single hero per player with special abilities, improvable through Barracks battle training and Library research, different per race. Choices made with the user: heroes exist whether or not combat is on, revive at a Town Hall (or Barracks) keeping their upgrades, and abilities are used from buttons and from scripts.
- Each hero has two support abilities that work on every server and one ⚔ ability that hurts others and therefore needs combat and the PvP rules. The Barracks no longer requires combat (it hosts battle training); only Soldiers and Archers do.
- The first recruitment is free and the hero is outside the unit limit: players start with 50 food, and the user's own world had a player at the 60-unit limit who could otherwise never get a hero. The specification's "exactly three starting units" still holds: the hero is recruited, not granted.
- Abilities are data (`AbilityDef.effect` kinds) applied by one validating function, so a refused ability changes nothing and keeps its cooldown, and new abilities need no new plumbing. Timed effects are transient buffs (lost on restart, like VM state).
- Hero growth reuses the effect system (training ranks and hero techs are effects), plus +2% per player level so heroes keep pace with progression.
- Names and abilities are original (Paladin, Warchief, Thane, Loremaster, Shadowblade, Necromancer, Shaman are generic fantasy archetypes); nothing is copied from existing games.

## D26. Isometric renderer with procedural painted art (2026-10-10)

The user asked for an art style similar to classic fantasy RTS games and chose an angled view. The renderer uses a 2:1 isometric projection: flat layers stay in tile-aligned ground space under an affine matrix (so territory, zones and placement code barely changed), while everything with height is an upright, depth-sorted sprite. All art is drawn in code with Canvas2D (no image assets): it keeps the repository self-contained, lets owner colours be tinted layers, and gives each race its own look (skin, features, building palettes) without an art pipeline. Trade-offs: no elevation, procedural rather than frame-by-frame animation, and a heavier GPU fill load (thousands of overlapping tree sprites); headless software rendering ran at about 11 fps, and real-GPU performance remains to be measured.

## D28. Performance pass driven by measurement (2026-10-14)

The user reported stutter on a high-end machine. A frame profiler (`src/client/render/perf.ts`, shown with F3) measured each renderer stage in headless Chromium with 200 units. Before the changes, painting a chunk's ground texture took 70-93 ms in a single frame and rebuilding the tree/rock sprites while panning up to 19 ms; those were the stutters. Changes: ground painting moved to a pool of Web Workers (results applied a few per frame; the main-thread painter remains as a fallback if workers cannot start), trees and rocks are built for a margin around the view and only rebuilt when the view leaves it (sprites are pooled), off-screen units are not animated (no sprite until first seen), per-unit health bars, textures and depth are only updated when they change, territory redraws are spread over frames, the client forgets chunks far from the view (memory and textures were unbounded on long journeys), and canvas resolution is capped at 2x. Afterwards the worst renderer stage was about 13 ms in the same test. The server reports per-phase tick times in `/admin/status` (`tickPhasesMs`: mean, p99, max over 300 ticks). Headless Chromium uses software WebGL, so GPU cost on real hardware has not been measured; the F3 overlay is there to check it.

## D29. PvE is separate from PvP combat; lairs from the seed in generation v3 (2026-10-14)

The user asked for PvE enemies and bosses that stay in their own area and chose "PvE always on" even on servers with combat off. A new setting `combat.pve` (default true) lets units fight monsters and monsters fight intruders; PvP and hunting still need `combat.enabled`. This changes earlier behaviour on combat-off servers: Soldiers, Archers (and the new Knights) become trainable, hero combat abilities can be used (they can only hit monsters), and units, including heroes, can now be hurt and killed inside lairs. Setting `combat.pve` to false restores the old "nothing can be fought" behaviour. Lair positions are a pure function of the seed (own hash, like contested zones) and only appear in generation v3, which also adds new wildlife species after the v2 spawns; v3 keeps every v2 tile, node, ruin and creature identical (tested), so existing worlds can be upgraded explicitly with `npm run world:upgrade -- --confirm` and are never changed silently. Only lair state (woken, cleared, by whom, respawn and claim times) is stored (migration 10). Monsters are neutral units with a `monster` definition, so they reuse movement, scripts, combat and persistence; their behaviour code is public. Rewards follow the user's choices: loot and experience per kill, a trophy (permanent bonus, once per boss kind) and a discovery per boss, and a claim window in which only the clearer may build in the lair (an Outpost there claims it; claimed lairs never respawn).

## D30. Paddocks keep animals as units (2026-10-14)

Penned animals stay ordinary units with a `pen` field (persisted), standing on the paddock's tiles, rather than being converted into a count on the building. That keeps them visible in the paddock, keeps their identity (release gives back the same animal), and reuses unit persistence and views. While penned they skip the unit update loop entirely, run no program, cannot be attacked or ordered, and do not count toward the unit limit; the paddock moves one of them to another spot inside the fence every few seconds. Benefits use the existing systems: production goes through the farm delivery path, bonuses are an extra source in the player's modifiers, and births are new units paid from the stock. The paddock is drawn as two sprites (back half behind its animals, front fences in front) so animals appear inside it.

## D31. Removing units and buildings; animated water (2026-10-16)

The user asked for a button to remove units and buildings. Removal reuses the existing death and destruction paths (`removeUnit`, `removeBuilding`), so territory, stock, paddock animals and re-founding behave exactly as when something is killed or destroyed. To avoid making removal an economic exploit or a loss of the hero system, construction sites refund half their cost (a cancelled order should not be free, nor a total loss), completed buildings refund nothing, heroes cannot be dismissed (they already have death and revival rules), and tamed creatures are released to the wild rather than deleted. Requests are all-or-nothing so a multi-selection containing someone else's unit changes nothing. The client asks for a second click within 4 s instead of a modal dialog.

The water animation is a single fragment shader on the terrain layer instead of animated sprites or repainting chunk textures, because the terrain is already one texture per chunk: the painter's alpha channel carries each pixel's water amount, so one pass finds the water and the shoreline with no extra texture or mask. A first version only tinted the painted water; the user found that it looked like a mix of the static image and shader lines and asked for the whole surface to look like a cartoon pool-caustics reference, so the shader now draws the water and shoreline itself (first brighter and flatter than the painted terrain, as in the reference; then, at the user's request, recoloured with the painted terrain's own water palette and grain so it matches the art style). The shader is test-compiled first so a GPU that rejects it shows the painted water rather than no terrain.

## D27. Coding help built on the command registry; lessons judged by the server (2026-10-14)

The user asked for autocomplete and other help that makes unit programming accessible to beginners. The editor moved from a plain text area to CodeMirror 6 (about 150 KB more client code) because it provides completion popups, tooltips, problem underlines and quick-fix plumbing that would be fragile to build by hand. All the language knowledge lives in one pure module (`src/script/assist.ts`) derived from the command registry, the compiler and the game definitions, so suggestions cannot drift from what the server accepts, and it is tested without a browser. "Did you mean" lives in the compiler itself, so server messages benefit too. Warnings are deliberately few (missing None check, a loop that never acts, unknown argument words) and every built-in default program and recipe is tested warning-free, so beginners do not learn to ignore them. Lessons are completed by the server from what a saved program actually does (events plus program features), never by clicking, and a unit's default program never counts; saving a recipe can complete several lessons at once, which was accepted because recipes are themselves teaching material.

