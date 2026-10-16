import { commandDef, isConstant, isNamespace, NAMESPACES } from "./commands.ts";
import { Op, type CodeObject, type CompiledProgram, type Instr } from "./compiler.ts";
import {
  BuiltinFn,
  DictValue,
  ListValue,
  NamespaceValue,
  ObjectRef,
  RangeValue,
  UserFn,
  repr,
  truthy,
  typeName,
  valuesEqual,
  type Value,
} from "./values.ts";

/**
 * Resumable, budgeted bytecode interpreter.
 *
 * The VM never touches game state. Queries are delegated to a ScriptHost that
 * returns read-only snapshots; actions suspend the VM and are handed back to the
 * simulation, which validates and performs them and later resumes the VM with
 * the result. Every instruction is counted, so a program cannot monopolise the
 * server: run() returns after `budget` instructions no matter what the program does.
 */

export class ScriptRuntimeError extends Error {
  /** Limit violations (budgets, memory, recursion) cannot be caught by try/except. */
  readonly catchable: boolean;
  constructor(message: string, catchable = true) {
    super(message);
    this.name = "ScriptRuntimeError";
    this.catchable = catchable;
  }
}

/** Raised for resource-limit violations; never catchable by player code. */
function limitError(message: string): ScriptRuntimeError {
  return new ScriptRuntimeError(message, false);
}

export interface ActionFailure {
  action: string;
  reason: string;
}

export interface ScriptHost {
  /** Run a query or namespace method (e.g. "find_nearest", "inventory.is_full"). Throw ScriptRuntimeError on bad input. */
  query(name: string, args: Value[]): Value;
  /** Read a namespace value such as me.x. Return undefined if the attribute does not exist. */
  namespaceValue(ns: string, attr: string): Value | undefined;
  /** Validate an action's arguments before the VM suspends. Throw ScriptRuntimeError if invalid. */
  validateAction(name: string, args: Value[]): void;
}

export interface ActionRequest {
  name: string;
  args: Value[];
  line: number;
}

export interface RuntimeErrorInfo {
  message: string;
  line: number;
  col: number;
}

export type RunResult =
  | { status: "action"; action: ActionRequest; ops: number }
  | { status: "budget"; ops: number }
  | { status: "done"; ops: number }
  | { status: "error"; error: RuntimeErrorInfo; ops: number };

export interface VMLimits {
  maxStack: number;
  maxCallDepth: number;
  maxListLength: number;
  maxStringLength: number;
  /** Instructions allowed between two actions before the program is stopped as a runaway. */
  maxOpsWithoutAction: number;
  /** Max total list items reachable from the program at any time. */
  maxLiveItems: number;
  maxGlobals: number;
}

export const DEFAULT_LIMITS: VMLimits = {
  maxStack: 512,
  maxCallDepth: 32,
  maxListLength: 1000,
  maxStringLength: 2000,
  maxOpsWithoutAction: 50_000,
  maxLiveItems: 20_000,
  maxGlobals: 256,
};

class Iter {
  readonly kind = "iter";
  private i = 0;
  private readonly src: ListValue | RangeValue | string;
  constructor(src: ListValue | RangeValue | string | DictValue) {
    // Iterating a dict iterates over a snapshot of its keys (safe against mutation).
    this.src = src instanceof DictValue ? new ListValue(src.keys()) : src;
  }
  next(): Value | undefined {
    const s = this.src;
    if (s instanceof ListValue) return this.i < s.items.length ? s.items[this.i++] : undefined;
    if (s instanceof RangeValue) {
      if (this.i >= s.length) return undefined;
      return s.start + s.step * this.i++;
    }
    return this.i < s.length ? s[this.i++] : undefined;
  }
}

type Slot = Value | Iter;

interface Frame {
  code: CodeObject;
  ip: number;
  locals: (Value | undefined)[];
  base: number;
  /** For event-handler frames: the value to push instead of the handler's return value. */
  after?: Value;
}

interface Handler {
  frameDepth: number;
  stackLen: number;
  target: number;
}

const MAX_HANDLERS = 32;

export type VMState = "ready" | "waiting" | "done" | "error";

export class VM {
  readonly program: CompiledProgram;
  private readonly host: ScriptHost;
  private readonly limits: VMLimits;
  private stack: Slot[] = [];
  private frames: Frame[] = [];
  private globals = new Map<string, Value>();
  private handlers: Handler[] = [];
  private inEventHandler = false;
  private allocSinceCheck = 0;
  state: VMState = "ready";
  opsSinceAction = 0;
  totalOps = 0;
  lastLine = 0;
  pendingAction: ActionRequest | null = null;

  constructor(program: CompiledProgram, host: ScriptHost, limits: VMLimits = DEFAULT_LIMITS) {
    this.program = program;
    this.host = host;
    this.limits = limits;
    this.frames.push({ code: program.main, ip: 0, locals: [], base: 0 });
  }

  /**
   * Provide the result of the pending action and make the VM runnable again.
   * If the action failed and the program defines on_action_failed(action, reason),
   * that handler runs first; the original call then receives `result`.
   */
  resume(result: Value, failure?: ActionFailure): void {
    if (this.state !== "waiting") throw new Error("VM.resume called while not waiting for an action");
    this.pendingAction = null;
    this.state = "ready";
    this.opsSinceAction = 0;
    const handler = failure && !this.inEventHandler ? this.globals.get("on_action_failed") : undefined;
    if (failure && handler instanceof UserFn && handler.code.params.length === 2 && this.frames.length < this.limits.maxCallDepth) {
      const locals: (Value | undefined)[] = new Array(handler.code.localNames.length).fill(undefined);
      locals[0] = failure.action;
      locals[1] = failure.reason;
      this.inEventHandler = true;
      this.frames.push({ code: handler.code, ip: 0, locals, base: this.stack.length, after: result });
      return;
    }
    this.stack.push(result);
  }

  /** Does the program define event handler `name` taking `arity` parameters? */
  hasHandler(name: string, arity: number): boolean {
    const h = this.globals.get(name);
    return h instanceof UserFn && h.code.params.length === arity;
  }

  /**
   * Abandon the pending action and run event handler `name(...args)` now; when it returns,
   * the abandoned call returns `result`. Only while waiting for an action and not already
   * inside an event handler. Returns whether the handler was started.
   */
  interrupt(name: string, args: Value[], result: Value): boolean {
    if (this.state !== "waiting" || this.inEventHandler) return false;
    const h = this.globals.get(name);
    if (!(h instanceof UserFn) || h.code.params.length !== args.length || this.frames.length >= this.limits.maxCallDepth) return false;
    this.pendingAction = null;
    this.state = "ready";
    this.opsSinceAction = 0;
    const locals: (Value | undefined)[] = new Array(h.code.localNames.length).fill(undefined);
    args.forEach((a, i) => (locals[i] = a));
    this.inEventHandler = true;
    this.frames.push({ code: h.code, ip: 0, locals, base: this.stack.length, after: result });
    return true;
  }

  run(budget: number): RunResult {
    if (this.state === "waiting") throw new Error("VM.run called while waiting for an action result");
    if (this.state === "done") return { status: "done", ops: 0 };
    if (this.state === "error") return { status: "error", error: { message: "Program has already failed", line: 0, col: 0 }, ops: 0 };
    let ops = 0;
    let ins: Instr | undefined;
    while (ops < budget) {
      try {
        const frame = this.frames[this.frames.length - 1] as Frame;
        ins = frame.code.code[frame.ip++];
        if (!ins) throw limitError("Internal error: instruction pointer out of range");
        ops++;
        this.opsSinceAction++;
        this.lastLine = ins.line;
        if (this.opsSinceAction > this.limits.maxOpsWithoutAction) {
          throw limitError(
            `Instruction budget exceeded: ${this.limits.maxOpsWithoutAction} instructions ran without any action. ` +
              "Loops that only check conditions should call an action such as wait(1).",
          );
        }
        const r = this.exec(ins, frame);
        if (r) {
          ops += r.cost;
          this.opsSinceAction += r.cost;
          if (r.kind === "action") {
            this.totalOps += ops;
            return { status: "action", action: r.action, ops };
          }
          if (r.kind === "done") {
            this.state = "done";
            this.totalOps += ops;
            return { status: "done", ops };
          }
        }
      } catch (e) {
        // Catchable game errors unwind to the innermost try/except.
        if (e instanceof ScriptRuntimeError && e.catchable && this.handlers.length > 0) {
          const h = this.handlers.pop() as Handler;
          this.frames.length = h.frameDepth;
          this.stack.length = h.stackLen;
          if (this.inEventHandler && !this.frames.some((f) => f.after !== undefined)) this.inEventHandler = false;
          this.stack.push(e.message);
          (this.frames[this.frames.length - 1] as Frame).ip = h.target;
          ops += 5;
          continue;
        }
        this.state = "error";
        this.totalOps += ops;
        const message = e instanceof ScriptRuntimeError ? e.message : e instanceof RangeError ? "Internal limit exceeded" : `Internal error: ${(e as Error).message}`;
        return { status: "error", error: { message, line: ins?.line ?? 0, col: ins?.col ?? 0 }, ops };
      }
    }
    this.totalOps += ops;
    return { status: "budget", ops };
  }

  private push(v: Slot): void {
    if (this.stack.length >= this.limits.maxStack) throw limitError("Stack overflow: expression or recursion too deep");
    this.stack.push(v);
  }
  private pop(): Value {
    const v = this.stack.pop();
    if (v === undefined || v instanceof Iter) throw limitError("Internal error: stack underflow");
    return v;
  }

  private exec(ins: Instr, frame: Frame): { kind: "cost"; cost: number } | { kind: "action"; action: ActionRequest; cost: number } | { kind: "done"; cost: number } | null {
    switch (ins.op) {
      case Op.CONST:
        this.push(ins.a as Value);
        return null;
      case Op.LOAD_LOCAL: {
        const v = frame.locals[ins.a as number];
        if (v === undefined) {
          throw new ScriptRuntimeError(`Variable '${frame.code.localNames[ins.a as number]}' is used before it is assigned`);
        }
        this.push(v);
        return null;
      }
      case Op.STORE_LOCAL:
        frame.locals[ins.a as number] = this.pop();
        return null;
      case Op.LOAD_GLOBAL:
        this.push(this.loadGlobal(ins.a as string));
        return null;
      case Op.STORE_GLOBAL: {
        const name = ins.a as string;
        if (!this.globals.has(name) && this.globals.size >= this.limits.maxGlobals) {
          throw limitError(`Too many variables (limit ${this.limits.maxGlobals})`);
        }
        this.globals.set(name, this.pop());
        return null;
      }
      case Op.POP:
        this.stack.pop();
        return null;
      case Op.DUP2: {
        const b = this.stack[this.stack.length - 1] as Slot;
        const a = this.stack[this.stack.length - 2] as Slot;
        this.push(a);
        this.push(b);
        return null;
      }
      case Op.BIN: {
        const r = this.pop();
        const l = this.pop();
        this.push(this.binop(ins.a as string, l, r));
        return null;
      }
      case Op.UN: {
        const v = this.pop();
        if (ins.a === "not") this.push(!truthy(v));
        else if (typeof v === "number") this.push(ins.a === "-" ? -v : v);
        else if (typeof v === "boolean") this.push(ins.a === "-" ? -(v ? 1 : 0) : v ? 1 : 0);
        else throw new ScriptRuntimeError(`Bad operand type for unary ${ins.a as string}: '${typeName(v)}'`);
        return null;
      }
      case Op.CMP: {
        const r = this.pop();
        const l = this.pop();
        this.push(this.compare(ins.a as string, l, r));
        return null;
      }
      case Op.JUMP:
        frame.ip = ins.a as number;
        return null;
      case Op.JUMP_IF_FALSE:
        if (!truthy(this.pop())) frame.ip = ins.a as number;
        return null;
      case Op.JUMP_IF_FALSE_OR_POP: {
        const v = this.stack[this.stack.length - 1] as Value;
        if (!truthy(v)) frame.ip = ins.a as number;
        else this.stack.pop();
        return null;
      }
      case Op.JUMP_IF_TRUE_OR_POP: {
        const v = this.stack[this.stack.length - 1] as Value;
        if (truthy(v)) frame.ip = ins.a as number;
        else this.stack.pop();
        return null;
      }
      case Op.BUILD_LIST: {
        const n = ins.a as number;
        const items = this.stack.splice(this.stack.length - n, n) as Value[];
        this.push(this.newList(items));
        return null;
      }
      case Op.GET_ATTR:
        this.push(this.getAttr(this.pop(), ins.a as string));
        return null;
      case Op.GET_INDEX: {
        const idx = this.pop();
        const obj = this.pop();
        this.push(this.getIndex(obj, idx));
        return null;
      }
      case Op.SET_INDEX: {
        const val = this.pop();
        const idx = this.pop();
        const obj = this.pop();
        if (obj instanceof DictValue) {
          const k = this.dictKey(idx);
          if (!obj.has(k) && obj.size >= this.limits.maxListLength) throw limitError(`Dictionary is too large (limit ${this.limits.maxListLength} entries)`);
          if (!obj.has(k)) this.noteAlloc(1);
          obj.set(k, val);
          return null;
        }
        if (!(obj instanceof ListValue)) throw new ScriptRuntimeError(`'${typeName(obj)}' does not support item assignment`);
        obj.items[this.listIndex(obj.items.length, idx)] = val;
        return null;
      }
      case Op.GET_ITER: {
        const v = this.pop();
        if (v instanceof ListValue || v instanceof RangeValue || v instanceof DictValue || typeof v === "string") this.push(new Iter(v));
        else throw new ScriptRuntimeError(`'${typeName(v)}' is not iterable`);
        return null;
      }
      case Op.FOR_ITER: {
        const it = this.stack[this.stack.length - 1];
        if (!(it instanceof Iter)) throw new ScriptRuntimeError("Internal error: FOR_ITER without iterator");
        const nx = it.next();
        if (nx === undefined) frame.ip = ins.a as number;
        else this.push(nx);
        return null;
      }
      case Op.RETURN: {
        const ret = this.pop();
        const depth = this.frames.length;
        while (this.handlers.length > 0 && (this.handlers[this.handlers.length - 1] as Handler).frameDepth >= depth) this.handlers.pop();
        const done = this.frames.pop() as Frame;
        if (this.frames.length === 0) return { kind: "done", cost: 0 };
        this.stack.length = done.base;
        if (done.after !== undefined) {
          this.inEventHandler = false;
          this.push(done.after);
        } else {
          this.push(ret);
        }
        return null;
      }
      case Op.BUILD_DICT: {
        const n = ins.a as number;
        const flat = this.stack.splice(this.stack.length - n * 2, n * 2) as Value[];
        const d = new DictValue();
        for (let i = 0; i < n; i++) d.set(this.dictKey(flat[i * 2] as Value), flat[i * 2 + 1] as Value);
        this.noteAlloc(n + 1);
        this.push(d);
        return null;
      }
      case Op.SETUP_EXCEPT:
        if (this.handlers.length >= MAX_HANDLERS) throw limitError("Too many nested try blocks");
        this.handlers.push({ frameDepth: this.frames.length, stackLen: this.stack.length, target: ins.a as number });
        return null;
      case Op.POP_EXCEPT:
        this.handlers.pop();
        return null;
      case Op.CALL:
        return this.call(ins, ins.a as number);
    }
    throw new ScriptRuntimeError(`Internal error: unknown opcode ${String(ins.op)}`);
  }

  private loadGlobal(name: string): Value {
    const g = this.globals.get(name);
    if (g !== undefined) return g;
    if (isNamespace(name)) return new NamespaceValue(name);
    if (isConstant(name)) {
      if (name === "alive") return true;
    }
    if (commandDef(name)) return new BuiltinFn(name);
    throw new ScriptRuntimeError(`Name '${name}' is not defined yet (assign it before using it)`);
  }

  private call(ins: Instr, argc: number): { kind: "cost"; cost: number } | { kind: "action"; action: ActionRequest; cost: number } | null {
    const args = this.stack.splice(this.stack.length - argc, argc) as Value[];
    const callee = this.pop();
    if (callee instanceof UserFn) {
      const code = callee.code;
      if (args.length !== code.params.length) {
        throw new ScriptRuntimeError(`${code.name}() takes ${code.params.length} argument(s) but ${args.length} were given`);
      }
      if (this.frames.length >= this.limits.maxCallDepth) {
        throw limitError(`Maximum function call depth (${this.limits.maxCallDepth}) exceeded - check for runaway recursion`);
      }
      const locals: (Value | undefined)[] = new Array(code.localNames.length).fill(undefined);
      for (let i = 0; i < args.length; i++) locals[i] = args[i];
      this.frames.push({ code, ip: 0, locals, base: this.stack.length });
      return null;
    }
    if (!(callee instanceof BuiltinFn)) throw new ScriptRuntimeError(`'${typeName(callee)}' object is not callable`);

    if (callee.self) {
      this.push(callee.self instanceof DictValue ? this.dictMethod(callee.self, callee.name, args) : this.listMethod(callee.self, callee.name, args));
      return { kind: "cost", cost: 1 };
    }
    const def = commandDef(callee.name);
    if (def) {
      if (args.length < def.minArgs || args.length > def.maxArgs) {
        throw new ScriptRuntimeError(`${def.name}() takes ${def.minArgs}-${def.maxArgs} arguments but ${args.length} were given. Usage: ${def.signature}`);
      }
      if (def.kind === "builtin") {
        this.push(this.builtin(def.name, args));
        return { kind: "cost", cost: def.cost };
      }
      if (def.kind === "query") {
        this.push(this.host.query(def.name, args));
        return { kind: "cost", cost: def.cost };
      }
      this.host.validateAction(def.name, args);
      const action: ActionRequest = { name: def.name, args, line: ins.line };
      this.state = "waiting";
      this.pendingAction = action;
      return { kind: "action", action, cost: def.cost };
    }
    // Namespace method, e.g. inventory.is_full
    this.push(this.host.query(callee.name, args));
    return { kind: "cost", cost: 2 };
  }

  private getAttr(obj: Value, name: string): Value {
    if (obj instanceof NamespaceValue) {
      const members = isNamespace(obj.name) ? (NAMESPACES[obj.name] ?? []) : [];
      const m = members.find((x) => x.name === name);
      if (!m) throw new ScriptRuntimeError(`'${obj.name}' has no attribute '${name}'`);
      if (m.type === "method") return new BuiltinFn(`${obj.name}.${name}`);
      const v = this.host.namespaceValue(obj.name, name);
      if (v === undefined) throw new ScriptRuntimeError(`'${obj.name}.${name}' is not available`);
      return v;
    }
    if (obj instanceof ObjectRef) {
      switch (name) {
        case "id":
          return obj.id;
        case "kind":
          return obj.kind;
        case "x":
          return obj.x;
        case "y":
          return obj.y;
        case "amount":
          return obj.amount;
        default:
          throw new ScriptRuntimeError(`Objects have no attribute '${name}' (available: id, kind, x, y, amount)`);
      }
    }
    if (obj instanceof ListValue) {
      if (name === "append" || name === "pop") return new BuiltinFn(`list.${name}`, obj);
      throw new ScriptRuntimeError(`Lists have no attribute '${name}' (available: append, pop)`);
    }
    if (obj instanceof DictValue) {
      if (["get", "keys", "values", "items", "pop"].includes(name)) return new BuiltinFn(`dict.${name}`, obj);
      throw new ScriptRuntimeError(`Dictionaries have no attribute '${name}' (available: get, keys, values, items, pop)`);
    }
    if (obj === null) throw new ScriptRuntimeError(`Cannot read '.${name}' of None - check the value is not None first`);
    throw new ScriptRuntimeError(`'${typeName(obj)}' has no attribute '${name}'`);
  }

  private listMethod(list: ListValue, name: string, args: Value[]): Value {
    if (name === "list.append") {
      if (args.length !== 1) throw new ScriptRuntimeError("append() takes exactly 1 argument");
      if (list.items.length >= this.limits.maxListLength) throw limitError(`List is too long (limit ${this.limits.maxListLength} items)`);
      list.items.push(args[0] as Value);
      this.noteAlloc(1);
      return null;
    }
    if (name === "list.pop") {
      if (args.length > 1) throw new ScriptRuntimeError("pop() takes at most 1 argument");
      if (list.items.length === 0) throw new ScriptRuntimeError("pop from empty list");
      const idx = args.length === 1 ? this.listIndex(list.items.length, args[0] as Value) : list.items.length - 1;
      return list.items.splice(idx, 1)[0] as Value;
    }
    throw new ScriptRuntimeError(`Unknown list method ${name}`);
  }

  private dictKey(k: Value): string | number | boolean {
    if (typeof k === "string" || typeof k === "boolean" || (typeof k === "number" && Number.isInteger(k))) return k;
    throw new ScriptRuntimeError(`Dictionary keys must be strings, whole numbers or booleans, not '${typeName(k)}'`);
  }

  private dictMethod(d: DictValue, name: string, args: Value[]): Value {
    switch (name) {
      case "dict.get": {
        if (args.length < 1 || args.length > 2) throw new ScriptRuntimeError("get() takes 1 or 2 arguments");
        const v = d.get(this.dictKey(args[0] as Value));
        return v === undefined ? (args[1] ?? null) : v;
      }
      case "dict.keys":
        return this.newList(d.keys());
      case "dict.values":
        return this.newList(d.values());
      case "dict.items":
        return this.newList([...d.map.values()].map(([k, v]) => this.newList([k, v])));
      case "dict.pop": {
        if (args.length < 1 || args.length > 2) throw new ScriptRuntimeError("pop() takes 1 or 2 arguments");
        const k = this.dictKey(args[0] as Value);
        const v = d.get(k);
        if (v === undefined) {
          if (args.length === 2) return args[1] as Value;
          throw new ScriptRuntimeError(`Key ${repr(k, 1)} not found`);
        }
        d.delete(k);
        return v;
      }
    }
    throw new ScriptRuntimeError(`Unknown dict method ${name}`);
  }

  private listIndex(len: number, idx: Value): number {
    if (typeof idx !== "number" || !Number.isInteger(idx)) throw new ScriptRuntimeError(`List indices must be integers, not '${typeName(idx)}'`);
    const i = idx < 0 ? len + idx : idx;
    if (i < 0 || i >= len) throw new ScriptRuntimeError(`Index ${idx} out of range (length ${len})`);
    return i;
  }

  private getIndex(obj: Value, idx: Value): Value {
    if (obj instanceof ListValue) return obj.items[this.listIndex(obj.items.length, idx)] as Value;
    if (obj instanceof DictValue) {
      const k = this.dictKey(idx);
      const v = obj.get(k);
      if (v === undefined) throw new ScriptRuntimeError(`Key ${repr(k, 1)} not found (use .get(key, default) for optional keys)`);
      return v;
    }
    if (typeof obj === "string") return obj[this.listIndex(obj.length, idx)] as string;
    throw new ScriptRuntimeError(`'${typeName(obj)}' is not subscriptable`);
  }

  private newList(items: Value[]): ListValue {
    if (items.length > this.limits.maxListLength) throw limitError(`List is too long (limit ${this.limits.maxListLength} items)`);
    this.noteAlloc(items.length + 1);
    return new ListValue(items);
  }

  /** Approximate memory accounting: periodically measure everything reachable from the program. */
  private noteAlloc(n: number): void {
    this.allocSinceCheck += n;
    if (this.allocSinceCheck < 2_000) return;
    this.allocSinceCheck = 0;
    const seen = new Set<ListValue | DictValue>();
    let total = 0;
    const visit = (v: Value | Iter | undefined): void => {
      if (!(v instanceof ListValue || v instanceof DictValue) || seen.has(v)) return;
      seen.add(v);
      const items = v instanceof ListValue ? v.items : v.values();
      total += items.length + 1;
      if (total > this.limits.maxLiveItems) return;
      for (const it of items) visit(it);
    };
    for (const v of this.globals.values()) visit(v);
    for (const v of this.stack) visit(v);
    for (const f of this.frames) for (const v of f.locals) visit(v);
    if (total > this.limits.maxLiveItems) {
      throw limitError(`Memory limit exceeded: programs may hold at most ${this.limits.maxLiveItems} list/dict items`);
    }
  }

  private str(s: string): string {
    if (s.length > this.limits.maxStringLength) throw limitError(`String is too long (limit ${this.limits.maxStringLength} characters)`);
    return s;
  }

  private num(n: number): number {
    if (!Number.isFinite(n)) throw new ScriptRuntimeError("Number is too large");
    return n;
  }

  private binop(op: string, l: Value, r: Value): Value {
    const ln = typeof l === "boolean" ? (l ? 1 : 0) : l;
    const rn = typeof r === "boolean" ? (r ? 1 : 0) : r;
    if (typeof ln === "number" && typeof rn === "number") {
      switch (op) {
        case "+":
          return this.num(ln + rn);
        case "-":
          return this.num(ln - rn);
        case "*":
          return this.num(ln * rn);
        case "/":
          if (rn === 0) throw new ScriptRuntimeError("Division by zero");
          return this.num(ln / rn);
        case "//":
          if (rn === 0) throw new ScriptRuntimeError("Division by zero");
          return this.num(Math.floor(ln / rn));
        case "%":
          if (rn === 0) throw new ScriptRuntimeError("Modulo by zero");
          return this.num(ln - rn * Math.floor(ln / rn));
      }
    }
    if (op === "+" && typeof l === "string" && typeof r === "string") return this.str(l + r);
    if (op === "+" && l instanceof ListValue && r instanceof ListValue) return this.newList([...l.items, ...r.items]);
    if (op === "*") {
      if (typeof l === "string" && typeof rn === "number") return this.str(l.repeat(Math.max(0, Math.min(Math.floor(rn), this.limits.maxStringLength + 1))));
      if (l instanceof ListValue && typeof rn === "number") {
        const n = Math.max(0, Math.floor(rn));
        if (n * l.items.length > this.limits.maxListLength) throw limitError(`List is too long (limit ${this.limits.maxListLength} items)`);
        const out: Value[] = [];
        for (let i = 0; i < n; i++) out.push(...l.items);
        return this.newList(out);
      }
    }
    if (op === "+" && (typeof l === "string" || typeof r === "string")) {
      throw new ScriptRuntimeError(`Cannot add '${typeName(l)}' and '${typeName(r)}'; use str() to convert numbers to text`);
    }
    throw new ScriptRuntimeError(`Unsupported operand types for ${op}: '${typeName(l)}' and '${typeName(r)}'`);
  }

  private compare(op: string, l: Value, r: Value): boolean {
    switch (op) {
      case "==":
        return valuesEqual(l, r);
      case "!=":
        return !valuesEqual(l, r);
      case "is":
        return l === r || (l instanceof ObjectRef && r instanceof ObjectRef && l.id === r.id);
      case "is not":
        return !(l === r || (l instanceof ObjectRef && r instanceof ObjectRef && l.id === r.id));
      case "in":
      case "not in": {
        let found: boolean;
        if (r instanceof ListValue) found = r.items.some((i) => valuesEqual(i, l));
        else if (r instanceof DictValue) found = (typeof l === "string" || typeof l === "number" || typeof l === "boolean") && r.has(l);
        else if (typeof r === "string" && typeof l === "string") found = r.includes(l);
        else if (r instanceof RangeValue && typeof l === "number") {
          const k = (l - r.start) / r.step;
          found = Number.isInteger(k) && k >= 0 && k < r.length;
        } else throw new ScriptRuntimeError(`'in' is not supported for '${typeName(r)}'`);
        return op === "in" ? found : !found;
      }
    }
    const ln = typeof l === "boolean" ? (l ? 1 : 0) : l;
    const rn = typeof r === "boolean" ? (r ? 1 : 0) : r;
    if ((typeof ln === "number" && typeof rn === "number") || (typeof ln === "string" && typeof rn === "string")) {
      switch (op) {
        case "<":
          return ln < rn;
        case "<=":
          return ln <= rn;
        case ">":
          return ln > rn;
        case ">=":
          return ln >= rn;
      }
    }
    if (l === null || r === null) {
      throw new ScriptRuntimeError(`Cannot compare None with '${op}' - check the value is not None first`);
    }
    throw new ScriptRuntimeError(`Cannot compare '${typeName(l)}' and '${typeName(r)}' with '${op}'`);
  }

  private builtin(name: string, args: Value[]): Value {
    const a0 = args[0] as Value;
    switch (name) {
      case "len":
        if (a0 instanceof ListValue) return a0.items.length;
        if (a0 instanceof DictValue) return a0.size;
        if (a0 instanceof RangeValue) return a0.length;
        if (typeof a0 === "string") return a0.length;
        throw new ScriptRuntimeError(`len() is not supported for '${typeName(a0)}'`);
      case "range": {
        const nums = args.map((a) => {
          if (typeof a !== "number" || !Number.isInteger(a)) throw new ScriptRuntimeError("range() arguments must be integers");
          return a;
        });
        const [start, stop, step] = nums.length === 1 ? [0, nums[0] as number, 1] : [nums[0] as number, nums[1] as number, nums[2] ?? 1];
        if (step === 0) throw new ScriptRuntimeError("range() step must not be zero");
        return new RangeValue(start, stop, step);
      }
      case "abs":
        if (typeof a0 !== "number") throw new ScriptRuntimeError("abs() requires a number");
        return Math.abs(a0);
      case "min":
      case "max": {
        const vals = args.length === 1 && a0 instanceof ListValue ? a0.items : args;
        if (vals.length === 0) throw new ScriptRuntimeError(`${name}() of an empty list`);
        let best = vals[0] as Value;
        for (const v of vals.slice(1)) {
          const better = name === "min" ? this.compare("<", v, best) : this.compare(">", v, best);
          if (better) best = v;
        }
        return best;
      }
      case "int":
        if (typeof a0 === "number") return Math.trunc(a0);
        if (typeof a0 === "boolean") return a0 ? 1 : 0;
        if (typeof a0 === "string" && /^\s*-?\d+\s*$/.test(a0)) return Number.parseInt(a0, 10);
        throw new ScriptRuntimeError(`int() cannot convert ${repr(a0, 1)}`);
      case "str":
        return this.str(repr(a0));
      case "round":
        if (typeof a0 !== "number") throw new ScriptRuntimeError("round() requires a number");
        return Math.round(a0);
    }
    throw new ScriptRuntimeError(`Unknown built-in ${name}`);
  }
}
