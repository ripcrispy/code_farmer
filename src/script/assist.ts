/**
 * Language services for the in-game code editor: completions, signature help,
 * hover documentation and beginner-oriented warnings with quick fixes.
 *
 * Everything here is derived from the same registry the compiler and server use
 * (commands.ts) plus the game definitions, so suggestions never drift from what
 * the game actually accepts. Pure TypeScript with no DOM: the editor adapts it,
 * and tests exercise it directly.
 */
import { COMMANDS, CONSTANTS, NAMESPACES, OBJECT_ATTRIBUTES, commandDef, type CommandDef } from "./commands.ts";
import { KEYWORDS } from "./lexer.ts";
import { closestName, compileSource, EVENT_HANDLERS } from "./compiler.ts";
import type { Diagnostic } from "./ast.ts";
import { FIND_KIND_INFO, UNIT_DEFS, findUnitDef } from "../shared/defs/units.ts";
import { BUILDING_DEFS } from "../shared/defs/buildings.ts";
import { RESOURCE_TYPES } from "../shared/defs/resources.ts";
import { heroDefForType, type AbilityDef } from "../shared/defs/heroes.ts";

// ---------------------------------------------------------------- context

/** What the editor knows about the program being edited. */
export interface AssistContext {
  /** Type of the unit whose program this is (null: a library program for any unit). */
  unitType: string | null;
  /** The player's unlocks (e.g. "command:scan"). */
  unlocks: ReadonlySet<string>;
  combatEnabled: boolean;
  /** Lair monsters can be fought (even with combat off). */
  pveEnabled?: boolean;
  /** The player's race hero's abilities (shown on any unit, but only heroes may use them). */
  heroAbilities: AbilityDef[];
  /** Building types the player could place now (others are listed with a note). */
  buildable: ReadonlySet<string>;
}

export function defaultContext(over: Partial<AssistContext> = {}): AssistContext {
  return { unitType: null, unlocks: new Set(), combatEnabled: false, heroAbilities: [], buildable: new Set(Object.keys(BUILDING_DEFS)), ...over };
}

// ---------------------------------------------------------------- results

export type OptionKind = "command" | "keyword" | "variable" | "function" | "constant" | "namespace" | "attribute" | "value" | "snippet";

export interface AssistOption {
  label: string;
  /** Text inserted in place of the typed prefix. */
  insert: string;
  /** Cursor position inside `insert` after inserting (default: end). */
  cursor?: number;
  kind: OptionKind;
  /** Short detail shown next to the label (signature, type). */
  detail?: string;
  /** Longer description. */
  info?: string;
  /** Why this may not work here (locked, combat off, wrong unit); shown greyed. */
  note?: string;
  /** Lower ranks are listed first. */
  rank: number;
}

export interface CompletionResult {
  /** Range (offsets in the source) replaced by the chosen option. */
  from: number;
  to: number;
  options: AssistOption[];
  /** Completing inside a string argument (values) rather than code. */
  inString: boolean;
}

export interface SignatureHelp {
  name: string;
  /** The signature variant that fits the current argument. */
  label: string;
  params: string[];
  /** Index of the argument the cursor is in. */
  active: number;
  description: string;
  returns: string;
}

export interface HoverDoc {
  from: number;
  to: number;
  title: string;
  body: string;
}

export interface Fix {
  label: string;
  changes: { from: number; to: number; insert: string }[];
}

export interface AssistDiagnostic {
  from: number;
  to: number;
  line: number;
  severity: "error" | "warning";
  message: string;
  /** Beginner-friendly explanation. */
  hint?: string;
  fixes: Fix[];
}

// ---------------------------------------------------------------- shared helpers

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

/** The closest candidate to `word`, if it is close enough to be a likely typo (same rule as the compiler). */
export function suggest(word: string, candidates: Iterable<string>): string | null {
  return closestName(word, candidates);
}

/** How well `label` matches what was typed: 0 prefix, 1 word start, 2 substring, 3 subsequence, -1 no match. */
function matchScore(label: string, typed: string): number {
  if (typed === "") return 0;
  const l = label.toLowerCase();
  const t = typed.toLowerCase();
  if (l.startsWith(t)) return 0;
  if (l.split("_").some((part, i) => i > 0 && part.startsWith(t))) return 1;
  if (l.includes(t)) return 2;
  let i = 0;
  for (const ch of l) if (ch === t[i]) i++;
  return i === t.length && t.length >= 2 ? 3 : -1;
}

function lineStartOf(source: string, pos: number): number {
  return source.lastIndexOf("\n", pos - 1) + 1;
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** Offset of (1-based) line and column. */
export function offsetOf(source: string, line: number, col: number): number {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const nl = source.indexOf("\n", off);
    if (nl < 0) return source.length;
    off = nl + 1;
  }
  return Math.min(source.length, off + Math.max(0, col - 1));
}

// ---------------------------------------------------------------- scanning the line before the cursor

interface OpenCall {
  name: string;
  /** Owner for method calls (e.g. "inventory" in inventory.count(). */
  owner: string | null;
  argIndex: number;
  /** Offset just after "(". */
  open: number;
}

interface LineScan {
  inComment: boolean;
  /** Set while the cursor is inside a string literal. */
  string: { quote: string; start: number } | null;
  /** Innermost unclosed call before the cursor (on this line). */
  call: OpenCall | null;
  /** Identifier being typed and where it starts. */
  word: string;
  wordStart: number;
  /** Object before a "." immediately preceding the word, e.g. "me" in "me.h". */
  dotOwner: string | null;
}

function scanLine(source: string, pos: number): LineScan {
  const start = lineStartOf(source, pos);
  const text = source.slice(start, pos);
  const stack: (OpenCall | null)[] = [];
  let str: { quote: string; start: number } | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (str) {
      if (ch === "\\") i += 2;
      else {
        if (ch === str.quote) str = null;
        i++;
      }
      continue;
    }
    if (ch === "#") return { inComment: true, string: null, call: null, word: "", wordStart: pos, dotOwner: null };
    if (ch === '"' || ch === "'") {
      str = { quote: ch, start: start + i + 1 };
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      if (ch === "(") {
        // Name before "(" (possibly obj.name).
        const before = text.slice(0, i).replace(/\s+$/, "");
        const m = /([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/.exec(before);
        if (m) {
          const owner = m[2] ? (m[1] as string) : null;
          stack.push({ name: (m[2] ?? m[1]) as string, owner, argIndex: 0, open: start + i + 1 });
        } else stack.push(null);
      } else stack.push(null);
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      stack.pop();
      i++;
      continue;
    }
    if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top) top.argIndex++;
      i++;
      continue;
    }
    i++;
  }
  let call: OpenCall | null = null;
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k]) {
      call = stack[k] as OpenCall;
      break;
    }
  }
  const wm = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text);
  const word = str ? "" : (wm?.[0] ?? "");
  const wordStart = pos - word.length;
  let dotOwner: string | null = null;
  if (!str) {
    const before = text.slice(0, text.length - word.length);
    const dm = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(before);
    if (dm) dotOwner = dm[1] as string;
    else if (/[\])"']\s*\.\s*$/.test(before)) dotOwner = "?";
  }
  return { inComment: false, string: str, call, word, wordStart, dotOwner };
}

// ---------------------------------------------------------------- names defined by the program

export interface ProgramSymbols {
  variables: Map<string, number>;
  functions: Map<string, { line: number; params: string[] }>;
}

export function programSymbols(source: string): ProgramSymbols {
  const variables = new Map<string, number>();
  const functions = new Map<string, { line: number; params: string[] }>();
  const lines = source.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "");
    const ln = i + 1;
    const def = /^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(line);
    if (def) {
      const params = (def[2] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      functions.set(def[1] as string, { line: ln, params });
      for (const p of params) if (!variables.has(p)) variables.set(p, ln);
      return;
    }
    const asg = /^\s*([A-Za-z_]\w*)\s*(?:[+\-*/]?=)(?!=)/.exec(line);
    if (asg && !KEYWORDS.has(asg[1] as string) && !variables.has(asg[1] as string)) variables.set(asg[1] as string, ln);
    const fr = /^\s*for\s+([A-Za-z_]\w*)\s+in\b/.exec(line);
    if (fr && !variables.has(fr[1] as string)) variables.set(fr[1] as string, ln);
    const ex = /^\s*except\b.*\bas\s+([A-Za-z_]\w*)/.exec(line);
    if (ex && !variables.has(ex[1] as string)) variables.set(ex[1] as string, ln);
  });
  return { variables, functions };
}

// ---------------------------------------------------------------- availability

/** Capability a command needs from the unit, if any. */
const NEEDS_CAPABILITY: Record<string, string> = {
  harvest: "gather",
  build: "build",
  repair: "build",
  follow: "follow",
  guard: "guard",
  explore: "explore",
};

/** Why `cmd` may not work for this program, or null if it should. */
export function availability(cmd: CommandDef, ctx: AssistContext): string | null {
  if (cmd.requires && !ctx.unlocks.has(cmd.requires)) return `Locked. ${cmd.lockedHint ?? ""}`.trim();
  if (cmd.category === "Combat" && !ctx.combatEnabled && !ctx.pveEnabled && cmd.name !== "in_contested_zone") return "Combat is off on this server";
  const unit = ctx.unitType ? findUnitDef(ctx.unitType) : undefined;
  if (cmd.category === "Hero" && cmd.name !== "hero" && unit && !unit.hero) return "Only your hero can use this";
  const cap = NEEDS_CAPABILITY[cmd.name];
  if (cap && unit && !unit.capabilities.includes(cap as never)) return `A ${unit.name} cannot do this`;
  if ((cmd.name === "deposit" || cmd.name === "withdraw" || cmd.name === "deposit_at_nearest_storage") && unit && unit.capacity <= 0) return `A ${unit.name} carries nothing`;
  return null;
}

/** Commands beginners use most, listed first among equal matches. */
const COMMON = ["find_nearest", "harvest", "deposit", "move_to", "build", "print", "wait", "explore", "place", "train_unit", "withdraw", "attack", "use_ability", "follow"];

// ---------------------------------------------------------------- values for string arguments

interface ValueOption {
  value: string;
  info: string;
  note?: string;
}

function valueOptions(call: OpenCall, ctx: AssistContext): ValueOption[] | null {
  const name = call.owner ? `${call.owner}.${call.name}` : call.name;
  const i = call.argIndex;
  const resources = (): ValueOption[] => RESOURCE_TYPES.map((r) => ({ value: r, info: `the ${r} resource` }));
  switch (name) {
    case "find_nearest":
    case "scan":
      if (i !== 0) return null;
      return Object.entries(FIND_KIND_INFO).map(([value, info]) => ({
        value,
        info,
        note:
          (value === "enemy" || value === "enemy_building") && !ctx.combatEnabled
            ? "Combat is off on this server: nothing will be found"
            : (value === "monster" || value === "boss") && !ctx.combatEnabled && !ctx.pveEnabled
              ? "Fighting is off on this server: nothing will be found"
              : undefined,
      }));
    case "place":
    case "find_build_spot":
      if (i !== 0) return null;
      return Object.values(BUILDING_DEFS)
        .filter((b) => b.placeable)
        .map((b) => ({
          value: b.type,
          info: `${b.name}: ${b.description}`,
          note: ctx.buildable.has(b.type) ? undefined : "Not available to you yet (see the build menu)",
        }));
    case "train_unit":
    case "count_units":
      if (i !== 0) return null;
      return Object.values(UNIT_DEFS)
        .filter((u) => (name === "train_unit" ? u.cost !== null : !u.creature || true) && !(name === "train_unit" && u.hero))
        .map((u) => ({ value: u.type, info: `${u.name}: ${u.description}`, note: u.requiresCombat && !ctx.combatEnabled && !ctx.pveEnabled ? "Fighting is off on this server" : undefined }));
    case "withdraw":
    case "stock":
    case "inventory.count":
      return i === 0 ? resources() : null;
    case "use_ability":
    case "ability_ready": {
      if (i !== 0) return null;
      const unit = ctx.unitType ? findUnitDef(ctx.unitType) : undefined;
      const own = ctx.unitType ? (heroDefForType(ctx.unitType)?.abilities ?? null) : null;
      const list = own ?? ctx.heroAbilities;
      return list.map((a) => ({
        value: a.id,
        info: `${a.name}: ${a.description}`,
        note: a.combat && !ctx.combatEnabled && !ctx.pveEnabled ? "Needs combat, which is off on this server" : unit && !unit.hero ? "Only your hero can use this" : undefined,
      }));
    }
    case "train_creature":
      if (i !== 1) return null;
      return [{ value: "guard", info: "Stand guard at a spot (tamed wolves)" }];
    default:
      return null;
  }
}

/** Commands whose first argument is one of a fixed set of strings (completion inserts the quotes). */
const STRING_FIRST = new Set(["find_nearest", "scan", "place", "find_build_spot", "train_unit", "withdraw", "stock", "use_ability", "ability_ready"]);

// ---------------------------------------------------------------- keywords and snippets

export const KEYWORD_DOCS: Record<string, string> = {
  if: "Run the indented lines below only when a condition is true. End the line with a colon, e.g. `if inventory.is_full():`.",
  elif: "Another condition, checked only if the previous `if`/`elif` was false.",
  else: "Lines to run when no `if`/`elif` condition above was true.",
  while: "Repeat the indented lines as long as a condition is true. `while alive:` is a unit's main loop.",
  for: "Repeat the indented lines once for each item, e.g. `for r in [\"wood\", \"stone\"]:`.",
  in: "Used in `for x in list:` and to test membership: `\"wood\" in kinds`.",
  def: "Define your own function: `def name(arg):` followed by indented lines. Call it with `name(value)`.",
  return: "Leave the current function and hand back a value.",
  break: "Leave the innermost loop immediately.",
  continue: "Skip to the next round of the innermost loop.",
  pass: "Do nothing (a placeholder where Python needs at least one line).",
  and: "True only if both sides are true.",
  or: "True if either side is true.",
  not: "Turns true into false and false into true.",
  is: "Compare with None: `if node is not None:`.",
  True: "The true value.",
  False: "The false value.",
  None: "\"Nothing\". Queries such as find_nearest() return None when they find nothing; check with `is not None` before using the result.",
  try: "Run lines that might fail; if one does, the `except:` block runs instead of stopping the program.",
  except: "Lines that run when something in the `try:` block failed.",
  as: "Name the error in `except Exception as e:`.",
};

interface Snippet {
  label: string;
  /** Lines; "$" marks the cursor. The first line is inserted at the cursor, others re-indented. */
  lines: string[];
  info: string;
  /** Typed words that suggest this snippet. */
  triggers: string[];
}

const SNIPPETS: Snippet[] = [
  { label: "while alive: (main loop)", lines: ["while alive:", "    $"], info: "A unit's main loop: repeats for as long as the unit exists.", triggers: ["while", "loop", "alive"] },
  { label: "if … is not None:", lines: ["if $ is not None:", "    "], info: "Check that a query found something before using it.", triggers: ["if", "none", "check"] },
  { label: "if / else", lines: ["if $:", "    ", "else:", "    "], info: "Do one thing or another.", triggers: ["if", "else"] },
  { label: "for item in list:", lines: ["for $ in []:", "    "], info: "Repeat for each item of a list.", triggers: ["for", "loop", "each"] },
  { label: "for i in range(n):", lines: ["for i in range($):", "    "], info: "Repeat n times (i counts 0, 1, 2…).", triggers: ["for", "range", "repeat"] },
  { label: "def function():", lines: ["def $():", "    "], info: "Define your own function.", triggers: ["def", "function"] },
  { label: "try / except", lines: ["try:", "    $", "except:", "    "], info: "Keep going when something fails.", triggers: ["try", "except", "error"] },
  { label: "def on_action_failed(action, reason):", lines: ["def on_action_failed(action, reason):", "    print(action, \"failed:\", reason)$"], info: "Event handler: runs whenever an action fails (e.g. a path is blocked).", triggers: ["on", "def", "failed", "handler", "event"] },
  { label: "def on_attacked(attacker):", lines: ["def on_attacked(attacker):", "    $"], info: "Event handler: runs when this unit is hit (combat servers).", triggers: ["on", "def", "attacked", "handler", "event"] },
];

function snippetOption(s: Snippet, indent: string, rank: number): AssistOption {
  const text = s.lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
  const cursor = text.indexOf("$");
  return { label: s.label, insert: text.replace("$", ""), cursor: cursor >= 0 ? cursor : undefined, kind: "snippet", info: s.info, rank };
}

// ---------------------------------------------------------------- completions

/** Attributes and methods available after `name.`. */
function memberOptions(owner: string, ctx: AssistContext, symbols: ProgramSymbols): AssistOption[] {
  void ctx;
  if (Object.hasOwn(NAMESPACES, owner)) {
    return (NAMESPACES[owner] ?? []).map((m) => ({
      label: m.name,
      insert: m.type === "method" ? (m.name === "count" ? `${m.name}("")` : `${m.name}()`) : m.name,
      cursor: m.type === "method" ? (m.name === "count" ? m.name.length + 2 : m.name.length + 2) : undefined,
      kind: "attribute" as const,
      detail: m.signature,
      info: m.description,
      rank: 0,
    }));
  }
  const out: AssistOption[] = Object.entries(OBJECT_ATTRIBUTES).map(([name, info]) => ({ label: name, insert: name, kind: "attribute" as const, detail: `${owner}.${name}`, info: `${info} (game objects from queries)`, rank: 0 }));
  const listish = symbols.variables.has(owner) || owner === "?";
  if (listish) {
    out.push(
      { label: "append", insert: "append()", cursor: 7, kind: "attribute", detail: "list.append(x)", info: "Add an item to the end of a list.", rank: 2 },
      { label: "pop", insert: "pop()", cursor: 4, kind: "attribute", detail: "list.pop() / dict.pop(key)", info: "Remove and return the last item (or the given key of a dict).", rank: 2 },
      { label: "get", insert: "get()", cursor: 4, kind: "attribute", detail: "dict.get(key, default)", info: "Value for a key, or the default if missing.", rank: 2 },
      { label: "keys", insert: "keys()", kind: "attribute", detail: "dict.keys()", info: "List of a dictionary's keys.", rank: 2 },
      { label: "values", insert: "values()", kind: "attribute", detail: "dict.values()", info: "List of a dictionary's values.", rank: 2 },
      { label: "items", insert: "items()", kind: "attribute", detail: "dict.items()", info: "List of [key, value] pairs.", rank: 2 },
    );
  }
  return out;
}

/**
 * Completions at `pos`. Returns null when there is nothing sensible to offer
 * (inside a comment, or an empty prefix without `explicit`).
 */
export function complete(source: string, pos: number, ctx: AssistContext, explicit = false): CompletionResult | null {
  const scan = scanLine(source, pos);
  if (scan.inComment) return null;
  const symbols = programSymbols(source);
  // Inside a string argument with a known set of values.
  if (scan.string) {
    if (!scan.call) return null;
    const values = valueOptions(scan.call, ctx);
    if (!values) return null;
    const typed = source.slice(scan.string.start, pos);
    const closing = source[pos] === scan.string.quote ? 0 : 1;
    const options = values
      .map((v, i) => ({ v, m: matchScore(v.value, typed), i }))
      .filter((x) => x.m >= 0)
      .map(({ v, m, i }) => ({
        label: v.value,
        insert: v.value + (closing ? scan.string!.quote : ""),
        cursor: v.value.length + closing,
        kind: "value" as const,
        info: v.info,
        note: v.note,
        // Keep the meaningful order of the list (tree, stone, gold…) among equal matches.
        rank: m * 10 + (v.note ? 5 : 0) + i / 100,
      }));
    return options.length ? { from: scan.string.start, to: pos, options: sortOptions(options), inString: true } : null;
  }
  // After "name."
  if (scan.dotOwner) {
    const options = memberOptions(scan.dotOwner, ctx, symbols)
      .map((o) => ({ o, m: matchScore(o.label, scan.word) }))
      .filter((x) => x.m >= 0)
      .map(({ o, m }) => ({ ...o, rank: o.rank + m * 10 }));
    return options.length ? { from: scan.wordStart, to: pos, options: sortOptions(options), inString: false } : null;
  }
  if (!scan.word && !explicit) return null;
  const typed = scan.word;
  const line = source.slice(lineStartOf(source, pos), pos);
  const atLineStart = /^\s*[A-Za-z_]*$/.test(line);
  const indent = indentOf(line);
  const options: AssistOption[] = [];
  const add = (o: Omit<AssistOption, "rank"> & { rank?: number }): void => {
    const m = matchScore(o.label, typed);
    if (m < 0) return;
    options.push({ ...o, rank: (o.rank ?? 0) + m * 10 });
  };
  for (const c of COMMANDS) {
    const note = availability(c, ctx) ?? undefined;
    const noArgs = c.maxArgs === 0;
    const quoted = STRING_FIRST.has(c.name);
    const insert = noArgs ? `${c.name}()` : quoted ? `${c.name}("")` : `${c.name}()`;
    const cursor = noArgs ? insert.length : c.name.length + (quoted ? 2 : 1);
    const common = COMMON.indexOf(c.name);
    add({ label: c.name, insert, cursor, kind: "command", detail: c.signature, info: `${c.description} Returns: ${c.returns}.`, note, rank: (note ? 6 : 0) + (common >= 0 ? 0 : 1) + (c.kind === "builtin" ? 2 : 0) });
  }
  for (const [name, fn] of symbols.functions) {
    if (name === typed) continue;
    add({ label: name, insert: fn.params.length ? `${name}()` : `${name}()`, cursor: name.length + 1 + (fn.params.length ? 0 : 1), kind: "function", detail: `${name}(${fn.params.join(", ")})`, info: `Your function (line ${fn.line}).`, rank: 0 });
  }
  for (const [name, ln] of symbols.variables) {
    if (name === typed) continue;
    add({ label: name, insert: name, kind: "variable", info: `Your variable (first set on line ${ln}).`, rank: 0 });
  }
  for (const [name, info] of Object.entries(CONSTANTS)) add({ label: name, insert: name, kind: "constant", info, rank: 1 });
  for (const ns of Object.keys(NAMESPACES)) add({ label: ns, insert: ns, kind: "namespace", info: ns === "me" ? "This unit: me.x, me.y, me.hp, me.max_hp, me.type, me.id." : "This unit's cargo: inventory.is_full(), inventory.count(\"wood\")…", rank: 1 });
  for (const kw of KEYWORDS) add({ label: kw, insert: kw === "True" || kw === "False" || kw === "None" ? kw : `${kw} `, kind: "keyword", info: KEYWORD_DOCS[kw], rank: 3 });
  if (atLineStart) {
    for (const s of SNIPPETS) {
      if (typed && !s.triggers.some((t) => t.startsWith(typed.toLowerCase()) || typed.toLowerCase().startsWith(t))) continue;
      options.push({ ...snippetOption(s, indent, 2), rank: 2 });
    }
  }
  if (!options.length) return null;
  return { from: scan.wordStart, to: pos, options: sortOptions(options), inString: false };
}

function sortOptions(options: AssistOption[]): AssistOption[] {
  return options.sort((a, b) => a.rank - b.rank || a.label.length - b.label.length || a.label.localeCompare(b.label)).slice(0, 60);
}

// ---------------------------------------------------------------- signature help

function splitParams(sig: string, name: string): string[][] {
  return sig.split(" / ").map((variant) => {
    const m = new RegExp(`${name.replace(".", "\\.")}\\(([^)]*)\\)`).exec(variant);
    const inner = (m?.[1] ?? "").trim();
    if (!inner || inner === "...") return inner === "..." ? ["..."] : [];
    // Split on commas not inside brackets ("range(start, stop[, step])").
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of inner) {
      if (ch === "[") depth++;
      if (ch === "]") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  });
}

export function signatureAt(source: string, pos: number): SignatureHelp | null {
  const scan = scanLine(source, pos);
  if (scan.inComment || !scan.call) return null;
  const { name, owner, argIndex } = scan.call;
  if (owner && Object.hasOwn(NAMESPACES, owner)) {
    const m = (NAMESPACES[owner] ?? []).find((x) => x.name === name);
    if (!m) return null;
    const params = splitParams(m.signature, `${owner}.${name}`)[0] ?? [];
    return { name: `${owner}.${name}`, label: m.signature, params, active: argIndex, description: m.description, returns: "" };
  }
  if (owner) return null;
  const c = commandDef(name);
  if (c) {
    const variants = splitParams(c.signature, name);
    const sigs = c.signature.split(" / ");
    let vi = variants.findIndex((v) => v.length > argIndex || v[0] === "...");
    if (vi < 0) vi = variants.length - 1;
    return { name, label: sigs[vi] ?? c.signature, params: variants[vi] ?? [], active: argIndex, description: c.description, returns: c.returns };
  }
  const fn = programSymbols(source).functions.get(name);
  if (fn) return { name, label: `${name}(${fn.params.join(", ")})`, params: fn.params, active: argIndex, description: `Your function (line ${fn.line}).`, returns: "" };
  return null;
}

// ---------------------------------------------------------------- hover

export function hoverAt(source: string, pos: number, ctx: AssistContext): HoverDoc | null {
  // Word under the cursor.
  let a = pos;
  let b = pos;
  while (a > 0 && /[A-Za-z0-9_]/.test(source[a - 1] as string)) a--;
  while (b < source.length && /[A-Za-z0-9_]/.test(source[b] as string)) b++;
  if (a === b) return null;
  const word = source.slice(a, b);
  if (/^\d/.test(word)) return null;
  const lineStart = lineStartOf(source, a);
  const before = source.slice(lineStart, a);
  if (before.includes("#")) return null;
  // Inside a string: explain the value if we know it.
  const quotesBefore = (before.match(/["']/g) ?? []).length;
  if (quotesBefore % 2 === 1) {
    const scan = scanLine(source, a);
    const vals = scan.call ? valueOptions(scan.call, ctx) : null;
    const v = vals?.find((x) => x.value === word);
    return v ? { from: a, to: b, title: `"${word}"`, body: v.info + (v.note ? `\n${v.note}` : "") } : null;
  }
  const dm = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(before);
  if (dm) {
    const owner = dm[1] as string;
    const m = Object.hasOwn(NAMESPACES, owner) ? NAMESPACES[owner]?.find((x) => x.name === word) : undefined;
    if (m) return { from: a, to: b, title: m.signature, body: m.description };
    const oa = Object.hasOwn(OBJECT_ATTRIBUTES, word) ? OBJECT_ATTRIBUTES[word] : undefined;
    if (oa) return { from: a, to: b, title: `.${word}`, body: `${oa} (on game objects returned by queries such as find_nearest()).` };
    return null;
  }
  const c = commandDef(word);
  if (c) {
    const note = availability(c, ctx);
    return { from: a, to: b, title: c.signature, body: `${c.description}\nReturns: ${c.returns}.${c.kind === "action" ? "\nAn action: the unit carries it out and the program waits until it is done." : ""}${note ? `\n⚠ ${note}` : ""}` };
  }
  if (KEYWORD_DOCS[word]) return { from: a, to: b, title: word, body: KEYWORD_DOCS[word] as string };
  if (Object.hasOwn(CONSTANTS, word)) return { from: a, to: b, title: word, body: CONSTANTS[word] as string };
  if (Object.hasOwn(NAMESPACES, word)) return { from: a, to: b, title: word, body: (NAMESPACES[word] ?? []).map((m) => `${m.signature}: ${m.description}`).join("\n") };
  if (Object.hasOwn(EVENT_HANDLERS, word)) return { from: a, to: b, title: word, body: word === "on_attacked" ? "Event handler: define it to react when this unit is hit." : "Event handler: define it to react when an action fails." };
  const sym = programSymbols(source);
  const fn = sym.functions.get(word);
  if (fn) return { from: a, to: b, title: `${word}(${fn.params.join(", ")})`, body: `Your function, defined on line ${fn.line}.` };
  const v = sym.variables.get(word);
  if (v) return { from: a, to: b, title: word, body: `Your variable, first set on line ${v}.` };
  return null;
}

// ---------------------------------------------------------------- diagnostics with explanations and fixes

/** Plain-language explanations of compiler errors, with quick fixes where the fix is clear. */
function explain(d: Diagnostic, source: string): { hint?: string; fixes?: Fix[] } {
  const lines = source.split("\n");
  const lineText = lines[d.line - 1] ?? "";
  const ls = offsetOf(source, d.line, 1);
  const le = ls + lineText.length;
  const m = d.message;
  if (/^Expected ':'/.test(m)) {
    const code = lineText.replace(/\s*#.*$/, "").replace(/\s+$/, "");
    return { hint: "Lines that start a block (if, elif, else, while, for, def, try, except) end with a colon ':'.", fixes: [{ label: "Add ':' at the end of the line", changes: [{ from: ls + code.length, to: ls + code.length, insert: ":" }] }] };
  }
  if (/Expected an indented block/.test(m)) {
    return { hint: "After a line ending in ':' the next lines must be indented (4 spaces) to belong to it.", fixes: [{ label: "Indent this line", changes: [{ from: ls, to: ls, insert: "    " }] }] };
  }
  if (/Unexpected indentation/.test(m) || /Unindent does not match/.test(m)) {
    // Line up with the previous non-blank line.
    let prev = "";
    for (let i = d.line - 2; i >= 0; i--) {
      const t = lines[i] ?? "";
      if (t.trim() && !t.trim().startsWith("#")) {
        prev = t;
        break;
      }
    }
    const target = indentOf(prev);
    const cur = indentOf(lineText);
    const fixes: Fix[] = [];
    if (target !== cur) fixes.push({ label: `Line up with the line above (${target.length} spaces)`, changes: [{ from: ls, to: ls + cur.length, insert: target }] });
    return { hint: "Indentation shows which block a line belongs to. Lines in the same block need exactly the same indentation.", fixes };
  }
  if (/Semicolons are not supported/.test(m)) {
    const ind = indentOf(lineText);
    const parts = lineText.trim().split(";").map((p) => p.trim()).filter(Boolean);
    return { fixes: [{ label: "Put each statement on its own line", changes: [{ from: ls, to: le, insert: parts.map((p) => ind + p).join("\n") }] }] };
  }
  const unk = /^Unknown name '([^']+)'\. Did you mean '([^']+)'\?/.exec(m);
  if (unk) {
    const from = offsetOf(source, d.line, d.col);
    return { hint: "Names must match a command, one of your variables, or a function you defined, letter for letter.", fixes: [{ label: `Change to '${unk[2]}'`, changes: [{ from, to: from + (unk[1] as string).length, insert: unk[2] as string }] }] };
  }
  if (/^Unknown name/.test(m)) return { hint: "Names must match a command, one of your variables, or a function you defined. Variables must be set (name = value) before they are used." };
  if (/is locked/.test(m)) return { hint: "Locked commands become available through discoveries (investigate ruins with your Scout)." };
  if (/Unterminated string/.test(m)) return { hint: "Text must start and end with the same quote mark: \"wood\" or 'wood'.", fixes: [{ label: "Close the string", changes: [{ from: le, to: le, insert: lineText.includes("'") && !lineText.includes('"') ? "'" : '"' }] }] };
  if (/Unclosed bracket|Unmatched/.test(m)) return { hint: "Every '(' needs a matching ')', every '[' a ']' and every '{' a '}'." };
  if (/expects? (at least|at most|exactly|\d)/.test(m) || /argument/.test(m)) return { hint: "Hover the command (or type '(' after it) to see which arguments it takes." };
  return {};
}

/** Query commands that return None when they find nothing. */
const MAYBE_NONE = new Set(["find_nearest", "last_attacker", "hero", "find_build_spot"]);
/** Commands that do something (so a loop calling one does not spin). */
const ACTIONS = new Set(COMMANDS.filter((c) => c.kind === "action").map((c) => c.name));

interface Block {
  start: number;
  end: number;
}

/** Lines (0-based, inclusive) after `i` that belong to the block opened or continued at indent `ind`. */
function blockAfter(lines: string[], i: number, ind: number, deeper: boolean): Block {
  let end = i;
  for (let k = i + 1; k < lines.length; k++) {
    const t = lines[k] as string;
    if (!t.trim() || t.trim().startsWith("#")) continue;
    const w = indentOf(t).length;
    if (deeper ? w <= ind : w < ind) break;
    end = k;
  }
  return { start: i + 1, end };
}

/** Beginner warnings that the compiler cannot report (the program is valid but will misbehave). */
export function warnings(source: string, ctx: AssistContext): AssistDiagnostic[] {
  const out: AssistDiagnostic[] = [];
  const lines = source.split("\n");
  const off = (li: number): number => offsetOf(source, li + 1, 1);
  lines.forEach((raw, i) => {
    const code = raw.replace(/#.*$/, "");
    // 1. A query result that may be None is used without a check.
    const asg = /^(\s*)([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/.exec(code);
    if (asg && MAYBE_NONE.has(asg[3] as string)) {
      const ind = (asg[1] as string).length;
      const v = asg[2] as string;
      const blk = blockAfter(lines, i, ind, false);
      const vRe = new RegExp(`\\b${v}\\b`);
      const guardRe = new RegExp(`\\b${v}\\s+is\\s+(not\\s+)?None\\b|\\bif\\s+(not\\s+)?${v}\\s*:|\\bwhile\\s+${v}\\b|\\bexists\\(\\s*${v}\\s*\\)|\\b${v}\\s*(==|!=)\\s*None`);
      let used = -1;
      let lastUse = -1;
      for (let k = blk.start; k <= blk.end; k++) {
        const t = (lines[k] as string).replace(/#.*$/, "");
        if (guardRe.test(t)) break;
        // Reassigned before use: stop looking.
        if (new RegExp(`^\\s*${v}\\s*=(?!=)`).test(t)) break;
        if (vRe.test(t)) {
          if (used < 0) used = k;
          lastUse = k;
        }
      }
      if (used >= 0) {
        const name = asg[3] as string;
        const from = off(i) + ind;
        const indStr = asg[1] as string;
        // Fix: wrap the lines up to the last use in "if v is not None:".
        const changes = [{ from: off(i) + raw.length, to: off(i) + raw.length, insert: `\n${indStr}if ${v} is not None:` }];
        for (let k = i + 1; k <= lastUse; k++) {
          if ((lines[k] as string).trim()) changes.push({ from: off(k), to: off(k), insert: "    " });
        }
        out.push({
          from,
          to: from + v.length,
          line: i + 1,
          severity: "warning",
          message: `${name}() gives None when it finds nothing, and '${v}' is used on line ${used + 1} without checking.`,
          hint: `Check first with 'if ${v} is not None:', otherwise the program stops with an error when nothing is found.`,
          fixes: [{ label: `Wrap the lines that use '${v}' in 'if ${v} is not None:'`, changes }],
        });
      }
    }
    // 2. A forever-loop that never performs an action spins through its instruction budget.
    const loop = /^(\s*)while\s+(alive|True)\s*:/.exec(code);
    if (loop) {
      const ind = (loop[1] as string).length;
      const blk = blockAfter(lines, i, ind, true);
      const body = lines.slice(blk.start, blk.end + 1).join("\n").replace(/#.*$/gm, "");
      const fns = programSymbols(source).functions;
      const callsAction = [...ACTIONS].some((a) => new RegExp(`\\b${a}\\s*\\(`).test(body)) || [...fns.keys()].some((f) => new RegExp(`\\b${f}\\s*\\(`).test(body));
      if (!callsAction && blk.end >= blk.start) {
        const lastLine = lines[blk.end] as string;
        const bodyIndent = indentOf(lines[blk.start] ?? "") || (loop[1] as string) + "    ";
        const from = off(i) + ind;
        out.push({
          from,
          to: from + 5,
          line: i + 1,
          severity: "warning",
          message: "This loop never does an action (such as harvest(), move_to() or wait()), so it repeats instantly and uses up the unit's instruction budget every tick.",
          hint: "Add an action, or wait(1) to pause each time round.",
          fixes: [{ label: "Add wait(1) at the end of the loop", changes: [{ from: off(blk.end) + lastLine.length, to: off(blk.end) + lastLine.length, insert: `\n${bodyIndent}wait(1)` }] }],
        });
      }
    }
    // 3. Unknown string values for commands that only accept certain words.
    const strRe = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(\s*(["'])([^"']*)\2/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(code)) !== null) {
      const full = m[1] as string;
      const [owner, name] = full.includes(".") ? (full.split(".") as [string, string]) : [null, full];
      const vals = valueOptions({ name, owner, argIndex: 0, open: 0 }, ctx);
      if (!vals) continue;
      const value = m[3] as string;
      // Still being typed: no warning for an empty word.
      if (value === "" || vals.some((v) => v.value === value)) continue;
      const s = suggest(value, vals.map((v) => v.value));
      const from = off(i) + (m.index as number) + m[0].length - value.length - 1;
      out.push({
        from,
        to: from + value.length,
        line: i + 1,
        severity: "warning",
        message: `"${value}" is not something ${full}() understands.${s ? ` Did you mean "${s}"?` : ""}`,
        hint: `Type ${full}(" to see the choices.`,
        fixes: s ? [{ label: `Change to "${s}"`, changes: [{ from, to: from + value.length, insert: s }] }] : [],
      });
    }
  });
  return out;
}

/** Compiler errors (with explanations and fixes) followed by beginner warnings. */
export function diagnose(source: string, ctx: AssistContext): AssistDiagnostic[] {
  const r = compileSource(source, { unlocks: ctx.unlocks });
  const out: AssistDiagnostic[] = [];
  if (!r.ok) {
    for (const d of r.diagnostics) {
      const from = offsetOf(source, d.line, d.col);
      const lineEnd = source.indexOf("\n", from);
      const wm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(from));
      const to = wm ? from + wm[0].length : Math.max(from + 1, Math.min(lineEnd < 0 ? source.length : lineEnd, from + 1));
      const ex = explain(d, source);
      out.push({ from, to: Math.min(to, source.length), line: d.line, severity: d.severity, message: d.message, hint: ex.hint, fixes: ex.fixes ?? [] });
    }
  }
  return [...out, ...warnings(source, ctx)];
}

/** Apply a fix's changes to the source (changes are given in original offsets). */
export function applyFix(source: string, fix: Fix): string {
  const changes = [...fix.changes].sort((a, b) => b.from - a.from);
  let s = source;
  for (const c of changes) s = s.slice(0, c.from) + c.insert + s.slice(c.to);
  return s;
}

export { IDENT as _IDENT };
