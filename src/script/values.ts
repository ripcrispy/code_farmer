/** Runtime values of the Code Farmer language. */

import type { CodeObject } from "./compiler.ts";

export class ListValue {
  readonly type = "list";
  items: Value[];
  constructor(items: Value[]) {
    this.items = items;
  }
}

export type DictKey = string | number | boolean;

/** Dictionary with str/int/bool keys. Insertion-ordered like Python. */
export class DictValue {
  readonly type = "dict";
  readonly map = new Map<string, [DictKey, Value]>();
  static keyOf(k: DictKey): string {
    if (typeof k === "boolean") return k ? "n:1" : "n:0";
    return typeof k === "number" ? `n:${k}` : `s:${k}`;
  }
  get size(): number {
    return this.map.size;
  }
  get(k: DictKey): Value | undefined {
    return this.map.get(DictValue.keyOf(k))?.[1];
  }
  set(k: DictKey, v: Value): void {
    const key = DictValue.keyOf(k);
    const prev = this.map.get(key);
    this.map.set(key, [prev ? prev[0] : k, v]);
  }
  has(k: DictKey): boolean {
    return this.map.has(DictValue.keyOf(k));
  }
  delete(k: DictKey): boolean {
    return this.map.delete(DictValue.keyOf(k));
  }
  keys(): DictKey[] {
    return [...this.map.values()].map((e) => e[0]);
  }
  values(): Value[] {
    return [...this.map.values()].map((e) => e[1]);
  }
}

export class RangeValue {
  readonly type = "range";
  readonly start: number;
  readonly stop: number;
  readonly step: number;
  constructor(start: number, stop: number, step: number) {
    this.start = start;
    this.stop = stop;
    this.step = step;
  }
  get length(): number {
    if (this.step > 0) return Math.max(0, Math.ceil((this.stop - this.start) / this.step));
    return Math.max(0, Math.ceil((this.start - this.stop) / -this.step));
  }
}

/** Read-only snapshot of a world object returned by a query. Actions re-validate by id. */
export class ObjectRef {
  readonly type = "object";
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly amount: number | null;
  constructor(id: string, kind: string, x: number, y: number, amount: number | null) {
    this.id = id;
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.amount = amount;
  }
}

export class NamespaceValue {
  readonly type = "namespace";
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class BuiltinFn {
  readonly type = "builtin";
  /** For namespace methods, `name` is "inventory.is_full"; for list methods "list.append". */
  readonly name: string;
  /** Bound receiver for list and dict methods. */
  readonly self: ListValue | DictValue | null;
  constructor(name: string, self: ListValue | DictValue | null = null) {
    this.name = name;
    this.self = self;
  }
}

export class UserFn {
  readonly type = "function";
  readonly code: CodeObject;
  constructor(code: CodeObject) {
    this.code = code;
  }
}

export type Value = number | string | boolean | null | ListValue | DictValue | RangeValue | ObjectRef | NamespaceValue | BuiltinFn | UserFn;

export function typeName(v: Value): string {
  if (v === null) return "None";
  switch (typeof v) {
    case "number":
      return Number.isInteger(v) ? "int" : "float";
    case "string":
      return "str";
    case "boolean":
      return "bool";
    default:
      switch (v.type) {
        case "list":
          return "list";
        case "dict":
          return "dict";
        case "range":
          return "range";
        case "object":
          return "object";
        case "namespace":
          return v.name;
        case "builtin":
        case "function":
          return "function";
      }
  }
}

export function truthy(v: Value): boolean {
  if (v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (v instanceof ListValue) return v.items.length > 0;
  if (v instanceof DictValue) return v.size > 0;
  if (v instanceof RangeValue) return v.length > 0;
  return true;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

export function repr(v: Value, depth = 0): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") return depth === 0 ? v : JSON.stringify(v);
  if (depth > 3) return "...";
  if (v instanceof ListValue) return `[${v.items.slice(0, 20).map((i) => repr(i, depth + 1)).join(", ")}${v.items.length > 20 ? ", ..." : ""}]`;
  if (v instanceof DictValue) {
    const parts = [...v.map.values()].slice(0, 20).map(([k, val]) => `${repr(k, depth + 1)}: ${repr(val, depth + 1)}`);
    return `{${parts.join(", ")}${v.size > 20 ? ", ..." : ""}}`;
  }
  if (v instanceof RangeValue) return `range(${v.start}, ${v.stop}, ${v.step})`;
  if (v instanceof ObjectRef) return `<${v.kind} at ${v.x},${v.y}>`;
  if (v instanceof NamespaceValue) return `<${v.name}>`;
  if (v instanceof BuiltinFn) return `<function ${v.name}>`;
  return `<function ${v.code.name}>`;
}

export function valuesEqual(a: Value, b: Value, depth = 0): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" && typeof b === "number") return (a ? 1 : 0) === b;
  if (typeof a === "number" && typeof b === "boolean") return a === (b ? 1 : 0);
  if (a instanceof ObjectRef && b instanceof ObjectRef) return a.id === b.id;
  if (a instanceof ListValue && b instanceof ListValue) {
    if (depth > 4 || a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) if (!valuesEqual(a.items[i] as Value, b.items[i] as Value, depth + 1)) return false;
    return true;
  }
  if (a instanceof DictValue && b instanceof DictValue) {
    if (depth > 4 || a.size !== b.size) return false;
    for (const [key, [, v]] of a.map) {
      const other = b.map.get(key);
      if (!other || !valuesEqual(v, other[1], depth + 1)) return false;
    }
    return true;
  }
  return false;
}
