# Implementation status

Last updated: 2026-10-10 (Phases 4-7, minimap, crash fix and performance work on a live world, optional combat, contested zones, stealth, wildlife renewal, optional storage networks, research-raised unit and building limits, heroes, isometric renderer and new art; 2026-10-14: coding help and lessons, performance pass, PvE lairs, paddocks, new units and creatures; 2026-10-16: removing units and buildings, animated caustic water, request-replay fix, top bar layout, README screenshots).

Statuses are restricted to: **Not started**, **In progress**, **Implemented, unverified**, **Implemented and tested**, **Blocked**.

"Tested" means automated tests in `tests/` were run and passed: **157/157 on 2026-10-16** (`npm test`), with `npm run typecheck` and `npm run lint` clean. Where a row also says "browser", the feature was exercised in headless Chromium with real PixiJS against a real server (scripts and screenshots are described in docs/TESTING.md). The smoke bot (`npm run smoke`) passed on 2026-10-10 with shared storage and with storage networks.

## World and generation

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Seeded deterministic chunk generation (terrain, biomes, rivers, resource clusters) | Implemented and tested | `src/shared/worldgen.ts`, `src/shared/rng.ts` | worldgen | | |
| Generation v2: ruins and creature spawns added on top of v1 terrain (v1 terrain and nodes bit-identical) | Implemented and tested | `worldgen.ts` (`generateFeatures`) | discovery ("generation v2 keeps v1 terrain…") | | |
| Explicit v1 -> v2 world upgrade with automatic backup (`npm run world:upgrade -- --confirm`) | Implemented and tested | `src/server/tools/upgradeWorld.ts`, `bootstrap.ts` | persistence ("a v1 world with a v2 config is refused…"); the tool itself was run on a copy of a real v1 world (backup created, re-run is a no-op) | | |
| Generation v3: new wildlife species (sheep, goats, horses, aurochs, bears) appended after v2 spawns, and PvE lairs placed from the seed (v2 content bit-identical); explicit v2 -> v3 upgrade with backup | Implemented and tested | `worldgen.ts`, `src/shared/lairs.ts`, `tools/upgradeWorld.ts`, `bootstrap.ts` | pve ("generation v3 keeps v2 content identical…"), persistence ("a v2 world with a v3 config…"); the tool was run on a v2 database | Existing v2 worlds get v3 content only after the upgrade; new species appear only in chunks not yet populated | |
| Chunk cache with LRU eviction; mods re-applied on regeneration | Implemented and tested | `src/sim/chunks.ts` | worldgen, persistence | All chunk mods are held in memory | Lazy-load mods per chunk if profiling shows need |
| Coordinate validation and abuse limits | Implemented and tested | `src/shared/protocol.ts`, `src/sim/world.ts` | multiplayer ("malformed and abusive") | | |
| Config: world settings fixed per world, mismatch refused, explicit reset | Implemented and tested | `src/server/bootstrap.ts`, `tools/resetWorld.ts` | persistence, config | | |
| HTTP `/health` and admin status endpoint (`/admin/status`: tick times, path searches, wildlife, internal errors, persistence) | Implemented and tested | `src/server/transport.ts`, `gameServer.ts#status` | integration ("HTTP endpoints…") | Bearer token only | |

## Multiplayer and networking

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Authoritative server tick loop | Implemented and tested | `src/server/gameServer.ts` | integration, multiplayer | Single process | |
| Contained internal errors: a bug in one unit's or building's update cancels that task, logs the error and keeps the world running | Implemented and tested | `World.step`, `containUnitError` | sim ("an internal error in one unit's update is contained") | A buggy unit retries its next task normally | |
| WebSocket transport (`ws`) | Implemented and tested | `src/server/transport.ts` | integration, smoke bot | | |
| Validated typed messages | Implemented and tested | `src/shared/protocol.ts` | multiplayer | | |
| Accounts (name + random token), reconnection, single session per player | Implemented and tested | `gameServer.ts` | multiplayer, persistence | Development-grade auth | Real auth before public hosting |
| Interest management (vision radius, chunk subscriptions, revocation; Watchtowers extend vision by 2 chunks) | Implemented and tested | `gameServer.ts` (`allowedChunks`) | multiplayer ("hidden information", "a completed Watchtower…") | Chunk-granular vision | |
| Private data filtering (inventory, programs, logs, queues, trained abilities) | Implemented and tested | `src/server/views.ts` | multiplayer | | |
| Rate limiting, message size limits, idempotent reqIds | Implemented and tested | `gameServer.ts`, `transport.ts` | multiplayer | reqId cache is in memory | |

## Units, tasks, pathfinding

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Three starting units; trainable Worker, Scout, Hauler | Implemented and tested | `src/shared/defs/units.ts` | sim, economy | | |
| Movement: exact A* within 48 tiles, hierarchical corridor routing (8x8 cells) beyond | Implemented and tested | `src/sim/pathfinding.ts`, `src/sim/coarse.ts`, `world.ts` | sim, discovery ("beyond the short path radius"); profiled on a real 2-player world | Rare dense-forest pockets can defeat corridor routing; units do not block each other | |
| Pathfinding cost bounds: per-tick time budgets (30 ms total, 15 ms long-range), failure backoff with jitter, cached failed corridors, enclosed-goal early exit, long-range planning without chunk generation | Implemented and tested | `world.ts` (`planPath`), `coarse.ts`, `chunks.ts` (`approxPassable`) | sim (regression and "does not generate chunks"); real-world replay: max tick 794 -> 55 ms | Approximate corridor ignores harvested trees outside cached chunks | |
| Tasks: idle, move, explore, wander, gather, deposit, withdraw, build, wait, observe, investigate, tame, train creature, follow, guard, attack, repair, flee | Implemented and tested | `world.ts` | sim, economy, discovery, combat | | |
| Gathering, capacity, depletion; berry regrowth (lazy, persisted) | Implemented and tested | `world.ts`, `chunks.ts` | sim, economy | Trees do not regrow | |
| Shared player stock with deposit and withdraw (default) | Implemented and tested | `world.ts` | sim, economy, storage | | |
| Storage networks (`economy.storage: "networks"`): per-building stock with capacities (Warehousing +50%), networks of storage within 24 tiles, costs paid from storage within 48 tiles of the work, overflow to the next storage, Farms deliver to nearby storage or pause, destroyed storage loses its contents and the attacker plunders 25%, `withdraw(r, n, storage)`, `deposit(storage)`, `storage_contents()`, `storage_mode()`, building panel "Stored here", lossless conversion on start in both directions, migration 7 | Implemented and tested | `world.ts` (storage section), `bootstrap.ts`, `views.ts`, `SelectionPanel.tsx` | storage (6 tests, incl. the SCRIPTING.md hauling example); config; smoke bot in both modes; real-world replay converted losslessly; browser (panel, top bar, build menu) | Not play-tested: capacities and ranges are first guesses. Training and research draw on the producing building's network only. Networks are not drawn on the map | Play-test |
| Construction (placement validation, cost once, builders) | Implemented and tested | `world.ts` | sim, multiplayer, economy | | |
| Buildings: Town Hall, Outpost, Stockpile, Farm, Lumber Camp, Mine, Lodge, Library, Watchtower, Barracks | Implemented and tested | `src/shared/defs/buildings.ts` | economy, sim, discovery, combat | | |

## Scripting and automation

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Lexer/parser with documented grammar and diagnostics | Implemented and tested | `src/script/lexer.ts`, `parser.ts` | script | One diagnostic at a time | Multi-error recovery |
| Bytecode compiler + resumable VM | Implemented and tested | `compiler.ts`, `vm.ts` | script, sim | | |
| Dictionaries, `try/except` (game errors only), `on_action_failed` event handler | Implemented and tested | `parser.ts`, `compiler.ts`, `vm.ts` | script | No `finally`/`raise`; one event handler | More handlers (`on_idle`) |
| Command registry (actions, queries, built-ins) incl. place, train_unit, withdraw, find_build_spot, count_units, time, stock_all, creature commands | Implemented and tested | `src/script/commands.ts`, `src/sim/scriptHost.ts` | script, sim, economy, discovery | | |
| Locked commands (e.g. `scan()` until discovered), checked at compile time and at run time | Implemented and tested | `commands.ts`, `compiler.ts`, `scriptHost.ts` | discovery | | |
| Budgets: per-tick, per-unit, runaway guard, recursion, memory, size | Implemented and tested | `vm.ts`, `world.ts` | script, sim | | |
| Run/pause/resume/stop, errors with line/col, unit never frozen; batch control for many units | Implemented and tested | `world.ts`, `gameServer.ts` | sim, library | VM state not persisted (restart from top) | |
| Automation trace (recent actions and results per unit); cancelled actions are closed in the trace | Implemented and tested | `world.ts`, `views.ts`, `SelectionPanel.tsx` | discovery (manual orders), browser | | |
| Program versions & restore (per unit) | Implemented and tested | `sqliteStore.ts`, `gameServer.ts` | persistence, browser | | |
| Code library: named programs, versions, sharing, copy, group assignment, export/import format | Implemented and tested | `src/server/library.ts`, `LibraryPanel.tsx` | library, browser | 100 programs per player | |

## Economy, territory, progression

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Territory: first-claim tile ownership from building influence, expansion buildings, rebuilt deterministically on load | Implemented and tested | `src/sim/territory.ts`, `world.ts` | economy | No contesting or loss of territory | |
| Territory statistics, leaderboard, expansion history | Implemented and tested | `gameServer.ts`, `StatsPanel.tsx` | economy, browser | | |
| Research (Library) with 12 technologies | Implemented and tested | `src/shared/defs/techs.ts`, `world.ts` | economy | | |
| Unit and building limits (base 60/80) raised by Administration, Bureaucracy, Grand Council (up to +120/+180), clamped by `economy.unitLimitCeiling`/`buildingLimitCeiling`; current/limit in the top bar and Stats | Implemented and tested | `techs.ts`, `world.ts` (`unitCap`, `buildingCap`), `TopBar.tsx` | storage; browser (research in the Library panel, limits 60/80 → 90/120) | | |
| Effect/modifier system (race, techs, talents, discoveries) | Implemented and tested | `src/shared/defs/effects.ts`, `src/sim/modifiers.ts` | economy, progression, discovery | | |
| Racial passives (7 races) | Implemented and tested | `src/shared/defs/races.ts` | progression | | |
| Experience, levels 1-60, 30 talent points, anti-farming (no XP for nothing gained) | Implemented and tested | `src/shared/defs/progression.ts`, `world.ts` | progression, discovery | Existing players start at level 1 (no retroactive XP) | |
| Talent trees (16 general + 2 per race), respec for gold | Implemented and tested | `src/shared/defs/talents.ts` | progression, browser | | |

## Discovery and creatures (Phase 7)

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Wildlife (deer, wild boar, wolf) as neutral units running inspectable programs; dormant away from players; spawned only near players, a few chunks per tick | Implemented and tested | `world.ts` (`processSpawns`, `isAwake`), `units.ts` | discovery, sim; browser | | |
| Wildlife renewal: depleted chunks near players get one creature back every 5 minutes, on unclaimed land, up to their original number | Implemented and tested | `world.ts` (`renewWildlife`) | discovery ("hunted or tamed wildlife slowly returns…") | No breeding or migration | |
| Ruins: salvage once per world, inscriptions grant discoveries | Implemented and tested | `world.ts` (`updateInvestigate`), `discoveries.ts` | discovery; browser | | |
| Inspection tiers: visible stats, observed behaviour code (server-gated), taming/training, hidden discoveries | Implemented and tested | `gameServer.ts` (`inspect_species`), `world.ts` | discovery; browser | | |
| Taming and training (wolf guard), guard zones that keep wild foragers away | Implemented and tested | `world.ts` | discovery | Only one trainable ability so far | More abilities |
| Manual orders: right-click a ruin to investigate, a creature to observe or tame; targets outside vision are indistinguishable from missing ones | Implemented and tested | `actions.ts`, `world.ts`, `gameServer.ts` | discovery, multiplayer; browser | | |
| Discoveries and known species UI | Implemented and tested | `StatsPanel.tsx`, `SpeciesBehaviour.tsx` | browser | | |

## Optional combat

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Server switch `combat.enabled` (off by default); with it off nobody can attack anything, military units and ⚔ hero abilities are unavailable and the UI hides PvP (the Barracks remains for hero training) | Implemented and tested | `src/server/config.ts`, `world.ts` | combat ("combat is off unless…"), config; browser (no PvP button or Barracks) | Changing it needs a restart | |
| Per-player PvP opt-in; both sides must be opted in; opting out takes effect after a delay that fighting extends; persisted | Implemented and tested | `world.ts` (`setPvp`, `pvpActive`, `attackBlocker`) | combat ("PvP needs both…", "opting out…", network test); browser | | |
| Attacking units and buildings (melee and ranged), unit death, building destruction releasing territory | Implemented and tested | `world.ts` (`updateAttack`, `killUnit`, `destroyBuilding`, `recomputeTerritory`) | combat; browser (attack, kill, notices) | No line of sight; no armour; units do not block each other | |
| Hunting wildlife (anyone, with combat enabled; meat as food); animals fight back only against their attacker; wild behaviour programs use the combat commands | Implemented and tested | `world.ts`, `units.ts` (wild programs) | combat ("PvP needs both… hunting", "wild animals fight back…") | | |
| Contested zones: small circles (radius 14-36) from the seed, none within 256 tiles of the centre, PvP for everyone inside, buildings touching them attackable, +50% gathering inside, never a new settlement within 48 tiles; shown on the map, minimap, hover, panels and placement ghost; `in_contested_zone()` | Implemented and tested | `src/shared/zones.ts`, `world.ts`, `Minimap.tsx`, `worldRenderer.ts` | zones (5 tests, incl. checks that fail when spawn avoidance is removed); browser (zone drawing, hover, panel, minimap) | A zone may include water; existing settlements are never moved | |
| Stealth: Scouts (always) and Dark Elf units (in forest) are hidden from other players unless one of their units is within 5 tiles or a Watchtower within 12; fighting reveals for 10 s; hidden units are never sent to other clients or scripts and cannot be targeted | Implemented and tested | `world.ts` (`isStealthy`, `isHiddenFrom`), `gameServer.ts` (broadcast filter) | stealth (3 tests, incl. a check that fails without the server filter); browser (own hidden unit drawn faded, panel note) | Detection is all-or-nothing per player | |
| Racial passives that needed combat: Troll regeneration (×3), Undead reclaim 30% of a defeated unit's cost (boosted by their salvage bonus), Dark Elf forest stealth | Implemented and tested | `races.ts`, `world.ts` | stealth ("Dark Elves hide…; Trolls…; Undead…") | | |
| Soldier and Archer units, Barracks | Implemented and tested | `units.ts`, `buildings.ts` | combat (disabled world refuses them) | Balance is untested by play | Play-test |
| Repair (builders, half the building's cost for a full repair, paid as work is done); unit health regeneration out of combat | Implemented and tested | `world.ts` (`updateRepair`, `regenerate`) | combat ("…repaired for resources", "damaged units heal…") | | |
| Re-founding a player who loses every unit and building (progress kept) | Implemented and tested | `world.ts` (`checkEliminations`) | combat ("…re-founded…") | | |
| Script commands `attack`, `repair`, `flee`, `last_attacker`, `can_attack`, `in_contested_zone`, `find_nearest("enemy" / "enemy_building")`, `me.hp`, `me.max_hp`; default soldier/archer programs defend themselves | Implemented and tested | `commands.ts`, `scriptHost.ts`, `world.ts` | combat ("scripts: …"), zones | | |
| `on_attacked(attacker)` event handler: interrupts the current action (which then returns None), at most every 2 s, not while already attacking | Implemented and tested | `vm.ts` (`interrupt`), `world.ts` (`deliverAttackEvent`) | combat ("on_attacked(attacker) interrupts…") | | |
| Combat UI: PvP toggle with countdown, health bars, hit flash, attack animations, right-click attack/repair, Ctrl+right-click to hunt, notices, Barracks/Soldier/Archer art | Implemented and tested | `TopBar.tsx`, `actions.ts`, `worldRenderer.ts` | browser (2 players, real PixiJS) | | |
| Fair information: other players see a unit's health percentage and PvP status, never inventories or code; attack targets outside vision look like missing ones | Implemented and tested | `views.ts`, `gameServer.ts` | combat (network test) | | |

## Heroes

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| One hero per player and race (7 heroes with distinct stats, strengths and weaknesses), recruited free at a Town Hall, outside the unit limit, +2% health/damage per level | Implemented and tested | `src/shared/defs/heroes.ts`, `units.ts`, `world.ts` (heroes section) | heroes | Balance not play-tested | Play-test |
| 21 abilities (3 per hero) from data, with cooldowns; support abilities work without combat, ⚔ abilities need combat and obey PvP rules; buffs, debuffs, shields, heals, teleport, reveal, construction, conversion, taming; passive auras | Implemented and tested | `heroes.ts`, `world.ts` (`castAbility`, `applyAbility`, `unitPct`) | heroes (each race's support abilities, combat abilities with armor/shield/curse/lifesteal, refusals keep cooldowns) | Ability effects and cooldowns are transient (reset on restart) | |
| Barracks battle training (3 tracks × 5 ranks), Library hero research (4 techs), revival at Town Hall or Barracks keeping training (Undead half cost) | Implemented and tested | `world.ts` (`trainHero`, `recruitHero`), `techs.ts` | heroes | | |
| Script commands `use_ability`, `ability_ready`, `hero()`; default hero programs per race | Implemented and tested | `commands.ts`, `scriptHost.ts`, `units.ts` | heroes (incl. the SCRIPTING.md example run verbatim) | | |
| Persistence (migration 8), protocol (`hero_recruit`, `hero_train`, `ability`), views (abilities, damage, armor, buffs; player hero record) | Implemented and tested | `migrations.ts`, `protocol.ts`, `views.ts`, `gameServer.ts` | heroes (network, validation, hidden targets, restart, invalid record cleared) | | |

## Coding help

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Code editor on CodeMirror 6: Code Farmer colouring, auto-indent after ':', bracket closing, Ctrl+S / Ctrl+Enter, problem underlines | Implemented and tested | `ui/CodeArea.tsx` | browser | | |
| Autocomplete aware of the unit: commands (fuzzy matching, common ones first), your variables and functions, keywords, snippets, `me.`/`inventory.`/object members; argument words (find_nearest kinds, buildings, units, resources, your hero's abilities); notes on what will not work here (locked, combat off, wrong unit, hero only) | Implemented and tested | `src/script/assist.ts` (`complete`), `ui/assistContext.ts` | assist; browser | Single-line context (calls split over lines get no argument help) | |
| Parameter hints and hover documentation (commands, keywords, members, your variables and functions, argument words) | Implemented and tested | `assist.ts` (`signatureAt`, `hoverAt`) | assist; browser | | |
| Friendlier errors: "did you mean" in the compiler itself (server messages too), plain-language explanations, one-click fixes (missing colon, indentation, semicolons, misspelt names, unclosed strings) | Implemented and tested | `compiler.ts` (`closestName`), `assist.ts` (`diagnose`) | assist (each fix produces code that compiles) | | |
| Beginner warnings with fixes: query result used without a None check, a forever-loop that never acts, unknown argument words ("tre" -> "tree"); every built-in default program and recipe is warning-free | Implemented and tested | `assist.ts` (`warnings`) | assist | Heuristic (line-based), may miss checks written unusually | |
| Recipes (12 tested building blocks, hero recipe per race), insert at the cursor; Reference tab inserts at the cursor (it used to replace the program) | Implemented and tested | `src/script/recipes.ts`, `ui/RecipesTab.tsx`, `CommandReference.tsx` | assist (all compile without warnings for every race; two run in the simulation) | | |
| Live running line and "what is my unit doing" (line, call, task, last problem, why it is not running) | Implemented and tested | `ui/UnitActivity.tsx`, `CodeArea.tsx` | browser | Shows the action in progress (queries between actions are not tracked) | |
| Guided coding lessons (12), completed by the server from what saved programs actually do, experience rewards, hints, "Try it in the editor"; persisted (migration 9) | Implemented and tested | `src/shared/defs/lessons.ts`, `world.ts` (`lessonEvent`), `ui/LessonsPanel.tsx` | lessons (each lesson's example completes it; default programs and off-target programs do not; persistence); browser | Saving a recipe that uses several ideas completes those lessons at once | |

## PvE, creatures and paddocks

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| PvE separate from PvP (`combat.pve`, default on): units fight monsters, monsters attack intruders with a leash; PvP and hunting still need combat | Implemented and tested | `world.ts` (`attackBlocker`, `updateAttack`), `config.ts` | pve, combat, heroes | | |
| Five lair kinds with packs and bosses, waking near players, loot and XP per kill, boss trophies (permanent bonuses, once per kind) and discoveries, clearing with a 60-minute claim (Outposts anywhere in the lair), respawn unless claimed; lair state persisted (migration 10) | Implemented and tested | `src/shared/defs/lairs.ts`, `world.ts` (PvE lairs section), `views.ts#lairView` | pve; browser (goblin camp cleared by knights) | Only one lair kind was cleared in the browser; boss fights are not balanced by playtesting yet | Balance after play |
| Ten monsters (goblin, skeleton, ogre, spider, drake and their bosses) with public behaviour code | Implemented and tested | `units.ts` (`MONSTER_DEFS`) | pve | | |
| Five new wildlife species (v3 worlds) | Implemented and tested | `units.ts`, `worldgen.ts` | pve, paddock | | |
| Paddock: animals walk in or are sent, live inside the fence as units, production, settlement bonuses, breeding (paid in food), release, capacity 8, escape when destroyed; persisted | Implemented and tested | `world.ts` (paddocks section), `ui/SelectionPanel.tsx` (`PaddockBlock`) | paddock; browser (panel, release) | Breeding over real time only checked by tests | |
| New units: Miner (Mine), Ranger (Lodge; cheaper, faster taming), Knight (Barracks), Cleric (Library; heals nearby) | Implemented and tested | `units.ts`, `buildings.ts`, `world.ts#healAuras` | paddock ("new units…"); browser (rendered, knights and cleric fought) | | |
| Script commands `pen()`, `go_home()`, `distance_to_home()`; find kinds `monster`, `boss`, `paddock`, new species | Implemented and tested | `commands.ts`, `scriptHost.ts`, `world.ts` | pve, paddock, assist (default programs warning-free) | | |

## Removing units and buildings

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Dismiss own units (single or multi-select, all-or-nothing, heroes refused, tamed creatures let out and returned to the wild with their wild program), audited | Implemented and tested | `world.ts#dismissUnits`, `protocol.ts` (`unit_dismiss`), `ui/SelectionPanel.tsx`, `ui/ConfirmButton.tsx` | removal; browser (two-click Dismiss removed a unit) | No undo | |
| Demolish own buildings: construction sites refund half their cost, completed buildings refund nothing and release their territory, stock and penned animals; removing everything re-founds the settlement; audited | Implemented and tested | `world.ts#demolishBuilding`, `protocol.ts` (`building_demolish`) | removal | Demolish button only checked in the browser for units, not buildings | |

## Fixes on 2026-10-16

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Request replay protection is per connection: it used to be per player, so after a page reload (request ids restart at 1) the first actions of the new page could be answered with the old page's replies and never carried out (found when hero recruitment silently did nothing) | Implemented and tested | `gameServer.ts` (`Session.reqCache`) | multiplayer ("a new connection's requests are carried out…", fails on the old code); browser (hero recruited after reloads) | | |
| Top bar stays on one line on desktop widths (1240-1920 px measured); it wrapped at every width below 1920 once the talent badge showed | Implemented and tested | `styles.css` | browser (bar height measured at 1024-1920 px) | Wraps into two rows below about 1240 px | |

## Persistence

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| GameStore interface + SQLite (node:sqlite), 10 versioned migrations | Implemented and tested | `src/server/persistence/` | persistence; migrations applied to a copy of a real world | | |
| Transactional batched flush, retry on failure | Implemented and tested | `gameServer.ts#flush` | persistence | Up to `flushIntervalMs` lost in a hard crash | |
| Audit log of economic and discovery events | Implemented and tested | `world.ts`, `sqliteStore.ts` | DB inspection | No query UI | Admin tooling |
| Backup/restore procedure | Implemented, unverified | docs/OPERATIONS.md | | | |

## Client

| Feature | Status | Location | Tests | Known limitations | Next action |
| --- | --- | --- | --- | --- | --- |
| Login (name, race with passives, server), saved token per profile | Implemented and tested | `App.tsx`, `ui/LoginScreen.tsx` | browser | | |
| Isometric PixiJS renderer in a painted fantasy-RTS style: blended painted terrain, upright trees/rocks/bushes/ruins, ten building types with construction stages and per-race palettes, people drawn per unit type and race, creatures, team-colour layers and flags, activity animations, silhouettes behind buildings, depth-sorted picking | Implemented and tested | `src/client/render/` (`iso.ts`, `terrainPainter.ts`, `art.ts`, `worldRenderer.ts`) | iso (projection maths); browser (real PixiJS in headless Chromium: screenshots for four races, zoomed in and out, building and unit picking, placement) | ~11 fps in headless Chromium with software WebGL (SwiftShader). On real hardware the user reports it runs smoothly in Chrome (2026-10-16; no figures recorded). No elevation; one animation pose per unit with procedural motion | |
| Hero UI: recruit/revive at Town Hall or Barracks, battle training list, hero panel (strengths, armor, aura, training, active effects, ability buttons with cooldowns, aimed abilities with a range marker), top-bar hero button, Y to select | Implemented and tested | `ui/HeroPanel.tsx`, `SelectionPanel.tsx`, `worldRenderer.ts` | browser (recruit, panel, Divine Shield, Holy Light refusal, cooldown display, aimed Shadowstep) | | |
| Selection (single, shift-click, screen-space box), panels, build menu, research, notifications, hover info | Implemented and tested | `src/client/ui/` | browser | | |
| Code editor (diagnostics, reference with every command category and locked commands, library, history, log, trace) | Implemented and tested | `ui/CodeEditor.tsx`, `CodeArea.tsx`, `CommandReference.tsx` | browser | Simple highlighter | |
| Stats, talents, discoveries panels | Implemented and tested | `StatsPanel.tsx`, `TalentsPanel.tsx` | browser | | |
| Minimap / regional overview (explored chunks only, territory, own units and buildings, viewport, click to pan, 3 zoom levels) | Implemented and tested | `ui/Minimap.tsx`, `World.overview` | multiplayer (server side); browser | Refreshes every 5 s | |
| Client typecheck / lint / Vite build | Implemented and tested | `tsconfig.json`, `eslint.config.js` | `npm run typecheck`, `npm run lint`, `vite build` | | |
| Electron desktop wrapper | Not started | | | Optional | |
| Performance pass: ground painting in Web Workers, tree/rock sprites built for a margin and pooled, off-screen units skipped, change-only updates, spread territory redraws, client chunk eviction (120), resolution capped at 2x | Implemented and tested | `render/groundJobs.ts`, `groundWorker.ts`, `worldRenderer.ts`, `gameState.ts#retainChunks` | all tests; browser (frame stage timings before/after, see TESTING.md) | Automated checks use software WebGL; on real hardware the user reports smooth play in Chrome (no figures recorded) | |
| F3 performance overlay (fps, per-stage and render times with worst frame, slow frames, long tasks, object counts) and server per-phase tick timings in `/admin/status` | Implemented and tested | `render/perf.ts`, `ui/PerfOverlay.tsx`, `src/sim/phaseTimes.ts` | browser; admin status read during a 456-unit run | | |
| Pixel-accurate picking (buildings by their drawn art or footprint; trees by their canopy) | Implemented and tested | `worldRenderer.ts#pick`, `art.ts#alphaAt` | browser (click grid over a Town Hall) | Units still use a box | |
| Lair, monster, paddock and new creature/unit art; lair overlay; paddock drawn in two layers around its animals | Implemented and tested | `art.ts`, `worldRenderer.ts` | browser (gallery, goblin camp, paddock) | | |
| Animated water: one WebGL filter pass draws the whole water surface (the painter passes each pixel's water amount in its alpha): in the painted terrain's palette: drifting deep/shallow patches, moving caustic lines in the wave colour with brighter junctions, a softer web, fine grain, a lapping foam line at the shore, in tile space so it moves with the map, fading to flat colour when zoomed far out; falls back to the painted water if the shader does not compile | Implemented and tested | `render/waterFilter.ts`, `terrainPainter.ts`, `worldRenderer.ts` | browser (only water pixels change between frames; water and land shift equally while panning; no shader errors) | Automated checks use software WebGL; the user reports it works well in Chrome on real hardware. The WebGPU renderer keeps still water | |
