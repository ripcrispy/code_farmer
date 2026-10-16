# Testing

## Automated tests

```bash
npm test
```

Runs every `tests/*.test.ts` with Node's built-in test runner (via `tsx`). Last run: **157 passed, 0 failed** (2026-10-16, after removal, animated water and the request-replay fix). `npm run typecheck` and `npm run lint` were clean on the same code.

| File | Tests | Covers |
| --- | --- | --- |
| `worldgen.test.ts` | 8 | Same seed -> identical chunks; different seeds differ; order independence; negative coordinates and chunk boundaries; regional coherence; modifications survive eviction; exploring only generates touched chunks; invalid parameters |
| `script.test.ts` | 16 | Default programs compile; syntax evaluates correctly; actions suspend/resume; diagnostics with line/column; compile-time rejection of unknown commands, arity, redefinition; budgets; infinite loops; recursion and memory limits; runtime error lines; no host access (incl. prototype names); size limits; dictionaries; try/except; limits are uncatchable; `on_action_failed`; new-syntax diagnostics |
| `sim.test.ts` | 22 | Starting units; spawn separation; gathering, capacity, deposit, exhausted nodes; construction rules; movement and unreachable targets; permissions; training; custom scripts; pause/resume/stop; recovery from invalid actions; budget fairness; place/train_unit/find_build_spot; regression for the same-cell route crash (2026-10-10); contained internal errors; long-range planning without chunk generation and enclosed goals; wildlife only near players |
| `economy.test.ts` | 8 | Starting territory; placement inside territory and expansion buildings; first-claim contested land; research prerequisites, cost and effects; Lumber Camp aura; berry regrowth; withdraw; territory over the network and identical after restart |
| `progression.test.ts` | 6 | XP curve; reaching level 60 with exactly 30 points; XP from real gameplay; talent rules (points, level, prerequisites, race, ranks); racial passives change the simulation; level-up notice, idempotent allocation, persistence |
| `library.test.ts` | 4 | Versioned library programs and group assignment; sharing and copy permissions; export/import round trip and malformed imports; persistence and batch program control |
| `discovery.test.ts` | 9 | v2 keeps v1 terrain identical; wildlife spawns once, near players, sleeps elsewhere; ruins (salvage once, inscriptions unlock `scan()`, no XP farming); manual investigate/observe/tame orders; observe -> tame -> train -> guard chain; hidden discovery; behaviour code only for observers, persisted; long-range observation; wildlife renewal |
| `persistence.test.ts` | 7 | Migrations idempotent; full restart round trip; seed change refused; meta not overwritten; failed flush retried; v1 world with v2 config and v2 world with v3 config refused with upgrade instructions |
| `multiplayer.test.ts` | 11 | Shared state; unauthorised commands; hidden information; duplicate reqIds (and a new connection reusing old reqIds is still served); malformed/abusive messages; name/race/token rules; reconnection; minimap overview limited to explored chunks; creature orders outside vision look like missing targets; Watchtower vision |
| `config.test.ts` | 5 | Defaults; shipped config valid (combat and storage networks ship off); merge and env overrides; economy settings reach the simulation; clear errors (including combat and economy settings) |
| `storage.test.ts` | 6 | Unit and building limits raised by Administration research, capped by the server ceiling, prerequisites enforced; shared storage unchanged by default; storage networks: starting stock in the Town Hall, separate networks, capacity, overflow to the next storage, an explicit deposit at a full building fails and keeps the cargo, local payment, hauling with `withdraw(..., storage)` and `deposit(storage)`, `storage_contents()`/`storage_mode()`, "no storage within 48 tiles"; Farm delivery and blocked production; destroyed storage loses its contents and the attacker plunders a quarter; lossless conversion shared ↔ networks on a saved world with stock persisted across restarts; the SCRIPTING.md hauling example run verbatim |
| `pve.test.ts` | 4 | Generation v3 keeps v2 terrain, nodes, ruins and wildlife identical and adds new species; lairs deterministic, order-independent, seed-dependent, absent before v3, never near the centre, on land; no spawn near a lair; PvE with combat off (units fight monsters, monsters attack only intruders, leash, PvP and hunting still refused, Knights trainable; nothing with PvE off); kills pay loot and XP, the boss gives trophy and discovery (damage bonus applies), clearing reserves the lair (other player refused, clearer may place an Outpost far from their land), unclaimed lairs respawn, claimed ones stay clear, no duplicate trophies; over the network: lair in chunk and tick messages, public monster behaviour, `find_nearest("monster")`, lair state and trophies across a restart |
| `removal.test.ts` | 3 | Dismissing: someone else's unit in the list refuses the whole request, heroes refused, a penned sheep is let out and returns to the wild running its wild program; demolishing: a construction site refunds half its cost, a completed Outpost refunds nothing and releases its territory, other players' buildings refused, removing every unit and building re-founds the settlement; over the network (`unit_dismiss`, empty list rejected, `building_demolish` refund message) |
| `paddock.test.ts` | 4 | A tamed sheep walks into the paddock by itself; penned animals outside the unit limit, no orders, no programs; food and gold production; a horse's movement bonus applied and removed on release; ownership and species checks; breeding (lamb born after the breeding time, food paid), capacity, a lost paddock frees its animals; Miner, Ranger (half taming cost, faster observation), Cleric healing and every new unit trainable at its building; over the network (pen order, paddock view, release, bad release) and across a restart |
| `combat.test.ts` | 11 | Combat off unless enabled (attacks, PvP, military training and hunting refused); PvP needs both players opted in, hunting does not; fights end in death with notices and audit; animals fight back only against their attacker; opt-out delay extended by fighting; building destruction releases territory, repair costs resources and stops when they run out; re-founding keeps progress; `last_attacker()`, `me.hp`, `flee()`, the soldier's default program defends itself; healing; over the network: opt-in, public health only, owner PvP flags, notices, targets outside vision, persistence of deaths and PvP state; `on_attacked` interrupts the current action |
| `zones.test.ts` | 5 | Zones deterministic per seed, small, none near the centre, independent of terrain; automatic PvP inside (units and buildings), normal rules outside; +50% gathering; off without combat or with `contestedZones: false`; no new settlement near a zone (with the centre crowded so spawns land among zones); zones reach clients only when active; `in_contested_zone()` |
| `stealth.test.ts` | 3 | Scouts hidden unless a unit is within 5 tiles or a Watchtower within 12; hidden targets cannot be attacked or found; fighting reveals for 10 s; hidden units never reach other clients and appear/disappear with detection; attack orders on hidden units look like missing ones; Dark Elf forest stealth, Troll regeneration, Undead reclaiming |
| `heroes.test.ts` | 9 | Every race has a distinct hero with three abilities and a compiling default program; recruiting (free, Town Hall only, one at a time, outside the unit limit even for a player at the limit), level scaling; support abilities without combat (Rally, Muster, Master Mason and the Stonework aura, Dark Ritual and its refusal, Wild Call, Farsight revealing a hidden scout and expiring, Inspiration, Shadowstep, Veil of Night); combat abilities obey PvP opt-in, range, armor and auras, Divine Shield, Hex, Drain Life; refused abilities keep their cooldown; death, revival at a Barracks keeping training, Undead and Rites of Return discounts; battle training ranks and limits; scripts (`use_ability`, `ability_ready`, `hero()`, the default program using abilities); network messages, validation, hidden targets, restart persistence, an invalid hero record cleared on load; the SCRIPTING.md hero example run verbatim |
| `assist.test.ts` | 9 | Completions (fuzzy matching, cursor placement inside quotes, nothing in comments), argument words for each command, members, variables, functions, snippets, notes for locked/combat/hero/wrong-unit commands; parameter hints and hover; the compiler's "did you mean" (including swapped letters); each kind of error comes with a fix that produces compiling code; None-check, spinning-loop and unknown-word warnings and their fixes; every default program and every recipe (hero recipe for every race) free of warnings; two recipes run in the simulation (wood gathered, a Stockpile placed and finished) |
| `lessons.test.ts` | 3 | Each lesson's own example completes it when run (experience once, notice); default programs and programs that miss the point do not; progress over the network and across a restart |
| `iso.test.ts` | 1 | Isometric projection: screen and tile coordinates are inverses, the ground matrix matches, depth order |
| `integration.test.ts` | 3 | Full player loop; two real WebSocket clients; HTTP `/health` and `/admin/status` authentication |

## Headless smoke test against a running server

```bash
npm run server          # terminal 1
npm run smoke           # terminal 2 (optional: npm run smoke -- ws://host:3001/ws name)
```

`tools/bot.ts` plays the core loop over a real WebSocket and exits non-zero on failure. Last result (2026-10-10, generation v2 world): **PASS in 40 s** with `economy.storage` set to `"shared"` and again with `"networks"`, and PASS in 43 s again after the hero and renderer changes, including a server-side syntax-error rejection, overlapping placement rejection, worker training and token reconnection.

## Performance replay

Not part of `npm test`. On 2026-10-10 a copy of a real 2-player world was loaded through `openWorld` and stepped for 6,000 ticks, recording per-tick time and path statistics. Results are in docs/ARCHITECTURE.md (Performance notes). The replay found the 794 ms stall and the periodic 40 ms ticks that are now fixed and covered by sim tests.

Repeated after the storage changes (same world, 149 buildings, 290 units, 6,000 ticks): shared mode averaged 4.86 ms per tick (p99 17 ms), storage networks 4.75 ms (p99 21 ms), no internal errors in either. Converting the world to networks mode on load kept every resource (179,180 before and after), and the existing programs kept gathering (stock grew by about 20,000 in each mode).

## Browser verification (real PixiJS)

The production bundle (`vite build`) was served statically, run against a real server with a fresh database, and driven by Playwright in headless Chromium (SwiftShader WebGL). The scripts are not part of the repository (they depend on the test machine). Observed with screenshots and no page errors:

- 2026-10-09/10, Phases 4-6: shift-drag selection of several units, creating a library program, assigning it to the selection, export, the Trace tab; the territory overlay, a rejected placement outside territory, the Stats panel; a level-up toast, learning a talent, racial talents locked for other races.
- 2026-10-10, Phase 7: ruins drawn on the map (ancient ones distinct), hover info, selecting the Scout and right-clicking a ruin (activity "investigating", the salvage log line, a "Discovery: …" toast, the ruin shown as salvaged); deer drawn as animals; right-clicking a deer to observe it; the "You learned how the deer behaves" toast; the creature panel and "View behaviour code" showing the deer's program; the Discoveries list in Stats; the minimap (explored area, territory, viewport box) and click-to-pan; a cancelled action shown in the trace.

### Combat (2026-10-10)

Two browser pages (Alice and Bob) against a server with `combat.enabled: true`: the ⚔ PvP button and the Barracks appear; both players opt in; the world was rearranged offline (Bob's woodcutter beside Alice's base, a Soldier and Barracks for Alice, Alice's Town Hall damaged) and both pages reconnected. Alice selected her Soldier (the panel shows its combat stats and no cargo), hovered Bob's woodcutter ("Bob, PvP", health %), right-clicked it: "Attacking Bob's woodcutter", the attack animation and health bar, then "Your soldier defeated Bob's woodcutter" for Alice and "Your woodcutter #… was killed by Alice's soldier" for Bob. Bob opting out showed "PvP ending 120s". The damaged Town Hall's health bar and the Barracks art were visible. With combat disabled, neither the PvP button nor the Barracks appear. The Reference tab lists the Creatures and Combat commands. The top bar fits on one row at 1400 px.

### Contested zones and stealth (2026-10-10)

With combat enabled, a player's Scout was moved into the nearest zone (380, 69, radius 28): the map shows the red tint and dashed edge (zoomed out), the hover reads "Contested zone: PvP for everyone, +50% gathering", the panel warns that any player can attack the unit there and that it is hidden (stealth), the own hidden Scout is drawn faded, and the minimap shows the zone as a red ring. No page errors.

### Coding help and lessons (2026-10-14)

A new player opened the Woodcutter's editor (CodeMirror): the default program's executing line was highlighted and the strip read "▶ Line 10: harvest(<tree at 58,41>) — Gathering wood". Typing `node = fin` showed `find_nearest` first with its signature and description; Enter inserted `find_nearest("")` and opened the list of kinds (tree, stone, gold, berries…, with ⚠ on combat-only kinds) and the parameter hint. The resulting program `node = find_nearest("tree")` / `harvest(node)` showed the None-check warning with its explanation; its Fix button produced `if node is not None:` with the harvest indented, and the warning disappeared. Hovering `harvest` showed its documentation. "Use as program" on a recipe followed by Save & run worked. The Lessons panel listed 12 lessons; "Try it in the editor" opened the editor with the example (unsaved), and Save & run completed "Say hello" (notice, top-bar count). The first run showed lessons being completed by the default programs; that was fixed (only saved player code counts) and the run repeated. No page errors.

### Performance pass, building picking, lairs and paddocks (2026-10-14)

- **Performance** (`e2e-perf`): a new settlement plus 200 extra units, with the F3 overlay read at default zoom, zoomed out and while panning for 5 s. Worst single frame per renderer stage before: ground 93 ms (default view) and 73 ms (panning), trees/rocks 19 ms (panning). After: ground 8 ms, trees/rocks 2-12 ms, units up to 13 ms, at most about 13 ms for any stage (headless Chromium, software WebGL, which caps the frame rate at about 10 fps regardless; "long tasks" there are the software rasteriser). Not measured on a real GPU.
- **Building picking**: clicks on a 16×13 grid over a Town Hall with trees and units around it select the hall exactly where it is drawn, from the tip of its tower to its bottom corner (pixel-accurate alpha test of the sprite plus its ground footprint).
- **Generation v3 world** (`config/server.v3.json`, fresh database): a goblin camp drawn with its rim, landmark, four goblins and the horned chief; hover readout "☠ Goblin Camp (tier 1): occupied by monsters"; the chief's panel (boss, damage, reward, behaviour code). Six Knights and a Cleric placed 11 tiles from the camp with their default programs cleared it on their own: notices "Your knight slew the Goblin Chief! Loot: 200 wood, 80 gold", "Trophy: Goblin Totem…", "Discovery: Goblin War Drums…", "You cleared the Goblin Camp…", level-ups; the camp then drawn as cleared.
- **Paddock**: a paddock with two sheep, a horse and a goat drawn with its animals inside the fence (back fence behind them, front fence in front); its panel listed "Animals (4/8)", each species with its output, bonus and breeding, "Produces 2 gold, 11 food per minute", and Release buttons; releasing one changed it to 3/8.
- **Art gallery**: every monster, the five new animals and the four new units rendered side by side. No page errors in any run.
- Not verified in the browser: ordering an attack on a moving monster with a right-click (the scripted attempt kept missing the moving target; the attack order itself is covered by tests and worked through the knights' programs), and breeding over real time (covered by tests).
- `npm run world:upgrade -- --confirm` was run on a v2 database: it printed the v3 explanation, made a `.pre-v3.bak` backup, and the server then started with a v3 config.

### README screenshots, request replay fix, top bar (2026-10-16)

- Screenshots in `docs/screenshots/` were taken in headless Chromium (software WebGL, 1600×900) against a real server with generation v3. Scenes were prepared with the game's own code (a settlement built with `findBuildSpot` and `addBuilding`, a paddock with animals entered through the normal pen path) or, for the lair fight, by placing knights and a cleric near a goblin camp with their programs stopped and starting them from the UI with "Run all"; everything shown then happened in the simulation.
- While taking them, "Recruit Paladin" did nothing after page reloads. Traced over the WebSocket: the server answered the `hero_recruit` request with a minimap reply from the previous page, because the request-replay cache was kept per player while browsers restart request ids at 1. Fixed (per connection) with a regression test; recruitment then worked in the browser.
- Top bar measured at 1024, 1100, 1160, 1200, 1240, 1280, 1366, 1440, 1600 and 1920 px: one row from 1240 px up, a clean two-row wrap below, no overflow.

### Removing units and animated water (2026-10-16)

- **Dismiss** (`e2e-water`): a unit selected with Tab, "Dismiss" clicked: the button changed to "Click again to confirm"; the second click removed the unit and the panel showed "Nothing selected". Demolishing a building was not exercised in the browser (covered by tests).
- **Water, third version** (the user found the second too bright for the art style): recoloured with the painted terrain's water palette, lines in the wave colour, foam shoreline, terrain grain; checked at close and default zoom. A first attempt used `flat` as a variable name (reserved in GLSL ES 3.0): the shader failed the pre-check and the game correctly showed the painted water instead, silently; shader compile and link failures are now logged as console warnings.
- **Water, second version** (same scripts, after the user asked for the whole water surface to look like a reference GIF of cartoon pool caustics): the reference's colours were sampled in the browser pane (about 77% #4498E8 base, 10% lighter blue, 8% white). The pattern was prototyped offline in Python against those proportions (about 10% white lines and 8% web in the final version), then checked in the game: water is drawn entirely by the shader with a white shoreline, at close, default and far zoom; no seams between chunks; changed pixels between two frames are only water, units, the resource counter and the minimap marker; water and land moved the same 70 px while panning; no shader or page errors. Software WebGL only.
- **Water, first version** (`e2e-water`, `e2e-water2`): two frames 1.2 s apart differ only on water (plus moving units and the flag); terrain draws normally; no shader or page errors (the first version failed to link on uniform precision and blanked the terrain, which is why the filter is now compiled and linked once before it is attached). A first look showed hard diamond-shaped glints and long unbroken lines; these were replaced by small round sparkles and short broken crests. Panning: land and water both moved 140 px between screenshots (best match), so the pattern is fixed to the world, not the screen. Software WebGL only.

### Territory border at chunk edges (2026-10-14)

Fix: a chunk's border was drawn against neighbouring chunks that had not arrived yet (read as unowned), and was not redrawn when they did, leaving straight dashed lines through owned land along chunk boundaries. Neighbours are now redrawn when a chunk arrives or its territory changes, and an unknown neighbour draws no border. Checked in the browser with a new settlement whose territory crosses the y = -64 chunk boundary (tiles -74..-54): one continuous border, no line inside. Not compared against a build without the fix in the browser.

### Isometric renderer, new art and heroes (2026-10-10)

New worlds and seeded scenes (every building type, two construction sites, all seven hero types, Soldier, Archer, Worker, Hauler, Scout, a tamed wolf) were rendered for Human, Orc, Troll, Undead and High Elf owners, zoomed in, at default zoom and zoomed out: painted terrain with blended edges and foam, upright trees and bushes, building art with per-race palettes and owner-coloured flags, people with race-specific skin and features and owner-coloured tabards and capes, the dashed territory border, and units behind buildings shown as silhouettes. A Human player recruited the Paladin from the Town Hall (free, 30 s), the ★ top-bar button and Y selected it, the hero panel showed strengths, armor, aura, training and active effects; Divine Shield worked, Holy Light was refused ("No wounded units…") without starting its cooldown, and Rally showed its cooldown after the hero's own program had used it. A Dark Elf player recruited the Shadowblade, clicked Shadowstep (the range marker appeared, the cursor changed) and clicked a spot: "stepped to -50, -10". No page errors in any run.

Frame rate in headless Chromium with software WebGL (SwiftShader) at 1400×860: about 11 fps (about 7 with antialiasing, which is therefore off). A CPU profile showed under 1% of the time in JavaScript; the rest is software rasterisation. Frame rate on a real GPU was not measured here.

Performance replay with heroes: the same 2-player world (both players Undead) with both heroes recruited and running their default programs (Unholy Toil every 90 s) averaged 5.05 ms per tick (p99 18.6 ms) against 4.89 ms without heroes, no internal errors. This replay found that one player was at the 60-unit limit and could not recruit a hero; heroes are now outside the unit limit.

### Storage networks and limits (2026-10-10)

Against a server with `economy.storage: "networks"`: the top bar shows "3/60 units · 1/80 buildings"; the Town Hall panel has a "Stored here" section (bar and contents, 100 / 5000) with the network explanation; the build menu says "Paid from storage within 48 tiles of the site"; Stats shows the limits tile. With a Lodge and Library added offline and resources in the Town Hall, the Library lists Warehousing, Administration, and Bureaucracy and Grand Council as "needs …"; researching Administration took its cost from the Town Hall and, 60 s later, the top bar read "3/90 units · 3/120 buildings". No page errors.

Mutation checks: removing the spawn-avoidance rule makes the zone spawn test fail; removing the server's stealth filter makes the stealth network test fail.

The tests were also checked against deliberately broken rules (targets' opt-in ignored; wildlife attacking anyone): the relevant tests failed, as they should.

## Manual smoke-test checklist

Run after `npm install`, `npm run server`, `npm run dev`:

1. [ ] `npm run typecheck`, `npm run lint`, `npm test` pass.
2. [ ] Create a player. The map shows terrain, trees, your Town Hall with a banner, a territory tint, three units and (on v2 worlds) ruins and animals.
3. [ ] Tab selects a unit; the panel shows health, cargo, task, program, log and recent actions.
4. [ ] Edit code: a missing colon shows a diagnostic with line/column; Save & run works; the log shows output; History and Trace work; `scan("tree")` shows a locked-command diagnostic until you discover the Surveyor's Lens.
5. [ ] Build menu: placing outside your territory is rejected with a clear message; a Stockpile inside it is built by the Builder.
6. [ ] Build a Lodge, then a Library; research Sharpened Axes; the Stats panel lists it under Research and Active bonuses. Research Administration: the top bar's unit and building limits rise by 30 and 40.
7. [ ] Level 2 arrives from gathering; the Talents panel lets you learn a talent.
8. [ ] Select the Scout and right-click a ruin: it investigates, salvages, and a discovery toast appears. Right-click an animal: it observes it; afterwards the creature panel shows "View behaviour code".
9. [ ] Minimap: the explored area appears; +/− change the zoom; clicking moves the camera.
10. [ ] Library: save a program, assign it to several units (shift-drag), export it, import the exported text.
11. [ ] Open `?profile=2` in another window and create a second player; each sees the other's units but not their code.
12. [ ] Stop the server (Ctrl+C), restart it, reload: everything is where it was; running programs restart.
13. [ ] With `"combat": {"enabled": true}`: both players press ⚔ PvP; right-click an enemy unit with your unit selected to attack; Ctrl+right-click an animal to hunt; right-click your damaged building with a builder to repair; opt out and watch the countdown.
14. [ ] With `"economy": {"storage": "networks"}`: select the Town Hall and see "Stored here"; build a Stockpile far away (more than 24 tiles); placing a building near it fails until wood is hauled there with `withdraw("wood", 40, home)` and `deposit(stockpile)`.
15. [ ] Click ★ Recruit in the top bar, recruit your hero at the Town Hall, press Y when it arrives: its panel lists three abilities; use one; aimed abilities show a range marker and wait for a click. Build a Barracks and queue a battle-training rank.
16. [ ] Open a unit's editor, type `fin` and accept `find_nearest`: the list of kinds opens; leave out the `is not None` check and use the Fix button. Open Lessons, press "Try it in the editor", Save & run, and watch the lesson complete.
