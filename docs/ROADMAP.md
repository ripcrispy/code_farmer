# Roadmap

Phases follow the project specification (§21). Status as of 2026-10-10. Details per feature are in IMPLEMENTATION_STATUS.md.

## Done

- **Phase 0:** assessment (docs/PHASE0_ASSESSMENT.md), architecture and design docs.
- **Phase 1:** procedural map, three starting units, selection and inspection, gathering, inventory, storage, movement, building placement with costs, a restricted interpreter, status and error feedback.
- **Phase 2:** Node server, WebSocket protocol, sessions, shared world, server-side tasks, chunk sync, permission checks, multi-client tests.
- **Phase 3:** configurable seed, deterministic chunks, caching, SQLite, world meta, persistent modifications, migrations, restart tests, explicit world upgrade tooling.
- **Phase 4:** code library (versions, sharing, copy, group assignment, import/export), dictionaries, `try/except`, the `on_action_failed` handler, batch program control, per-unit action traces.
- **Phase 5:** territory with expansion buildings, territory statistics and leaderboard, Lumber Camp, Mine, Lodge, Library, research, Hauler, berry regrowth, withdrawal, building auras.
- **Phase 6:** experience and levels 1-60, 30 talent points, 16 general and 14 racial talents, racial passives, respec.
- **Phase 7:** ruins, wildlife with inspectable programs, inspection tiers, taming, training, guarding, discoveries that unlock commands, buildings and bonuses, manual investigate/observe/tame orders.
- **Optional combat:** server switch plus per-player PvP opt-in, unit death, building destruction, hunting, retaliating wildlife, Soldiers, Archers, Barracks, repair, healing, re-founding.
- **Contested zones, stealth, wildlife renewal, `on_attacked`,** and the last planned racial passives (Dark Elf stealth, Troll regeneration, Undead reclaiming).
- **Optional per-building storage** (storage networks with capacities, local payment, hauling, plunder; lossless mode switching) and **research that raises unit and building limits** (Administration line, server ceilings).
- **Heroes** (one per player and race, 21 abilities, battle training, hero research, revival) and an **isometric renderer with painted art** (per-race units and building palettes).
- **Coding help** for beginners: unit-aware autocomplete, parameter hints, hover docs, explained errors with quick fixes, warnings, recipes, the live running line, and 12 guided lessons.
- **PvE and animal husbandry:** generation v3 (new wildlife species, monster lairs from the seed), PvE independent of PvP, ten monsters with bosses, loot, trophies and discoveries, claimable cleared lairs; Paddocks with production, bonuses and breeding; Miners, Rangers, Knights and Clerics.
- **Performance pass:** worker-painted terrain, culled and pooled sprites, client chunk eviction, F3 overlay, server per-phase tick timings, pixel-accurate building picking.
- **Part of Phase 8:** minimap and regional overview, hierarchical pathfinding with cost bounds, fault containment, a performance replay of a real world.

## Next

1. **Phase 8 (rest):** a repeatable load test with thousands of units in the repository (the current replay is ad hoc), structured logs, persisting recent reqIds.
2. **More discovery content:** more trainable abilities (carry, scout), more creatures, more hidden discoveries, points of interest besides ruins.
3. **Event handlers** beyond `on_action_failed` and `on_attacked` (`on_idle`, `on_inventory_full`) and task priorities.
4. **Logistics:** play-test storage networks; possibly per-building delivery for training, a `transfer` helper, and showing networks on the map.
5. **Balance** of combat, heroes and abilities (including contested-zone rewards, stealth radii and plunder), monsters, lair rewards and paddock output needs play-testing. Lairs on the minimap.
6. **Art:** measure frame rate on real GPUs; walk-cycle frames, terrain elevation, ability visual effects, race-specific building shapes (now palettes only).
7. **Electron wrapper** (optional), deployment and recovery tooling.

## Phase 9: release readiness audit

Not started. Requires real authentication (D9), the items above, and a review of every "Implemented, unverified" row.
