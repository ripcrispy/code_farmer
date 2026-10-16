# Game design (current rules and balance)

All numbers live in `src/shared/defs/` and are read by the simulation; nothing below is hard-coded elsewhere. They are initial values to tune by play-testing.

## Start of play

A new player receives:

- A complete **Town Hall** (3×3) at a spawn site at least 40 tiles from other Town Halls, with trees nearby. It immediately claims territory around it.
- Exactly **three units**, each running its default program: Woodcutter, Builder, Scout.
- The right to recruit one **hero** for free at the Town Hall (see Heroes).
- Starting stock: **50 wood, 0 stone, 0 gold, 50 food**.

Each player may have up to 60 units and 80 buildings to begin with. Research at the Library raises these limits (Administration, Bureaucracy, Grand Council: see Research), up to server-wide ceilings (`economy.unitLimitCeiling`, default 300; `economy.buildingLimitCeiling`, default 400). Wildlife and the hero do not count. The top bar shows current/limit.

## Units

| Unit | Speed (tiles/s) | Capacity | Gather/s (wood, stone, gold, food) | Build/s | HP | Sense radius | Cost | Train time | Trained at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Woodcutter (start) | 2.5 | 15 | 1.6, 0.8, 0.6, 1.0 | 0.6 | 60 | 20 | n/a | n/a | |
| Builder (start) | 2.2 | 10 | 0.9, 1.2, 0.8, 0.8 | 1.6 | 70 | 20 | n/a | n/a | |
| Scout (start) | 4.0 | 6 | 0.6, 0.5, 0.5, 0.9 | 0.5 | 45 | 28 | 50 food | 12 s | Lodge |
| Worker | 2.5 | 10 | 1.0, 0.9, 0.7, 1.2 | 1.0 | 50 | 20 | 40 food | 15 s | Town Hall, Lodge |
| Hauler | 2.0 | 30 | 0.9, 0.9, 0.6, 0.9 | 0.4 | 80 | 24 | 40 wood, 40 food | 20 s | Lodge |
| Miner | 2.3 | 14 | 0.6, 1.9, 1.5, 0.5 | 0.5 | 65 | 20 | 30 wood, 40 food | 18 s | Mine |
| Ranger | 3.0 | 10 | 0.6, 0.4, 0.4, 1.1 | 0.3 | 70 | 26 | 60 food, 10 gold | 18 s | Lodge |
| Cleric | 2.5 | 0 | none | 0 | 60 | 20 | 50 food, 40 gold | 25 s | Library |
| Soldier (fighting servers) | 2.6 | 0 | none | 0 | 140 | 20 | 20 wood, 60 food | 20 s | Barracks |
| Archer (fighting servers) | 2.6 | 0 | none | 0 | 70 | 24 | 40 wood, 50 food | 20 s | Barracks |
| Knight (fighting servers) | 2.8 | 0 | none | 0 | 240 | 20 | 20 wood, 80 food, 40 gold | 30 s | Barracks |

Rangers observe animals twice as fast, tame them for half the food and shoot from 4 tiles; their default program finds, studies and tames animals. Clerics do not fight; they heal your units within 4 tiles by 3 health every second. "Fighting servers" means combat or PvE is enabled (PvE is on by default, see below).

Player units have the `gather`, `build` and `explore` capabilities. Diagonal steps cost √2 tiles of movement. Units may share tiles. Race, research and talents modify speed, capacity, gathering, building, sensing, training cost and time (see Progression).

## Resources and nodes

| Node | Yields | Amount | Where | Regrowth |
| --- | --- | --- | --- | --- |
| Tree | wood | 40-80 | Dense in forests, sparse on grass | none (finite) |
| Stone deposit | stone | 150-300 | Hills, rare on grass | none |
| Gold vein | gold | 100-250 | Clustered on hills | none |
| Berry bush | food | 60-120 | Clustered on grass | 6 food per minute, up to its starting amount |

Nodes block movement; a unit gathers from an adjacent tile. Trees, stone and gold disappear at 0 and free their tile. An emptied berry bush stays (drawn bare) and regrows. Gathered resources go into the unit's inventory and reach the player's stock only when deposited at a completed storage building (Town Hall, Outpost, Stockpile, Lumber Camp, Mine). `withdraw()` takes resources back out of stock into a unit standing at one of your storage buildings. How the stock is kept depends on the server's storage mode (next section).

## Storage modes

The server operator picks one with `economy.storage` (see CONFIGURATION.md).

**Shared (default).** One stock per player, usable anywhere. Storage buildings are just drop-off points. This is how the game always worked.

**Storage networks.** Resources sit in the storage buildings that received them.
- Each storage building has a capacity: Town Hall 5000, Stockpile 2000, Outpost, Lumber Camp and Mine 1500 (Warehousing research: +50%). A full building refuses deposits; a plain `deposit()` walks on to the next storage with room, `deposit(storage)` fails with "… is full" and the unit keeps its cargo.
- Storage buildings within 24 tiles of each other form one **network** and share their contents.
- Costs are paid from the network serving the place where the work happens: construction from a storage within 48 tiles of the site, training and research from a storage within 48 tiles of that building. Resources in another network must be hauled there (`withdraw(resource, amount, storage)` and `deposit(storage)`; the Hauler carries the most). Talent respec is paid from any combination of storage.
- Farms deliver to the nearest storage with room within 48 tiles; with none, production pauses and the Farm says so.
- If a storage building is destroyed, its contents are lost; if an enemy destroyed it, they plunder a quarter of it into their own nearest storage.
- Switching an existing world between modes happens on server start and loses nothing: shared → networks puts each player's stock into their Town Hall (or first storage building), which may then be over capacity until it is spent; networks → shared adds all building contents back into one stock.

## Buildings

| Building | Size | Cost | Build points | HP | Territory radius | Function | Requirement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Town Hall | 3×3 | 200 wood, 100 stone | 90 | 1000 | 12 | Storage; trains Workers; expansion | Research Civic Planning |
| Outpost | 2×2 | 60 wood, 30 stone | 25 | 400 | 8 | Storage; expansion | |
| Stockpile | 2×2 | 40 wood | 12 | 300 | 3 | Storage | |
| Farm | 3×3 | 60 wood | 20 | 250 | 3 | 0.25 food/s (15/min), +60% at full fertile-soil coverage | Grass, fertile soil or forest floor |
| Lumber Camp | 2×2 | 50 wood | 15 | 300 | 3 | Storage; your units gather wood 25% faster within 10 tiles | |
| Mine | 2×2 | 60 wood, 20 stone | 20 | 450 | 3 | Storage; stone and gold 25% faster within 10 tiles | On hills |
| Lodge | 3×3 | 100 wood, 40 stone | 35 | 600 | 5 | Trains Workers, Scouts, Haulers | |
| Library | 3×3 | 80 wood, 60 stone, 20 gold | 40 | 500 | 4 | Research | A completed Lodge |
| Watchtower | 2×2 | 60 wood, 40 stone | 30 | 500 | 6 | +2 chunks of vision; expansion | Discover the Watchtower Blueprint |
| Barracks | 3×3 | 120 wood, 60 stone | 40 | 800 | 4 | Hero battle training and revival; with combat enabled, also trains Soldiers and Archers | A completed Lodge |

Costs and HP are modified by race, research and talents. The full cost is charged once, when the site is placed. A placed site has 10% HP and must be built by units; build points accumulate at each builder's build rate. Training and research queues hold up to 5 orders per building, charged when queued.

### Removing units and buildings

- **Dismiss** (unit panel, or "Dismiss all" for a multi-selection; two clicks to confirm): your own units are removed for good, with their cargo. Heroes cannot be dismissed. A tamed creature is not killed: it is let out of its paddock and goes back to the wild (neutral, running its wild behaviour). A request containing any unit you do not own is refused as a whole.
- **Demolish** (building panel; "Cancel construction" for a site): a construction site refunds half its scaled cost; a completed building refunds nothing. Its territory, any stock it held and its penned animals are released, as when a building is destroyed. Removing every unit and building you have founds a new settlement, as when a settlement is wiped out.
- Both are validated by the server and written to the audit log (`unit_dismissed`, `building_demolished`).

## Territory

- Every tile has at most one owner. A building claims unowned tiles within its territory radius (plus territory-radius bonuses) when it is **completed**. The first claim wins: land is never taken from another player.
- Ordinary buildings must sit entirely inside your own territory. **Expansion buildings** (Outpost, Town Hall, Watchtower) may also be placed on unowned land within 24 tiles of your territory. Nothing may be placed on another player's territory.
- Territory is rebuilt deterministically on server start from completed buildings (ordered by completion), so it never drifts.
- Statistics (tiles owned, chunks explored, leaderboard, expansion history) are in the Stats panel. Press **T** to toggle the territory overlay.

## Research

The Library researches technologies (cost charged when queued):

| Technology | Cost | Time | Requires | Effect |
| --- | --- | --- | --- | --- |
| Sharpened Axes | 60 wood, 20 stone | 40 s | | +20% wood gathering |
| Masonry | 60 wood, 40 stone | 45 s | | +20% stone gathering; +15% building health |
| Prospecting | 80 wood, 40 stone, 10 gold | 50 s | Masonry | +25% gold gathering |
| Crop Rotation | 80 wood, 40 food | 45 s | | +30% farm production; +10% food gathering |
| Ox Carts | 100 wood, 40 food | 50 s | | +4 carrying capacity |
| Surveying | 60 wood, 30 stone | 40 s | | +4 sensing radius; +2 territory radius |
| Civic Planning | 150 wood, 100 stone, 30 gold | 60 s | Surveying | Unlocks the Town Hall |
| Efficient Scripts | 50 wood, 40 gold | 40 s | | +25% script instruction budget |
| Warehousing | 120 wood, 60 stone | 50 s | | +50% storage capacity (storage networks mode) |
| Administration | 200 wood, 150 stone, 50 gold | 60 s | | +30 unit limit, +40 building limit |
| Bureaucracy | 400 wood, 300 stone, 150 gold | 90 s | Administration | +40 unit limit, +60 building limit |
| Grand Council | 800 wood, 600 stone, 400 gold | 120 s | Bureaucracy | +50 unit limit, +80 building limit |

With all three, a player may have 180 units and 260 buildings, unless the server's ceilings are lower.

## Heroes

Every player may have **one hero**, the champion of their race. It is an ordinary unit you can select, order and program, with extra rules:

- **Recruiting:** once, at a Town Hall, free, 30 s. It does not count toward the unit limit.
- **Growth:** +2% health and damage per player level above 1, plus Barracks battle training and Library research (below).
- **Abilities:** a passive aura or trait, and three abilities with cooldowns. Use them from the hero's panel (aimed abilities ask you to click a unit or a spot) or from its program with `use_ability()`. Abilities marked ⚔ hurt other units; they need combat enabled on the server and follow the normal PvP rules (opt-in, contested zones, hunting). Everything else works on every server. An ability that would do nothing (nobody to heal, no building in range) fails and does not start its cooldown.
- **Death and revival:** a fallen hero is revived at a Town Hall or Barracks for 50 food and 25 + 5 × level gold, taking 20 + level seconds. Battle training and research are kept. Killing a hero is worth experience as if it had cost 300 resources.
- **Armor** reduces damage taken (at most 80% in total, including auras and shields).

| Race | Hero | HP | Damage (range) | Speed | Armor | Strengths / weaknesses | Passive | Abilities (cooldown) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Human | Paladin | 400 | 14 (melee) | 2.4 | 30% | Tough, heals, inspires workers / slow, melee only | Devotion: own units within 6 tiles take 15% less damage | Holy Light: heal own units within 6 tiles by 60 (30 s) · Rally: own units within 8 tiles gather and build 25% faster for 30 s (90 s) · Divine Shield: cannot be harmed for 8 s (60 s) |
| Orc | Warchief | 340 | 20 (melee) | 3.0 | 15% | Highest damage, fast, speeds training / light armour | Warpath: own units within 8 tiles move 15% faster | War Cry: own units within 8 tiles +30% damage, +20% speed for 20 s (60 s) · Muster: own buildings within 10 tiles train twice as fast for 30 s (120 s) · ⚔ Whirlwind: 40 damage to every attackable unit within 2 tiles (25 s) |
| Dwarf | Thane | 480 | 15 (melee) | 2.1 | 35% | Most health and armour, builder and miner / slowest, short sight | Stonework: own units within 6 tiles build and repair 20% faster | Master Mason: construction sites within 6 tiles advance by a quarter of their build time (60 s) · Rich Seam: own units within 8 tiles gather stone and gold 50% faster for 30 s (90 s) · ⚔ Thunder Slam: 30 damage within 3 tiles and 50% slow for 5 s (30 s) |
| High Elf | Loremaster | 220 | 12 (5 tiles) | 2.6 | 5% | Ranged, long sight, speeds research / fragile | Clarity: own units within 8 tiles get a 50% larger script budget | Farsight: see (and detect hidden units in) a 10-tile area up to 40 tiles away for 20 s (60 s) · Inspiration: own buildings within 8 tiles research and train 50% faster for 30 s (90 s) · ⚔ Arcane Bolt: 45 damage within 7 tiles (12 s) |
| Dark Elf | Shadowblade | 240 | 18 (melee) | 3.6 | 10% | Fastest, always stealthy, big single strikes / fragile | Always hidden from other players without something close by | Shadowstep: teleport up to 10 tiles (20 s) · Veil of Night: own units within 6 tiles hidden for 30 s (90 s) · ⚔ Backstab: 50 damage to an adjacent unit, double while hidden (15 s) |
| Undead | Necromancer | 300 | 11 (4 tiles) | 2.3 | 15% | Revives for half the cost and time, turns food into gold / slow, low damage | Revives at half cost and time | Dark Ritual: 100 food from nearby storage into 50 gold (60 s) · Unholy Toil: own units within 8 tiles gather and build 30% faster for 30 s (90 s) · ⚔ Drain Life: 35 damage within 5 tiles, heals the Necromancer as much (15 s) |
| Troll | Shaman | 300 | 10 (4 tiles) | 2.8 | 10% | Healing, regeneration, befriends animals / low damage and armour | Spirit Bond: own units within 6 tiles regenerate three times as fast | Spirit Totem: heal own units within 6 tiles by 50 (30 s) · Wild Call: instantly tame the nearest tameable animal within 6 tiles (120 s) · ⚔ Hex: target takes 50% more damage and moves 40% slower for 10 s (30 s) |

Heroes can build (Thane fastest), explore and follow, but do not gather. Their default program stays with your workers, helps build, and uses its support abilities whenever they are ready.

**Barracks battle training** (kept through death): Strength (+12% hero damage per rank), Vitality (+15% hero health), Tactics (−8% ability cooldowns), five ranks each; rank *r* costs 20r wood, 25r gold, 50r food and takes 20 + 10r seconds.

**Library hero research:** Heroic Legends (+20% hero health and damage; 150 wood, 100 stone, 60 gold), Arcane Channeling (−20% cooldowns; 100 wood, 80 gold), Far-Reaching Auras (+50% aura and ability radius; needs Heroic Legends), Rites of Return (revival 40% cheaper and faster; 100 wood, 60 stone, 50 gold).

## Races

| Race | Passives |
| --- | --- |
| Human | +10% gathering of every resource; -10% building cost |
| Dark Elf | +6 sensing radius; +15% movement speed; +20% wood gathering; units are hidden from other players while in forest (stealth) |
| High Elf | +20% experience; -20% research time; +25% script instruction budget |
| Orc | -20% training cost; -25% training time; +2 territory radius |
| Dwarf | +25% stone and gold gathering; +25% construction speed; +30% building health |
| Undead | +50% salvage from ruins; +20% gold gathering; -15% training cost; defeating a trained enemy unit reclaims 30% of its cost (45% with the salvage bonus; combat only) |
| Troll | +25% food gathering; +15% wood gathering; +4 sensing radius; +10% movement speed; units regenerate health three times as fast (combat only) |

Percentages from all sources (race, research, talents, discoveries) add up, and a stat never drops below 20% of its base.

## Progression

- **Experience** comes only from gaining something: 0.5 per resource gathered, 0.5 × the base cost of buildings you complete, 25 per new chunk explored, 0.2 per tile of territory claimed, 0.5 × research cost, 100 per discovery, 40 per species observed, 30 per ruin investigation that yields salvage or a new discovery, 80 per creature tamed, 50 per creature trained. The starting claim and starting chunk give nothing, and repeating something that yields nothing gives nothing.
- **Levels** 1-60. Reaching level *L* needs `round(100 × L^1.6)` experience in total; experience is capped at level 60.
- **Talent points:** one at every even level (30 at level 60).
- **Talents:** 16 general talents (economy, gathering, construction, automation, exploration, territory) and 2 racial talents per race, each with ranks, a level requirement and sometimes a prerequisite (`src/shared/defs/talents.ts`). Resetting all talents costs 20 gold per spent point.

## Discovery and creatures

Generation v2 worlds add **ruins** (about one chunk in three; 15% of them ancient) and **wildlife**. Creatures spawn the first time a player comes near their chunk, never twice. Away from players they sleep (no movement, no script execution).

| Creature | Behaviour | Tame | Observe | Trainable |
| --- | --- | --- | --- | --- |
| Deer | Grazes and wanders near home | cannot be tamed | 8 s | |
| Wild boar | Forages berries (eats what it gathers) | carry 30 food | 10 s | |
| Wolf | Roams | carry 50 food | 12 s | guard: 40 food, 10 s |
| Sheep (v3) | Grazes in flocks on grassland, flees | carry 20 food | 6 s | |
| Mountain goat (v3) | Climbs about the hills, flees | carry 25 food | 8 s | |
| Wild horse (v3) | Roams widely on open grassland, fast, flees | carry 60 food | 10 s | |
| Aurochs (v3) | Grazes; fights back | carry 70 food | 10 s | |
| Bear (v3) | Forages berries around its den; fights back hard | carry 90 food | 14 s | |

Rangers pay half of these taming costs.

### Paddocks

A **Paddock** (4×4, 80 wood and 20 stone) holds up to 8 tamed animals. Most tamed animals walk to your nearest paddock with room by themselves (their default program uses `pen(find_nearest("paddock"))`); you can also select one and right-click a paddock, or use the **Send to paddock** button. Animals in a paddock live inside the fence (you can see them), stop running programs, cannot be attacked, and do not count toward your unit limit. Release one from the paddock's panel (it then counts again).

| Animal | In a paddock (per animal) | Breeding |
| --- | --- | --- |
| Sheep | 4 food and 1 gold a minute | 5 min, 15 food |
| Mountain goat | 3 food a minute; +3% stone gathering (up to 5 goats) | 5 min, 15 food |
| Wild horse | +3% unit movement speed (up to 5) | 10 min, 40 food |
| Aurochs | 8 food a minute; +3% carrying capacity (up to 5) | 10 min, 40 food |
| Bear | +3% damage (up to 5) | 15 min, 60 food |
| Wild boar | 5 food a minute | 6 min, 20 food |
| Wolf | +1 sensing radius (up to 3) | 10 min, 40 food |

Bonuses count animals of the species in all your paddocks. Output is paid to your stock like farm output (storage networks: to storage within supply range) and benefits from production bonuses. A species with at least two animals in a paddock raises a young one over its breeding time while the paddock has room; the food is paid at the birth (breeding waits if you cannot pay). A destroyed paddock's animals escape next to it.

## PvE: monster lairs (generation v3)

Lairs are placed from the world seed (one in about 45% of the 112×112-tile regions, none within 120 tiles of the world centre) and get harder with distance from the centre. Each is a circle drawn on the ground with a landmark in the middle, and is visible in the hover readout and the Stats panel. New settlements are never founded within 36 tiles of a lair.

| Lair | Tier | Monsters | Boss | Boss loot | Trophy (permanent, once per boss kind) | Discovery |
| --- | --- | --- | --- | --- | --- | --- |
| Goblin Camp | 1 | 4 goblins | Goblin Chief | 200 wood, 80 gold | Goblin Totem: +5% wood gathering | War Drums: +5% damage |
| Spider Nest | 2 | 5 giant spiders | Spider Queen | 300 food, 120 gold | Silk Banner: +5% carrying capacity | Silk Rigging: +10% storage capacity |
| Bone Crypt | 2 | 6 skeletons | Lich (ranged) | 200 stone, 200 gold | Lich's Phylactery: +5% experience | Necromantic Grimoire: -10% research time |
| Ogre Den | 3 | 3 ogres | Ogre Warlord | 400 stone, 250 gold | Warlord's Skull: +10% building health | Ogre Masonry: -10% building cost |
| Drake Roost | 4 | 3 drake whelps | Ancient Drake | 800 gold | Drake Scale: +10% damage | Dragonfire Lore: +10% gold gathering |

- A lair wakes (its monsters appear) when a player's units or buildings come within about two chunks. Monsters attack any unit inside the lair (or that hits them), and never chase more than 6 tiles beyond its edge.
- **PvE is independent of PvP combat** (`combat.pve`, on by default): on a server with combat off, units can still fight monsters and monsters can still hurt units (and heroes), but players can never attack each other or hunt animals. Units heal 2% a second when not hit for 10 s; Clerics heal more.
- **Rewards:** every monster gives experience (12 to 1500) and loot delivered to your stock; the boss gives the lair's loot, its trophy and discovery. Clearing the lair (last monster) gives extra experience.
- **Claiming:** for 60 minutes after clearing only the player who cleared it may build in the lair, and an Outpost (or other expansion building) may be placed there however far from their territory. Otherwise no one can build in an occupied lair. A cleared lair whose centre is not anyone's territory is reoccupied after its respawn time (30-120 minutes); a claimed one stays clear.
- A monster's behaviour code is public (select it and press **View behaviour code**). Scripts find monsters with `find_nearest("monster")` / `find_nearest("boss")`.

Inspection tiers:

1. **Visible:** anyone can see a creature's type, position, activity and public stats.
2. **Observed:** a unit watches the creature from within 6 tiles for the observation time. The species' behaviour program then becomes readable for that player (the server refuses it before).
3. **Trainable:** tame an observed species by bringing the food (it joins you and runs a tamed program), then train abilities. A guarding wolf keeps wild foragers away from resources within 8 tiles of its post.
4. **Hidden:** discoveries found only under specific conditions.

| Discovery | How it is found | Effect |
| --- | --- | --- |
| Surveyor's Lens | Investigating ruins | Unlocks the `scan()` command |
| Watchtower Blueprint (hidden) | Investigating ancient ruins | Unlocks the Watchtower |
| Forager's Instinct (hidden) | Observing a wild boar while it forages | +10% food gathering |
| Pack Discipline | Training a wolf to guard | +2 sensing radius |

Investigating a ruin takes 12 s (ancient: 20 s). The first player to finish salvages it (40 stone and 15 gold; ancient: 80 stone and 40 gold); everyone can still read its inscription afterwards.

## Combat (optional)

Combat is **off** unless the server operator enables it (`combat.enabled`). With it off, no player can attack another and animals cannot be hunted, and the interface shows nothing about PvP. PvE (lair monsters) is a separate switch, `combat.pve`, on by default: while it is on, Soldiers, Archers and Knights can be trained and hero combat abilities work, but only against monsters. With both off, nothing can be fought at all.

With combat enabled:

- **PvP is opt-in per player** (the ⚔ PvP button). A player's units and buildings can only be attacked by players who are also opted in, and only while both are. Opting in is immediate. Opting out takes effect after `combat.optOutDelaySeconds` (default 120 s), and every fight restarts that countdown, so nobody can escape a battle by opting out.
- **Hunting** wild animals needs no opt-in. Animals never attack unprovoked; a boar or wolf fights back against units of the player who attacked it (for 30 s), and deer flee. Killed animals give their meat (deer 40, boar 50, wolf 20 food) to the hunter, up to what it can carry, and do not respawn.
- Units attack every *cooldown* seconds when within *range* (Chebyshev); melee units chase their target and give up if it gets more than their sensing radius plus 10 tiles away. Buildings take `damage × buildingFactor`.

| Unit | Damage | Range | Cooldown | vs buildings |
| --- | --- | --- | --- | --- |
| Soldier | 10 | 1 | 1.0 s | ×1 |
| Archer | 6 | 5 | 1.5 s | ×0.3 |
| Woodcutter | 4 | 1 | 1.2 s | ×0.4 |
| Builder | 3 | 1 | 1.2 s | ×0.5 |
| Worker | 3 | 1 | 1.2 s | ×0.3 |
| Scout | 3 | 1 | 1.0 s | ×0.2 |
| Hauler | 2 | 1 | 1.4 s | ×0.3 |
| Wild boar | 6 | 1 | 1.2 s | cannot |
| Wolf | 9 | 1 | 1.0 s | cannot |

- A unit at 0 health dies and is removed; its owner and the attacker are notified. A building at 0 health is destroyed: its footprint is freed and its territory is released (ownership is re-derived from the remaining buildings).
- Units heal 2% of their maximum health per second after 10 s without being hit.
- **Repair:** units that can build restore a completed building's health at the same pace as construction. A full repair costs half the building's price, paid as the work is done; it stops when you run out.
- **Re-founding:** a player left with no units and no buildings gets a new Town Hall and the three starting units elsewhere. Experience, research, talents and discoveries are kept, and resources are topped up to the starting amounts.
- **Experience:** 15 per animal hunted; a quarter of a defeated unit's training cost (starting units give nothing); a tenth of a destroyed building's cost (Town Halls give nothing). These rules keep friends from farming each other.
- Other players see each unit's health percentage and PvP status, never inventories or code.

### Contested zones

With combat enabled (and `combat.contestedZones`, on by default), some small areas of the map are **contested zones**, drawn as red dashed circles (also on the minimap):

- **PvP is automatic inside a zone.** Any player's unit may attack any other player's unit standing in a zone, and any building with at least one tile in a zone, whether or not either player opted in. A unit that steps out of the zone is protected again by the normal opt-in rules. Animals still only fight back.
- **The reward is rich land:** gathering inside a zone is 50% faster. Expanding into a zone (territory, Outposts) is allowed, but whatever you build there has to be defended. The placement ghost turns red-edged over a zone, and the selection panel warns about units and buildings inside one.
- Zones are small: radius 14 to 36 tiles (most around 20). They come from the world seed (one in about half of the 256×256-tile regions), never change the terrain, and there are none within 256 tiles of the world centre. New settlements are never founded within 48 tiles of a zone.
- Scripts can check `in_contested_zone()`.

### Stealth

- **Scouts** are always stealthy; **Dark Elf** units are stealthy while standing in forest.
- A stealthy unit is invisible to another player (not even sent to their game) unless one of that player's units is within 5 tiles of it, or one of their completed buildings within 5 tiles (a Watchtower: 12). Hidden units cannot be targeted.
- Attacking or being hit reveals a unit for 10 seconds.
- Your own hidden units are drawn faded, and their panel says so. Stealth works whether or not combat is enabled (it hides scouting).

### Wildlife renewal

Hunted or tamed animals slowly come back: a chunk near a player that has fewer animals than it started with gets one back every 5 minutes, at its original spot if that is unclaimed land, up to its original number.

## Vision

You can observe chunks (64×64 tiles) within 2 chunks of any chunk containing one of your units or buildings; Watchtowers add 2 more around themselves. Other players' units show type, activity and whether they carry cargo, never inventory or code. The minimap shows only chunks you have explored.

## Not implemented

Tree regrowth. See ROADMAP.md.
