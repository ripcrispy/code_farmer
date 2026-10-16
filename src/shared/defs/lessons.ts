import type { AbilityDef } from "./heroes.ts";

/**
 * Guided coding lessons. Each teaches one idea, gives an example and hints, and is
 * completed by the server when one of the player's units' programs actually does the
 * thing (see LessonEvent), never by clicking. Completing one awards experience.
 */

/** Something a unit's program did (reported by the simulation). */
export type LessonEvent =
  | { kind: "print" }
  /** A script action finished (`ok` false when it failed). */
  | { kind: "action"; name: string; ok: boolean }
  /** The program's on_action_failed handler was called. */
  | { kind: "handler" };

/** Facts about the program text of the unit that caused the event. */
export interface SourceFeatures {
  assigns: boolean;
  whileAlive: boolean;
  ifElse: boolean;
  noneCheck: boolean;
  /** Names of functions the program defines and also calls. */
  calledFunctions: string[];
  forList: boolean;
  usesFindNearest: boolean;
  usesPlace: boolean;
  handler: boolean;
  checksFull: boolean;
}

export function sourceFeatures(src: string): SourceFeatures {
  const code = src.replace(/#.*$/gm, "");
  const defs = [...code.matchAll(/^\s*def\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1] as string);
  const calledFunctions = defs.filter((d) => !d.startsWith("on_") && (code.match(new RegExp(`\\b${d}\\s*\\(`, "g")) ?? []).length >= 2);
  return {
    assigns: /^\s*[A-Za-z_]\w*\s*=(?!=)/m.test(code),
    whileAlive: /^\s*while\s+alive\s*:/m.test(code),
    ifElse: /^\s*if\b.*:\s*$/m.test(code) && /^\s*else\s*:/m.test(code),
    noneCheck: /\bis\s+not\s+None\b|\bis\s+None\b/.test(code),
    calledFunctions,
    forList: /^\s*for\s+\w+\s+in\s+(\[|[A-Za-z_]\w*\s*$|[A-Za-z_]\w*\s*:)/m.test(code) && /\[/.test(code),
    usesFindNearest: /\bfind_nearest\s*\(/.test(code),
    usesPlace: /\bplace\s*\(/.test(code),
    handler: /^\s*def\s+on_action_failed\s*\(/m.test(code),
    checksFull: /inventory\.is_full\s*\(/.test(code),
  };
}

export interface LessonDef {
  id: string;
  title: string;
  /** The idea it teaches, in a few words. */
  teaches: string;
  explanation: string;
  example: string;
  /** Shown one at a time when the player asks for help. */
  hints: string[];
  goal: string;
  xp: number;
  check: (ev: LessonEvent, f: SourceFeatures) => boolean;
}

const ok = (ev: LessonEvent, name: string): boolean => ev.kind === "action" && ev.ok && ev.name === name;
const anyOk = (ev: LessonEvent): boolean => ev.kind === "action" && ev.ok;

export const LESSONS: LessonDef[] = [
  {
    id: "hello",
    title: "Say hello",
    teaches: "running a program, print()",
    explanation:
      "Every unit runs a small program, line by line from the top. print() writes a message to the unit's log, which you can read in the unit panel or the editor's Log tab. Open a unit's code, replace it with the example, and press Save & run.",
    example: 'print("Hello, world!")\n',
    hints: ["Select a unit, click Edit code, delete everything, and type the example.", "Text goes in quotes: \"like this\". Press Save & run (Ctrl+Enter) and look at the Log tab."],
    goal: "A unit prints a message.",
    xp: 25,
    check: (ev) => ev.kind === "print",
  },
  {
    id: "variables",
    title: "Remember things with variables",
    teaches: "variables",
    explanation: "A variable is a name for a value. Write name = value to store something, then use the name later. Variables can hold numbers, text, lists, or game objects.",
    example: 'name = "Bob"\ncount = 3\nprint(name, "has", count, "apples")\n',
    hints: ["Pick a name, then '=', then the value: apples = 3", "Use the name inside print(): print(apples)"],
    goal: "A program stores a value in a variable and prints it.",
    xp: 25,
    check: (ev, f) => ev.kind === "print" && f.assigns,
  },
  {
    id: "move",
    title: "Make a unit move",
    teaches: "actions, coordinates",
    explanation: "Actions make the unit do something in the world. The program waits until the action is finished, then continues with the next line. me.x and me.y are the unit's position; move_to(x, y) walks there.",
    example: "move_to(me.x + 5, me.y)\nprint(\"I moved!\")\n",
    hints: ["move_to(x, y) needs two numbers: the tile to walk to.", "Try me.x + 5 to walk five tiles to the right of where the unit is now."],
    goal: "A unit's program completes move_to().",
    xp: 30,
    check: (ev) => ok(ev, "move_to"),
  },
  {
    id: "find",
    title: "Find and gather",
    teaches: "queries and objects",
    explanation: 'find_nearest("tree") looks around the unit and gives back the nearest tree as an object you can store in a variable. harvest(object) walks there and gathers until the unit is full, and deposit() takes the load home. (The editor will warn that the result might be None: the next lesson explains why.)',
    example: 'tree = find_nearest("tree")\nharvest(tree)\ndeposit()\nprint("Got some wood")\n',
    hints: ['Try other kinds: "stone", "gold", "berries".', "Use a unit that can gather, such as the Woodcutter."],
    goal: "A program uses find_nearest() and harvests something.",
    xp: 35,
    check: (ev, f) => ok(ev, "harvest") && f.usesFindNearest,
  },
  {
    id: "none",
    title: "Check before you use it",
    teaches: "None and if",
    explanation: 'When there is nothing in range, find_nearest() gives back None ("nothing"). Using None as a target stops the program with an error, so check first: if tree is not None: … The editor warns you when a check is missing.',
    example: 'tree = find_nearest("tree")\nif tree is not None:\n    harvest(tree)\n    deposit()\nelse:\n    print("No trees here")\n',
    hints: ["Lines that belong to the if are indented by 4 spaces.", "The line with 'if' ends with a colon ':'."],
    goal: "A program checks a result against None and then harvests.",
    xp: 35,
    check: (ev, f) => ok(ev, "harvest") && f.noneCheck,
  },
  {
    id: "loop",
    title: "Repeat forever",
    teaches: "while loops",
    explanation: "Programs end when they reach the last line. while alive: repeats the indented lines for as long as the unit exists, so the unit keeps working on its own.",
    example: 'while alive:\n    tree = find_nearest("tree")\n    if tree is not None:\n        harvest(tree)\n        deposit()\n    else:\n        explore()\n',
    hints: ["Everything inside the loop is indented under 'while alive:'.", "deposit() carries the cargo to your nearest storage building."],
    goal: "A program with while alive: deposits resources.",
    xp: 40,
    check: (ev, f) => ok(ev, "deposit") && f.whileAlive,
  },
  {
    id: "decide",
    title: "Make decisions",
    teaches: "if / else",
    explanation: "if … else lets the program choose. A common pattern: if the unit is full, deposit; otherwise gather more. inventory.is_full() is True when the unit cannot carry more.",
    example: 'while alive:\n    if inventory.is_full():\n        deposit()\n    else:\n        node = find_nearest("berries")\n        if node is not None:\n            harvest(node)\n        else:\n            explore()\n',
    hints: ["else: lines up with its if, and has its own indented lines.", "Try gathering berries for food."],
    goal: "A program uses if/else with inventory.is_full() and deposits.",
    xp: 40,
    check: (ev, f) => ok(ev, "deposit") && f.ifElse && f.checksFull,
  },
  {
    id: "functions",
    title: "Write your own function",
    teaches: "def and return",
    explanation: "A function is a named piece of code you can use again. def name(arg): defines it; calling name(value) runs it. return hands a result back.",
    example: 'def gather(kind):\n    node = find_nearest(kind)\n    if node is not None:\n        harvest(node)\n        deposit()\n        return True\n    return False\n\nwhile alive:\n    if not gather("tree"):\n        explore()\n',
    hints: ["Define functions at the top of the program, before the loop.", "Call your function at least once: gather(\"tree\")"],
    goal: "A program defines a function, calls it, and does an action.",
    xp: 45,
    check: (ev, f) => anyOk(ev) && f.calledFunctions.length > 0,
  },
  {
    id: "lists",
    title: "Loop over a list",
    teaches: "lists and for",
    explanation: 'A list holds several values: ["tree", "stone"]. for item in list: runs the indented lines once for each item.',
    example: 'while alive:\n    for kind in ["tree", "stone", "berries"]:\n        node = find_nearest(kind)\n        if node is not None:\n            harvest(node)\n            deposit()\n',
    hints: ["Square brackets make a list; items are separated by commas.", "The for line ends with a colon."],
    goal: "A program loops over a list with for and does an action.",
    xp: 45,
    check: (ev, f) => anyOk(ev) && f.forList,
  },
  {
    id: "build",
    title: "Build with code",
    teaches: "place() and build()",
    explanation: 'place("stockpile", x, y) puts down a construction site and pays for it; build(site) works on it until it is finished. find_build_spot("stockpile") finds a free place nearby.',
    example: 'spot = find_build_spot("stockpile")\nif spot is not None:\n    site = place("stockpile", spot)\n    if site is not None:\n        build(site)\n        print("Done!")\n',
    hints: ["Use your Builder: it builds fastest.", "A Stockpile costs wood; gather some first if place() fails (the log says why)."],
    goal: "A program places a building and finishes it with build().",
    xp: 60,
    check: (ev, f) => ok(ev, "build") && f.usesPlace,
  },
  {
    id: "handler",
    title: "React when things go wrong",
    teaches: "event handlers",
    explanation: "Actions can fail: a path is blocked, a tree is gone. If your program defines on_action_failed(action, reason), it is called whenever that happens, and the program then carries on.",
    example: 'def on_action_failed(action, reason):\n    print("Oops:", action, reason)\n\nmove_to(1000000, 0)\nprint("Still running")\n',
    hints: ["The function must be named exactly on_action_failed and take two arguments.", "Make something fail on purpose, such as walking somewhere impossible."],
    goal: "A program's on_action_failed handler is called.",
    xp: 50,
    check: (ev, f) => ev.kind === "handler" && f.handler,
  },
  {
    id: "hero",
    title: "Command your hero",
    teaches: "abilities",
    explanation: 'Recruit your hero at the Town Hall. Heroes have abilities: use_ability("name") uses one, ability_ready("name") tells you whether it is off cooldown. The hero\'s panel lists the names.',
    example: 'while alive:\n    if ability_ready("{ability}"):\n        use_ability("{ability}")\n    wait(5)\n',
    hints: ["Try another of your hero's abilities: type use_ability(\" to see the list.", "Abilities marked ⚔ only work when combat is enabled."],
    goal: "Your hero's program uses an ability (if it fails, the log says why).",
    xp: 50,
    check: (ev) => ev.kind === "action" && ev.name === "use_ability",
  },
];

/** A lesson's example for this player: "{ability}" becomes their hero's first support ability. */
export function lessonExample(l: LessonDef, heroAbilities: AbilityDef[]): string {
  // An ability that always works when ready (a buff), so the first try succeeds.
  const always = (x: AbilityDef): boolean => !x.combat && x.target === "none" && (x.effect.kind === "buff_units" || x.effect.kind === "self_buff");
  const a = heroAbilities.find(always) ?? heroAbilities.find((x) => !x.combat && x.target === "none") ?? heroAbilities[0];
  return l.example.replaceAll("{ability}", a?.id ?? "rally");
}

export function findLesson(id: string): LessonDef | undefined {
  return LESSONS.find((l) => l.id === id);
}
