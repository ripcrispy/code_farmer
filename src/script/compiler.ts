import { ScriptSyntaxError, type Diagnostic, type Expr, type Pos, type Stmt } from "./ast.ts";
import { COMMANDS, CONSTANTS, commandDef, isConstant, isKnownGlobal, isNamespace, NAMESPACES } from "./commands.ts";
import { parse } from "./parser.ts";
import { UserFn, type Value } from "./values.ts";

/** Opcodes. Kept as plain numeric constants (no TS enum) so the module is erasable TypeScript. */
export const Op = {
  CONST: 0,
  LOAD_GLOBAL: 1,
  STORE_GLOBAL: 2,
  LOAD_LOCAL: 3,
  STORE_LOCAL: 4,
  BIN: 5,
  UN: 6,
  CMP: 7,
  JUMP: 8,
  JUMP_IF_FALSE: 9,
  JUMP_IF_FALSE_OR_POP: 10,
  JUMP_IF_TRUE_OR_POP: 11,
  CALL: 12,
  GET_ATTR: 13,
  GET_INDEX: 14,
  SET_INDEX: 15,
  BUILD_LIST: 16,
  GET_ITER: 17,
  FOR_ITER: 18,
  POP: 19,
  RETURN: 20,
  DUP2: 21,
  BUILD_DICT: 22,
  SETUP_EXCEPT: 23,
  POP_EXCEPT: 24,
} as const;

/** Event-handler functions the runtime calls by name, with their required parameter counts. */
export const EVENT_HANDLERS: Record<string, number> = { on_action_failed: 2, on_attacked: 1 };
export type OpCode = (typeof Op)[keyof typeof Op];

export interface Instr {
  op: OpCode;
  /** Operand: constant value, name, slot, jump target, argc or operator. */
  a?: Value | number | string;
  line: number;
  col: number;
}

export interface CodeObject {
  name: string;
  params: string[];
  localNames: string[];
  code: Instr[];
}

export interface CompiledProgram {
  /** Language version the program was compiled for; stored with saved scripts. */
  languageVersion: number;
  main: CodeObject;
  functions: Map<string, CodeObject>;
  source: string;
}

export const LANGUAGE_VERSION = 1;

export type CompileResult = { ok: true; program: CompiledProgram } | { ok: false; diagnostics: Diagnostic[] };

export interface CompileOptions {
  /** Unlock ids the player has (e.g. "command:scan"). Locked commands are compile errors. */
  unlocks?: ReadonlySet<string> | readonly string[];
}

/** Parse and compile; never throws for user errors. */
export function compileSource(source: string, opts: CompileOptions = {}): CompileResult {
  try {
    const ast = parse(source);
    return { ok: true, program: new Compiler(source, new Set(opts.unlocks ?? [])).compileProgram(ast) };
  } catch (e) {
    if (e instanceof ScriptSyntaxError) {
      return { ok: false, diagnostics: [{ message: e.message, line: e.line, col: e.col, severity: "error" }] };
    }
    if (e instanceof RangeError) {
      return { ok: false, diagnostics: [{ message: "Program is nested too deeply", line: 1, col: 1, severity: "error" }] };
    }
    throw e;
  }
}

interface LoopCtx {
  breaks: number[];
  continueTarget: number;
  /** Number of enclosing try blocks when the loop started. */
  tryDepth: number;
}

interface FnCtx {
  code: CodeObject;
  locals: Map<string, number> | null; // null = module scope
  loops: LoopCtx[];
  tryDepth: number;
}

class Compiler {
  private globals = new Set<string>();
  private functions = new Map<string, CodeObject>();
  private fnArity = new Map<string, number>();
  private readonly source: string;
  private readonly unlocks: ReadonlySet<string>;
  constructor(source: string, unlocks: ReadonlySet<string>) {
    this.source = source;
    this.unlocks = unlocks;
  }

  compileProgram(body: Stmt[]): CompiledProgram {
    // Pass 1: collect top-level globals and function signatures.
    for (const s of body) {
      if (s.k === "def") {
        if (this.fnArity.has(s.name)) this.err(s.pos, `Function '${s.name}' is defined twice`);
        const need = Object.hasOwn(EVENT_HANDLERS, s.name) ? EVENT_HANDLERS[s.name] : undefined;
        if (need !== undefined && s.params.length !== need) {
          this.err(s.pos, `Event handler ${s.name}() must take exactly ${need} parameters`);
        }
        this.checkAssignable(s.name, s.pos);
        this.fnArity.set(s.name, s.params.length);
        this.globals.add(s.name);
      }
    }
    collectAssigned(body, this.globals);

    const main: CodeObject = { name: "<main>", params: [], localNames: [], code: [] };
    const ctx: FnCtx = { code: main, locals: null, loops: [], tryDepth: 0 };
    // Pass 2: compile function bodies first so they are available as constants.
    for (const s of body) {
      if (s.k === "def") this.compileFunction(s);
    }
    for (const s of body) this.stmt(s, ctx);
    const end = body.length > 0 ? lastPos(body) : { line: 1, col: 1 };
    this.emit(ctx, Op.CONST, end, null);
    this.emit(ctx, Op.RETURN, end);
    return { languageVersion: LANGUAGE_VERSION, main, functions: this.functions, source: this.source };
  }

  private checkAssignable(name: string, pos: Pos): void {
    if (commandDef(name) || isNamespace(name) || isConstant(name)) {
      this.err(pos, `'${name}' is a built-in name and cannot be redefined`);
    }
  }

  private compileFunction(s: Extract<Stmt, { k: "def" }>): void {
    const locals = new Map<string, number>();
    for (const p of s.params) {
      this.checkAssignable(p, s.pos);
      locals.set(p, locals.size);
    }
    const assigned = new Set<string>();
    collectAssigned(s.body, assigned);
    for (const n of assigned) {
      this.checkAssignable(n, s.pos);
      if (!locals.has(n)) locals.set(n, locals.size);
    }
    const code: CodeObject = { name: s.name, params: s.params, localNames: [...locals.keys()], code: [] };
    this.functions.set(s.name, code);
    const ctx: FnCtx = { code, locals, loops: [], tryDepth: 0 };
    for (const st of s.body) this.stmt(st, ctx);
    const end = s.body.length > 0 ? lastPos(s.body) : s.pos;
    this.emit(ctx, Op.CONST, end, null);
    this.emit(ctx, Op.RETURN, end);
  }

  private err(pos: Pos, msg: string): never {
    throw new ScriptSyntaxError(msg, pos.line, pos.col);
  }

  private emit(ctx: FnCtx, op: OpCode, pos: Pos, a?: Instr["a"]): number {
    const ins: Instr = { op, line: pos.line, col: pos.col };
    if (a !== undefined) ins.a = a;
    ctx.code.code.push(ins);
    if (ctx.code.code.length > 50_000) this.err(pos, "Program is too large");
    return ctx.code.code.length - 1;
  }
  private here(ctx: FnCtx): number {
    return ctx.code.code.length;
  }
  private patch(ctx: FnCtx, at: number, target: number): void {
    (ctx.code.code[at] as Instr).a = target;
  }

  private stmt(s: Stmt, ctx: FnCtx): void {
    switch (s.k) {
      case "def": {
        if (ctx.locals) this.err(s.pos, "Functions can only be defined at the top level");
        const code = this.functions.get(s.name) as CodeObject;
        this.emit(ctx, Op.CONST, s.pos, new UserFn(code));
        this.emit(ctx, Op.STORE_GLOBAL, s.pos, s.name);
        return;
      }
      case "expr":
        this.expr(s.e, ctx);
        this.emit(ctx, Op.POP, s.pos);
        return;
      case "assign":
        this.assign(s, ctx);
        return;
      case "pass":
        return;
      case "return":
        if (!ctx.locals) this.err(s.pos, "'return' can only be used inside a function");
        if (s.e) this.expr(s.e, ctx);
        else this.emit(ctx, Op.CONST, s.pos, null);
        this.emit(ctx, Op.RETURN, s.pos);
        return;
      case "break": {
        const loop = ctx.loops[ctx.loops.length - 1];
        if (!loop) this.err(s.pos, "'break' outside of a loop");
        for (let i = loop.tryDepth; i < ctx.tryDepth; i++) this.emit(ctx, Op.POP_EXCEPT, s.pos);
        loop.breaks.push(this.emit(ctx, Op.JUMP, s.pos, -1));
        return;
      }
      case "continue": {
        const loop = ctx.loops[ctx.loops.length - 1];
        if (!loop) this.err(s.pos, "'continue' outside of a loop");
        for (let i = loop.tryDepth; i < ctx.tryDepth; i++) this.emit(ctx, Op.POP_EXCEPT, s.pos);
        this.emit(ctx, Op.JUMP, s.pos, loop.continueTarget);
        return;
      }
      case "if": {
        const ends: number[] = [];
        for (const br of s.branches) {
          this.expr(br.cond, ctx);
          const jf = this.emit(ctx, Op.JUMP_IF_FALSE, br.cond.pos, -1);
          for (const st of br.body) this.stmt(st, ctx);
          ends.push(this.emit(ctx, Op.JUMP, br.cond.pos, -1));
          this.patch(ctx, jf, this.here(ctx));
        }
        if (s.orelse) for (const st of s.orelse) this.stmt(st, ctx);
        for (const e of ends) this.patch(ctx, e, this.here(ctx));
        return;
      }
      case "while": {
        const top = this.here(ctx);
        this.expr(s.cond, ctx);
        const jf = this.emit(ctx, Op.JUMP_IF_FALSE, s.pos, -1);
        const loop: LoopCtx = { breaks: [], continueTarget: top, tryDepth: ctx.tryDepth };
        ctx.loops.push(loop);
        for (const st of s.body) this.stmt(st, ctx);
        ctx.loops.pop();
        this.emit(ctx, Op.JUMP, s.pos, top);
        const end = this.here(ctx);
        this.patch(ctx, jf, end);
        for (const b of loop.breaks) this.patch(ctx, b, end);
        return;
      }
      case "for": {
        this.expr(s.iter, ctx);
        this.emit(ctx, Op.GET_ITER, s.iter.pos);
        const top = this.here(ctx);
        const fi = this.emit(ctx, Op.FOR_ITER, s.pos, -1);
        this.storeName(s.name, s.pos, ctx);
        const loop: LoopCtx = { breaks: [], continueTarget: top, tryDepth: ctx.tryDepth };
        ctx.loops.push(loop);
        for (const st of s.body) this.stmt(st, ctx);
        ctx.loops.pop();
        this.emit(ctx, Op.JUMP, s.pos, top);
        const end = this.here(ctx);
        this.patch(ctx, fi, end);
        for (const b of loop.breaks) this.patch(ctx, b, end);
        this.emit(ctx, Op.POP, s.pos); // discard the iterator
        return;
      }
      case "try": {
        const setup = this.emit(ctx, Op.SETUP_EXCEPT, s.pos, -1);
        ctx.tryDepth++;
        for (const st of s.body) this.stmt(st, ctx);
        ctx.tryDepth--;
        this.emit(ctx, Op.POP_EXCEPT, s.pos);
        const skip = this.emit(ctx, Op.JUMP, s.pos, -1);
        this.patch(ctx, setup, this.here(ctx));
        // The VM pushes the error message string before jumping here.
        if (s.errName) this.storeName(s.errName, s.pos, ctx);
        else this.emit(ctx, Op.POP, s.pos);
        for (const st of s.handler) this.stmt(st, ctx);
        this.patch(ctx, skip, this.here(ctx));
        return;
      }
    }
  }

  private assign(s: Extract<Stmt, { k: "assign" }>, ctx: FnCtx): void {
    const t = s.target;
    const binop = s.op === "=" ? null : s.op.slice(0, 1);
    if (t.k === "name") {
      if (binop) {
        this.loadName(t.name, t.pos, ctx);
        this.expr(s.value, ctx);
        this.emit(ctx, Op.BIN, s.pos, binop);
      } else {
        this.expr(s.value, ctx);
      }
      this.storeName(t.name, t.pos, ctx);
      return;
    }
    if (t.k === "index") {
      this.expr(t.obj, ctx);
      this.expr(t.index, ctx);
      if (binop) {
        this.emit(ctx, Op.DUP2, s.pos);
        this.emit(ctx, Op.GET_INDEX, t.pos);
        this.expr(s.value, ctx);
        this.emit(ctx, Op.BIN, s.pos, binop);
      } else {
        this.expr(s.value, ctx);
      }
      this.emit(ctx, Op.SET_INDEX, s.pos);
      return;
    }
    this.err(s.pos, "Invalid assignment target");
  }

  private storeName(name: string, pos: Pos, ctx: FnCtx): void {
    this.checkAssignable(name, pos);
    const slot = ctx.locals?.get(name);
    if (slot !== undefined) this.emit(ctx, Op.STORE_LOCAL, pos, slot);
    else this.emit(ctx, Op.STORE_GLOBAL, pos, name);
  }

  private loadName(name: string, pos: Pos, ctx: FnCtx): void {
    const slot = ctx.locals?.get(name);
    if (slot !== undefined) {
      this.emit(ctx, Op.LOAD_LOCAL, pos, slot);
      return;
    }
    if (!this.globals.has(name) && !isKnownGlobal(name)) {
      const known = [...COMMANDS.map((c) => c.name), ...Object.keys(NAMESPACES), ...Object.keys(CONSTANTS), ...this.globals, ...this.functions.keys(), ...(ctx.locals?.keys() ?? [])];
      const near = closestName(name, known);
      this.err(pos, near ? `Unknown name '${name}'. Did you mean '${near}'?` : `Unknown name '${name}'. Check the spelling, or see the command reference for available commands.`);
    }
    const def = this.globals.has(name) ? undefined : commandDef(name);
    if (def?.requires && !this.unlocks.has(def.requires)) {
      this.err(pos, `${name}() is locked. ${def.lockedHint ?? `It requires ${def.requires}.`}`);
    }
    this.emit(ctx, Op.LOAD_GLOBAL, pos, name);
  }

  private expr(e: Expr, ctx: FnCtx): void {
    switch (e.k) {
      case "num":
      case "str":
      case "const":
        this.emit(ctx, Op.CONST, e.pos, e.v);
        return;
      case "name":
        this.loadName(e.name, e.pos, ctx);
        return;
      case "list":
        for (const it of e.items) this.expr(it, ctx);
        this.emit(ctx, Op.BUILD_LIST, e.pos, e.items.length);
        return;
      case "dict":
        for (let i = 0; i < e.keys.length; i++) {
          this.expr(e.keys[i] as Expr, ctx);
          this.expr(e.values[i] as Expr, ctx);
        }
        this.emit(ctx, Op.BUILD_DICT, e.pos, e.keys.length);
        return;
      case "bin":
        this.expr(e.l, ctx);
        this.expr(e.r, ctx);
        this.emit(ctx, Op.BIN, e.pos, e.op);
        return;
      case "un":
        this.expr(e.e, ctx);
        this.emit(ctx, Op.UN, e.pos, e.op);
        return;
      case "cmp":
        this.expr(e.l, ctx);
        this.expr(e.r, ctx);
        this.emit(ctx, Op.CMP, e.pos, e.op);
        return;
      case "bool": {
        this.expr(e.l, ctx);
        const j = this.emit(ctx, e.op === "and" ? Op.JUMP_IF_FALSE_OR_POP : Op.JUMP_IF_TRUE_OR_POP, e.pos, -1);
        this.expr(e.r, ctx);
        this.patch(ctx, j, this.here(ctx));
        return;
      }
      case "attr":
        this.expr(e.obj, ctx);
        this.emit(ctx, Op.GET_ATTR, e.pos, e.name);
        return;
      case "index":
        this.expr(e.obj, ctx);
        this.expr(e.index, ctx);
        this.emit(ctx, Op.GET_INDEX, e.pos);
        return;
      case "call": {
        this.checkCallArity(e, ctx);
        this.expr(e.callee, ctx);
        for (const a of e.args) this.expr(a, ctx);
        this.emit(ctx, Op.CALL, e.pos, e.args.length);
        return;
      }
    }
  }

  private checkCallArity(e: Extract<Expr, { k: "call" }>, ctx: FnCtx): void {
    if (e.callee.k !== "name") return;
    const name = e.callee.name;
    if (ctx.locals?.has(name)) return;
    const n = e.args.length;
    const userArity = this.fnArity.get(name);
    if (userArity !== undefined) {
      if (n !== userArity) this.err(e.pos, `${name}() takes ${userArity} argument${userArity === 1 ? "" : "s"} but ${n} were given`);
      return;
    }
    if (this.globals.has(name)) return;
    const def = commandDef(name);
    if (!def) {
      if (isNamespace(name)) this.err(e.pos, `'${name}' is not a function; use its methods, e.g. ${NAMESPACES[name]?.[0]?.signature ?? name}`);
      return;
    }
    if (n < def.minArgs || n > def.maxArgs) {
      const expect = def.minArgs === def.maxArgs ? `${def.minArgs}` : `${def.minArgs}-${def.maxArgs}`;
      this.err(e.pos, `${name}() takes ${expect} argument(s) but ${n} were given. Usage: ${def.signature}`);
    }
  }
}

/** Names assigned anywhere in a statement list (not descending into nested defs). */
function collectAssigned(body: Stmt[], out: Set<string>): void {
  for (const s of body) {
    switch (s.k) {
      case "assign":
        if (s.target.k === "name") out.add(s.target.name);
        break;
      case "for":
        out.add(s.name);
        collectAssigned(s.body, out);
        break;
      case "while":
        collectAssigned(s.body, out);
        break;
      case "try":
        collectAssigned(s.body, out);
        if (s.errName) out.add(s.errName);
        collectAssigned(s.handler, out);
        break;
      case "if":
        for (const b of s.branches) collectAssigned(b.body, out);
        if (s.orelse) collectAssigned(s.orelse, out);
        break;
      default:
        break;
    }
  }
}

function lastPos(body: Stmt[]): Pos {
  return (body[body.length - 1] as Stmt).pos;
}

/** A likely intended name for a typo (small edit distance, or a command ending in "_<name>"). */
export function closestName(word: string, candidates: Iterable<string>): string | null {
  const limit = Math.max(1, Math.floor(word.length / 3));
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (c === word) continue;
    let d = levenshtein(word.toLowerCase(), c.toLowerCase(), limit + 1);
    if (d > limit && word.length >= 4 && c.endsWith(`_${word}`)) d = limit;
    if (d < bestD || (d === bestD && best !== null && c.length < best.length)) {
      best = c;
      bestD = d;
    }
  }
  return bestD <= limit ? best : null;
}

/** Edit distance where swapping two neighbouring letters counts as one edit (the commonest typo). */
function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (prev2[j - 2] as number) + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] as number;
}
