/**
 * Recipes: small, tested building blocks for unit programs, offered in the editor.
 * Each one is a complete program on its own and can also be pasted into a bigger one.
 * tests/assist.test.ts compiles every recipe and checks it has no warnings.
 */
import type { AbilityDef } from "../shared/defs/heroes.ts";

export interface Recipe {
  id: string;
  title: string;
  description: string;
  /** Who it is for, shown as a tag. */
  for: string;
  code: (opts: { heroAbilities: AbilityDef[] }) => string;
}

const fixed = (s: string) => (): string => s;

export const RECIPES: Recipe[] = [
  {
    id: "gather_wood",
    title: "Gather wood and bring it home",
    description: "Chop the nearest tree until full, store the wood, repeat. Explores when no tree is in sight.",
    for: "gatherers",
    code: fixed(`# Gather wood forever.
while alive:
    if inventory.is_full():
        deposit()
    else:
        tree = find_nearest("tree")
        if tree is not None:
            harvest(tree)
        else:
            explore()
`),
  },
  {
    id: "gather_choice",
    title: "Gather the resource you choose",
    description: "Change RESOURCE to \"stone\", \"gold\" or \"berries\" to gather something else.",
    for: "gatherers",
    code: fixed(`# Change this to "tree", "stone", "gold" or "berries".
RESOURCE = "stone"

while alive:
    if inventory.is_full():
        deposit()
    else:
        node = find_nearest(RESOURCE)
        if node is not None:
            harvest(node)
        elif not inventory.is_empty():
            deposit()
        else:
            explore()
`),
  },
  {
    id: "gather_lowest",
    title: "Gather whatever you have least of",
    description: "Uses a function and a dictionary to pick the scarcest resource each trip.",
    for: "gatherers",
    code: fixed(`def scarcest():
    amounts = stock_all()
    best = "wood"
    for r in ["stone", "food", "gold"]:
        if amounts[r] < amounts[best]:
            best = r
    return best

KINDS = {"wood": "tree", "stone": "stone", "gold": "gold", "food": "berries"}

while alive:
    if inventory.is_full():
        deposit()
    else:
        node = find_nearest(KINDS[scarcest()])
        if node is not None:
            harvest(node)
        else:
            explore()
`),
  },
  {
    id: "builder",
    title: "Help finish construction sites",
    description: "Builds any of your unfinished buildings nearby, and gathers wood in between.",
    for: "builders",
    code: fixed(`while alive:
    site = find_nearest("construction")
    if site is not None:
        build(site)
    elif inventory.is_full():
        deposit()
    else:
        tree = find_nearest("tree")
        if tree is not None:
            harvest(tree)
        else:
            wait(2)
`),
  },
  {
    id: "place_stockpile",
    title: "Build a Stockpile near me (once)",
    description: "Finds a free spot, places a Stockpile and builds it. Shows how place() and build() work together.",
    for: "builders",
    code: fixed(`spot = find_build_spot("stockpile")
if spot is not None:
    site = place("stockpile", spot)
    if site is not None:
        build(site)
        print("Stockpile finished!")
else:
    print("No free spot for a stockpile here")
`),
  },
  {
    id: "train_workers",
    title: "Keep training workers",
    description: "Trains Workers at your Town Hall until you have the number you want.",
    for: "any unit",
    code: fixed(`TARGET = 8

while alive:
    if count_units("worker") < TARGET and stock("food") >= 40:
        train_unit("worker")
    wait(5)
`),
  },
  {
    id: "scout_report",
    title: "Explore and report what you find",
    description: "Explores and prints where gold and ruins are.",
    for: "scouts",
    code: fixed(`legs = 0
while alive:
    explore()
    legs += 1
    gold = find_nearest("gold")
    if gold is not None:
        print("Gold at", gold.x, gold.y)
    ruin = find_nearest("ruin")
    if ruin is not None:
        print("Ruin at", ruin.x, ruin.y)
`),
  },
  {
    id: "follow_hero",
    title: "Stay near my hero",
    description: "Keeps this unit inside your hero's aura.",
    for: "any unit",
    code: fixed(`while alive:
    h = hero()
    if h is not None:
        follow(h, 30)
    else:
        wait(5)
`),
  },
  {
    id: "hero_support",
    title: "Hero: use support abilities when ready",
    description: "Your hero uses each of its abilities that work without combat as soon as they are ready, and helps build.",
    for: "your hero",
    code: ({ heroAbilities }) => {
      const ids = heroAbilities.filter((a) => !a.combat && a.target === "none").map((a) => `"${a.id}"`);
      return `ABILITIES = [${ids.join(", ")}]

while alive:
    for name in ABILITIES:
        if ability_ready(name):
            use_ability(name)
    site = find_nearest("construction")
    if site is not None:
        build(site)
    else:
        wait(3)
`;
    },
  },
  {
    id: "retry_handler",
    title: "Report failed actions",
    description: "An event handler: runs whenever an action fails, so you can see why in the log.",
    for: "any unit",
    code: fixed(`def on_action_failed(action, reason):
    print(action, "failed:", reason)

while alive:
    tree = find_nearest("tree")
    if tree is not None:
        harvest(tree)
        deposit()
    else:
        explore()
`),
  },
  {
    id: "tame_boar",
    title: "Observe and tame a boar",
    description: "Watches a wild boar to learn its behaviour, fetches food, then tames it.",
    for: "any worker",
    code: fixed(`boar = find_nearest("boar")
if boar is not None:
    if observe(boar):
        withdraw("food", 30)
        if tame(boar):
            print("Tamed a boar!")
else:
    print("No boar nearby")
`),
  },
  {
    id: "defend",
    title: "Fight back when attacked",
    description: "Combat servers: attacks whoever hits this unit, otherwise keeps gathering.",
    for: "combat",
    code: fixed(`while alive:
    enemy = last_attacker()
    if enemy is not None:
        attack(enemy)
    else:
        tree = find_nearest("tree")
        if tree is not None:
            harvest(tree)
            deposit()
        else:
            wait(2)
`),
  },
];
