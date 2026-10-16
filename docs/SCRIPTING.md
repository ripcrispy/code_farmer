# The Code Farmer language

A restricted, Python-style language for programming units. It is a real interpreter (parser -> bytecode -> budgeted VM), not JavaScript evaluation. Only the syntax listed here is supported; anything else produces a diagnostic with a line and column.

Language version: **1** (`LANGUAGE_VERSION` in `src/script/compiler.ts`; stored with every saved program version).

## Example

```python
def on_action_failed(action, reason):
    print(action, "failed:", reason)

def gather(kind):
    node = find_nearest(kind)
    if node is None:
        return False
    harvest(node)
    return True

while alive:
    if inventory.is_full():
        deposit()
    elif not gather("tree"):
        ruin = find_nearest("ruin")
        if ruin is not None and ruin.amount > 0:
            investigate(ruin)
        else:
            explore()
```

## Supported syntax

- Numbers (`3`, `2.5`), strings (`"a"`, `'b'` with `\n \t \\ \' \"` escapes), `True`, `False`, `None`, lists `[1, 2, 3]`, dictionaries `{"wood": 3, 1: True}`.
- Variables and assignment: `x = 1`, `x += 1`, `-=`, `*=`, `/=`, element assignment `xs[0] = 5`, `d["gold"] = 7`, `d["wood"] += 2`.
- Arithmetic `+ - * / // %` (`/` is true division, `//` floors, `%` follows Python's sign rules), string `+` and `*`, list `+` and `*`.
- Comparisons `== != < <= > >= is is not in not in` (not chained), boolean `and or not` with short-circuiting and Python truthiness. `in` works on lists, strings and dictionary keys.
- `if / elif / else`, `while`, `for name in <list | range | string | dict>` (a dict iterates over its keys in insertion order), `break`, `continue`, `pass`.
- `def name(a, b):` with `return` (top level only, up to 8 parameters). Functions read top-level variables; variables assigned inside a function are local.
- `try:` / `except:` (also `except Exception:` or `except GameError:`, optionally `as e`), with exactly one `except` clause. It catches **game errors**: runtime errors such as calling `harvest(None)`, a missing dictionary key or a type error. `e` is the error message (a string). Resource-limit violations (instruction budget, recursion, memory) can never be caught.
- **Event handlers:**
  - `on_action_failed(action, reason)` (exactly two parameters) runs whenever an action fails, before the failed call returns its failure value. `action` is the command name and `reason` the explanation.
  - `on_attacked(attacker)` (exactly one parameter, combat only) runs when the unit is hit: the action it was doing is abandoned (that call returns `None` once the handler finishes). It is called at most once every 2 seconds, and not while the unit is itself attacking.
  - Handlers do not interrupt each other: events during a handler are not delivered.
- Dictionary keys may be strings, whole numbers or booleans. Methods: `d.get(key, default=None)`, `d.keys()`, `d.values()`, `d.items()` (a list of `[key, value]` lists), `d.pop(key)`. `len(d)` gives the number of entries.
- Calls with positional arguments, attribute access on objects and namespaces, indexing (negative indices allowed on lists and strings).
- Comments with `#`. Blocks are defined by indentation (tabs count as 4 spaces).

Failed **actions** do not raise errors: they return their failure value (`False`, `0` or `None`) and record the reason in the unit log and trace. Use the return value, or `on_action_failed`, to react.

## Not supported (diagnosed)

`import`, `from`, `class`, `lambda`, `finally`, `raise`, multiple `except` clauses, `with`, `yield`, `async/await`, `global/nonlocal`, `del`, `assert`, `exec/eval`, sets, tuples and multiple assignment, keyword arguments, slices, `**`, chained comparisons, semicolons, triple-quoted strings, names starting with `__`.

## Grammar

```
program     := (statement | NEWLINE)* EOF
statement   := compound | simple_stmt (NEWLINE | EOF)
compound    := if_stmt | while_stmt | for_stmt | def_stmt | try_stmt
if_stmt     := "if" expr ":" suite ("elif" expr ":" suite)* ["else" ":" suite]
while_stmt  := "while" expr ":" suite
for_stmt    := "for" NAME "in" expr ":" suite
def_stmt    := "def" NAME "(" [NAME ("," NAME)*] ")" ":" suite        # top level only
try_stmt    := "try" ":" suite "except" [("Exception" | "GameError") ["as" NAME]] ":" suite
suite       := simple_stmt NEWLINE | NEWLINE INDENT statement+ DEDENT
simple_stmt := "pass" | "break" | "continue" | "return" [expr]
             | target ("=" | "+=" | "-=" | "*=" | "/=") expr
             | expr
target      := NAME | postfix "[" expr "]"
expr        := or_expr
or_expr     := and_expr ("or" and_expr)*
and_expr    := not_expr ("and" not_expr)*
not_expr    := "not" not_expr | comparison
comparison  := additive [comp_op additive]
comp_op     := "==" | "!=" | "<" | "<=" | ">" | ">=" | "is" ["not"] | ["not"] "in"
additive    := term (("+" | "-") term)*
term        := unary (("*" | "/" | "//" | "%") unary)*
unary       := ("-" | "+") unary | postfix
postfix     := atom ( "(" [expr ("," expr)* [","]] ")" | "." NAME | "[" expr "]" )*
atom        := NUMBER | STRING | NAME | "True" | "False" | "None"
             | "(" expr ")" | "[" [expr ("," expr)* [","]] "]"
             | "{" [expr ":" expr ("," expr ":" expr)* [","]] "}"
```

## Game commands

The editor's **Reference** tab lists every command with its current lock state; this section mirrors `src/script/commands.ts`.

**Actions** suspend the program until the unit finishes (each takes at least one tick):

| Command | Returns |
| --- | --- |
| `move_to(target)` / `move_to(x, y)` | `True` if arrived, `False` if unreachable |
| `harvest(node)` | amount gathered (gathers until full or the node is exhausted); `0` on failure |
| `deposit()` / `deposit(storage)` / `deposit_at_nearest_storage()` | `True` if cargo was stored. With storage networks, `deposit()` skips full buildings; `deposit(storage)` fails if that building is full and the unit keeps its cargo |
| `withdraw(resource)` / `withdraw(resource, amount)` / `withdraw(resource, amount, storage)` | amount taken from your stock into this unit (walks to your nearest storage, or the given one). With storage networks it takes from that building's network; without a storage argument it uses the nearest storage holding that resource |
| `use_ability(name)` / `use_ability(name, target)` / `use_ability(name, x, y)` | heroes only: `True` if the ability was used (cooldown starts), `False` with the reason in the log otherwise. Targets: a unit object for `arcane_bolt`, `backstab`, `drain_life`, `hex`; a tile for `shadowstep`, `farsight`. Ability ids are listed in the hero's panel and in GAME_DESIGN.md (Heroes) |
| `build(site)` | `True` when the building is complete |
| `place(type, x, y)` / `place(type, [x, y])` | the new construction site, or `None` if rejected (reason in the log). Pays the cost. |
| `train_unit(type)` | `True` if queued at your nearest building that trains it |
| `explore()` | `True` if an 8-16 tile leg (biased away from home) was completed |
| `wander(radius=8)` | `True` after a stroll to a random reachable spot nearby |
| `investigate(ruin)` | name of the discovery read from the ruin's inscription, or `None` |
| `observe(creature)` | `True` once the species' behaviour is understood (stay within 6 tiles) |
| `tame(creature)` | `True` if the creature joined you (carry its food cost; observe the species first) |
| `train_creature(creature, "guard")` | `True` when your tamed creature has learned the ability (carry the food cost) |
| `follow(target, seconds=30)` | `True` if the unit kept up (needs the follow ability, e.g. a tamed wolf) |
| `guard(x, y, seconds=60)` | `True` when the watch ends (needs the guard ability) |
| `wait(seconds=1)` | `None` (max 60 s) |
| `attack(target)` | `True` when the unit, creature or building falls; `False` if it got away or cannot be attacked. Lair monsters can be fought whenever PvE is on (the default); PvP needs combat enabled and both players opted in; hunting animals needs combat enabled |
| `pen(paddock)` | tamed animals only: `True` once the animal has walked into one of your paddocks (where it then lives and stops running its program) |
| `go_home()` | `True` when the unit is back at its home (creatures, monsters and tamed animals have one) |
| `repair(building)` | `True` when your building is fully repaired (costs half its price for a full repair, paid as the work is done) |
| `flee(target)` | `True` after running about 10 tiles directly away |

**Queries** return immediately:

| Command | Returns |
| --- | --- |
| `find_nearest(kind)` | object or `None`. Kinds: `"tree"`, `"stone"`, `"gold"`, `"berries"`, `"storage"` (your completed storage), `"construction"` (your unfinished buildings), `"ruin"`, `"creature"` (any wild animal), a species such as `"deer"`, `"boar"`, `"wolf"`, `"sheep"`, `"goat"`, `"horse"`, `"aurochs"`, `"bear"`, `"unit"` (your other units), `"enemy"` (another player's unit you may attack right now), `"enemy_building"` (a building you may attack right now), `"monster"` / `"boss"` (lair monsters you may attack, or a monster type such as `"goblin"`), `"paddock"` (your completed paddock with room). Limited to the unit's sensing radius; nodes the unit recently failed to reach are skipped for 60 s. |
| `scan(kind)` (locked) | list of up to 10 objects of a kind, nearest first. **Locked** until you discover the Surveyor's Lens (investigate ruins). Using it before then is a compile error that says how to unlock it. |
| `distance_to(target)` / `distance_to(x, y)` | tiles (king moves) |
| `exists(target)` | whether an object still exists |
| `stock(resource)` / `stock_all()` | your stored amount / a dict of all stored resources (with storage networks: totals across all your storage buildings) |
| `storage_contents(storage)` | what one of your storage buildings holds, e.g. `{"wood": 120, "stone": 0, "gold": 0, "food": 30, "capacity": 2000, "free": 1850}`. With shared storage the resources are 0 and `capacity`/`free` are -1 (unlimited) |
| `storage_mode()` | `"shared"` or `"networks"` (see GAME_DESIGN.md, Storage modes) |
| `hero()` | your hero object (wherever it is), or `None` if not recruited or fallen; e.g. `follow(hero())` |
| `ability_ready(name)` | heroes: `True` if this hero has that ability, it is off cooldown, and it is usable on this server |
| `find_build_spot(type)` | `[x, y]` of the nearest valid placement within 10 tiles (terrain, occupancy, territory; not cost), or `None` |
| `count_units()` / `count_units(type)` | units you own, including queued ones |
| `time()` | game time in seconds |
| `distance_to_home()` | tiles from this unit to its home (0 without one) |
| `last_attacker()` | the unit that hit this unit in the last 10 seconds, if it can still be fought back; otherwise `None` |
| `can_attack(target)` | whether this unit may attack the target right now |
| `in_contested_zone()` / `in_contested_zone(target)` / `in_contested_zone(x, y)` | whether this unit (or a target or tile) is inside a contested zone, where PvP is always on; always `False` without combat |
| `print(...)` | writes to the unit's log |
| `inventory.is_full()`, `.is_empty()`, `.total()`, `.count(res)`, `.capacity()`, `.free()` | cargo information |
| `me.x`, `me.y`, `me.id`, `me.type`, `me.hp`, `me.max_hp` | this unit |
| `alive` | `True` while the unit exists |

Objects returned by queries are read-only snapshots with `.id`, `.kind`, `.x`, `.y`, `.amount` (for ruins, `amount` is 1 until salvaged, then 0). Actions re-validate them against the current world, so a stale object simply makes the action fail.

**Built-ins:** `len`, `range`, `abs`, `min`, `max`, `int`, `str`, `round`, list `.append(x)` and `.pop([i])`, and the dictionary methods above.

### Example: react to attacks with an event handler

```python
def on_attacked(attacker):
    if me.hp < me.max_hp / 2:
        flee(attacker)
    else:
        attack(attacker)

while alive:
    if inventory.is_full():
        deposit()
    else:
        t = find_nearest("tree")
        if t is None:
            explore()
        else:
            harvest(t)
```

### Example: a self-defending worker (polling)

```python
while alive:
    a = last_attacker()
    if a is not None:
        if me.hp < me.max_hp / 3:
            flee(a)
        elif can_attack(a):
            attack(a)
        continue
    if inventory.is_full():
        deposit()
    else:
        harvest(find_nearest("tree"))
```

With combat disabled on the server, `last_attacker()` is always `None`, `find_nearest("enemy")` finds nothing and `attack()` fails with "Combat is disabled on this server", so such programs are harmless everywhere.

### Hauling between storage networks

With `storage_mode() == "networks"`, resources must be where the work is. A Hauler that keeps a remote Stockpile stocked with wood from home (start it next to a home storage; set `SITE_X`, `SITE_Y` to a tile beside the remote Stockpile):

```python
SITE_X = 150                       # a spot next to the remote Stockpile
SITE_Y = 40
home = find_nearest("storage")     # start the Hauler at home
move_to(SITE_X, SITE_Y)
target = find_nearest("storage")
while True:
    if storage_contents(target)["wood"] < 300 and storage_contents(home)["wood"] >= 40:
        withdraw("wood", 40, home)
        deposit(target)
    else:
        wait(10)
```

This exact program is run by `tests/storage.test.ts`.

### A hero program

```python
# Paladin: keep the work crew inspired and patched up.
while alive:
    if ability_ready("rally"):
        use_ability("rally")
    if me.hp < me.max_hp and ability_ready("holy_light"):
        use_ability("holy_light")
    site = find_nearest("construction")
    if site is not None:
        build(site)
    else:
        u = find_nearest("unit")
        if u is not None:
            follow(u, 20)
        else:
            wait(3)
```

This exact program is run by `tests/heroes.test.ts`.

Any unit can find the hero with `hero()`, for example to stay near its aura: `follow(hero(), 30)`.

## Help in the editor

- **Autocomplete** opens as you type (Ctrl+Space opens it anywhere); Tab or Enter accepts. It knows the unit: commands it cannot use here are greyed out with the reason (locked, combat off, only your hero, a Scout cannot build…). Inside `find_nearest("`, `place("`, `withdraw("`, `train_unit("`, `use_ability("` and similar, it lists the words that command accepts. After `me.`, `inventory.` or a variable followed by `.` it lists what you can read. Typing part of a name works too (`nearest` finds `find_nearest`).
- **Parameter hints** appear above the cursor inside a call, with the current argument in bold. **Hover** any command, keyword or variable for its documentation.
- **Problems** are underlined and listed under the code with a plain-language explanation; many have a **Fix** button (missing colon, indentation, misspelt names, semicolons, a missing `is not None` check, a loop that never acts, an unknown word such as `"tre"`). The compiler also suggests the intended name in its own messages: `Unknown name 'find_neares'. Did you mean 'find_nearest'?`
- **Recipes** (editor side panel) are tested programs you can insert at the cursor or use as a whole program. **Reference** entries insert at the cursor.
- While the unit runs the saved code, the **line it is executing** is highlighted and the strip under the code says what it is doing, or why the program is not running.
- **Lessons** (top bar) teach one idea at a time, from `print()` to functions, lists, event handlers and hero abilities. Each is completed automatically when one of your units' saved programs does what the goal says, and awards experience.

## Code library

Programs can be stored in your library (Library button) with a name, description, suitable unit types and an optional "shared" flag. Every save is a new version. You can assign a library program (any version) to selected units or to every unit of a type, copy shared programs from other players (never edit them), and export/import programs as text:

```json
{"format": "codefarmer-program", "formatVersion": 1, "languageVersion": 1, "name": "...", "description": "...", "unitTypes": ["worker"], "source": "..."}
```

Imports are validated strictly (format, sizes, and the source must compile). Library programs may contain locked commands; such a program fails to compile for a unit whose owner has not unlocked them yet, with the unlock hint. Limit: 100 programs per player.

## Limits

| Limit | Value |
| --- | --- |
| Source size | 16,000 characters, 12,000 tokens, 4,000 statements |
| Instructions per unit per tick | `simulation.scriptOpsPerUnitTick` (400) |
| Instructions per tick, all units | `simulation.scriptOpsPerTick` (200,000); extra units are deferred fairly |
| Instructions between two actions | 50,000, then "Instruction budget exceeded" |
| Call depth / value stack | 32 / 512 |
| List length and dictionary entries / live list items / string length | 1,000 / 20,000 / 2,000 |
| Variables | 256 globals |

## Lifecycle

Save (new version, compiled server-side) -> Run -> Pause (the current action finishes, then the program waits) -> Resume -> Stop. An uncaught runtime error stops the program with its line and message; the unit becomes idle and can be given a fixed program. Manual orders from the UI (right-click) stop the unit's program; an action it was waiting on is marked cancelled in the trace. Several selected units can be run, paused or stopped together. After a server restart, running programs start again from the first line.

## Diagnostics

Each unit keeps a **log** (`print` output and failure reasons) and a **trace** of its recent actions with their results and line numbers (Trace tab in the editor, Recent actions in the panel). The panel also shows why a unit is blocked.
