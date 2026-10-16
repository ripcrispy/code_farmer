import { ScriptSyntaxError, type AssignOp, type CmpOp, type Expr, type Pos, type Stmt } from "./ast.ts";
import { tokenize, type Token } from "./lexer.ts";

const MAX_EXPR_DEPTH = 64;
const MAX_STATEMENTS = 4_000;

/**
 * Recursive-descent parser for the Code Farmer language (a restricted Python subset).
 * The grammar is documented in docs/SCRIPTING.md. Throws ScriptSyntaxError on the first error.
 */
export function parse(source: string): Stmt[] {
  return new Parser(tokenize(source)).parseProgram();
}

class Parser {
  private i = 0;
  private exprDepth = 0;
  private stmtCount = 0;
  private readonly toks: Token[];
  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)] as Token;
  }
  private next(): Token {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }
  private pos(t: Token): Pos {
    return { line: t.line, col: t.col };
  }
  private isOp(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === "op" && t.value === v;
  }
  private isKw(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === "kw" && t.value === v;
  }
  private fail(t: Token, msg: string): never {
    throw new ScriptSyntaxError(msg, t.line, t.col);
  }
  private describe(t: Token): string {
    switch (t.type) {
      case "newline":
        return "end of line";
      case "indent":
        return "an indented block";
      case "dedent":
        return "end of block";
      case "eof":
        return "end of program";
      default:
        return `'${t.value}'`;
    }
  }
  private expectOp(v: string, context: string): Token {
    const t = this.peek();
    if (t.type === "op" && t.value === v) return this.next();
    return this.fail(t, `Expected '${v}' ${context}, found ${this.describe(t)}`);
  }
  private expectName(context: string): Token {
    const t = this.peek();
    if (t.type === "name") return this.next();
    if (t.type === "kw") return this.fail(t, `'${t.value}' is a reserved word and cannot be used as ${context}`);
    return this.fail(t, `Expected ${context}, found ${this.describe(t)}`);
  }

  parseProgram(): Stmt[] {
    const body: Stmt[] = [];
    while (this.peek().type !== "eof") {
      const t = this.peek();
      if (t.type === "indent") this.fail(t, "Unexpected indentation");
      if (t.type === "newline") {
        this.next();
        continue;
      }
      body.push(this.statement(0));
    }
    return body;
  }

  private statement(blockDepth: number): Stmt {
    if (++this.stmtCount > MAX_STATEMENTS) this.fail(this.peek(), `Program has too many statements (limit ${MAX_STATEMENTS})`);
    const t = this.peek();
    if (t.type === "kw") {
      switch (t.value) {
        case "if":
          return this.ifStmt(blockDepth);
        case "while": {
          this.next();
          const cond = this.expr();
          this.expectOp(":", "after the while condition");
          return { k: "while", cond, body: this.suite(blockDepth), pos: this.pos(t) };
        }
        case "for": {
          this.next();
          const name = this.expectName("a loop variable name").value;
          if (!this.isKw("in")) this.fail(this.peek(), "Expected 'in' after the loop variable (for x in ...)");
          this.next();
          const iter = this.expr();
          this.expectOp(":", "after the for header");
          return { k: "for", name, iter, body: this.suite(blockDepth), pos: this.pos(t) };
        }
        case "def": {
          this.next();
          if (blockDepth > 0) this.fail(t, "Functions can only be defined at the top level of a program");
          const name = this.expectName("a function name").value;
          this.expectOp("(", "after the function name");
          const params: string[] = [];
          if (!this.isOp(")")) {
            for (;;) {
              const p = this.expectName("a parameter name");
              if (params.includes(p.value)) this.fail(p, `Duplicate parameter '${p.value}'`);
              params.push(p.value);
              if (this.isOp(",")) {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expectOp(")", "to close the parameter list");
          if (params.length > 8) this.fail(t, "Functions may have at most 8 parameters");
          this.expectOp(":", "after the function header");
          return { k: "def", name, params, body: this.suite(blockDepth + 1), pos: this.pos(t) };
        }
        case "try": {
          this.next();
          this.expectOp(":", "after try");
          const body = this.suite(blockDepth);
          if (!this.isKw("except")) this.fail(this.peek(), "Expected 'except' after the try block ('finally' is not supported)");
          this.next();
          let errName: string | null = null;
          if (!this.isOp(":")) {
            const cls = this.peek();
            if (cls.type !== "name" || (cls.value !== "Exception" && cls.value !== "GameError")) {
              this.fail(cls, "Only 'except:', 'except Exception:' or 'except Exception as e:' are supported");
            }
            this.next();
            if (this.isKw("as")) {
              this.next();
              errName = this.expectName("a variable name after 'as'").value;
            }
          }
          this.expectOp(":", "after except");
          const handler = this.suite(blockDepth);
          if (this.isKw("except")) this.fail(this.peek(), "Only one 'except' clause is supported");
          return { k: "try", body, errName, handler, pos: this.pos(t) };
        }
        case "except":
          return this.fail(t, "'except' without a matching 'try'");
        case "elif":
        case "else":
          return this.fail(t, `'${t.value}' without a matching 'if'`);
        default:
          break;
      }
    }
    const s = this.simpleStatement();
    this.endOfSimple();
    return s;
  }

  private endOfSimple(): void {
    const t = this.peek();
    if (t.type === "newline") {
      this.next();
      return;
    }
    if (t.type === "eof" || t.type === "dedent") return;
    this.fail(t, `Unexpected ${this.describe(t)} after statement`);
  }

  private ifStmt(blockDepth: number): Stmt {
    const start = this.next();
    const branches: { cond: Expr; body: Stmt[] }[] = [];
    const cond = this.expr();
    this.expectOp(":", "after the if condition");
    branches.push({ cond, body: this.suite(blockDepth) });
    let orelse: Stmt[] | null = null;
    for (;;) {
      if (this.isKw("elif")) {
        this.next();
        const c = this.expr();
        this.expectOp(":", "after the elif condition");
        branches.push({ cond: c, body: this.suite(blockDepth) });
        continue;
      }
      if (this.isKw("else")) {
        this.next();
        this.expectOp(":", "after else");
        orelse = this.suite(blockDepth);
      }
      break;
    }
    return { k: "if", branches, orelse, pos: this.pos(start) };
  }

  /** A block: either NEWLINE INDENT stmt+ DEDENT, or a single simple statement on the same line. */
  private suite(blockDepth: number): Stmt[] {
    const t = this.peek();
    if (t.type === "newline") {
      this.next();
      const ind = this.peek();
      if (ind.type !== "indent") this.fail(ind, "Expected an indented block");
      this.next();
      const body: Stmt[] = [];
      while (this.peek().type !== "dedent" && this.peek().type !== "eof") {
        if (this.peek().type === "newline") {
          this.next();
          continue;
        }
        if (this.peek().type === "indent") this.fail(this.peek(), "Unexpected indentation");
        body.push(this.statement(blockDepth + 1));
      }
      if (this.peek().type === "dedent") this.next();
      return body;
    }
    const s = this.simpleStatement();
    this.endOfSimple();
    return [s];
  }

  private simpleStatement(): Stmt {
    const t = this.peek();
    if (t.type === "kw") {
      switch (t.value) {
        case "pass":
          this.next();
          return { k: "pass", pos: this.pos(t) };
        case "break":
          this.next();
          return { k: "break", pos: this.pos(t) };
        case "continue":
          this.next();
          return { k: "continue", pos: this.pos(t) };
        case "return": {
          this.next();
          const nt = this.peek();
          const e = nt.type === "newline" || nt.type === "eof" || nt.type === "dedent" ? null : this.expr();
          return { k: "return", e, pos: this.pos(t) };
        }
        case "if":
        case "while":
        case "for":
        case "def":
        case "try":
          return this.fail(t, `'${t.value}' must start on its own line`);
        default:
          break;
      }
    }
    const e = this.expr();
    const nt = this.peek();
    if (nt.type === "op" && ["=", "+=", "-=", "*=", "/="].includes(nt.value)) {
      this.next();
      if (e.k !== "name" && e.k !== "index") {
        if (e.k === "attr") this.fail(nt, "Cannot assign to an attribute; game objects are read-only");
        this.fail(nt, "Can only assign to a variable or a list element");
      }
      const value = this.expr();
      if (this.isOp("=")) this.fail(this.peek(), "Chained assignment (a = b = c) is not supported");
      return { k: "assign", target: e, op: nt.value as AssignOp, value, pos: this.pos(t) };
    }
    if (nt.type === "op" && nt.value === ",") this.fail(nt, "Tuples and multiple assignment are not supported; use a list [a, b]");
    return { k: "expr", e, pos: this.pos(t) };
  }

  // ---- expressions ----
  expr(): Expr {
    if (++this.exprDepth > MAX_EXPR_DEPTH) this.fail(this.peek(), "Expression is nested too deeply");
    try {
      return this.orExpr();
    } finally {
      this.exprDepth--;
    }
  }
  private orExpr(): Expr {
    let l = this.andExpr();
    while (this.isKw("or")) {
      const t = this.next();
      l = { k: "bool", op: "or", l, r: this.andExpr(), pos: this.pos(t) };
    }
    return l;
  }
  private andExpr(): Expr {
    let l = this.notExpr();
    while (this.isKw("and")) {
      const t = this.next();
      l = { k: "bool", op: "and", l, r: this.notExpr(), pos: this.pos(t) };
    }
    return l;
  }
  private notExpr(): Expr {
    if (this.isKw("not")) {
      const t = this.next();
      return { k: "un", op: "not", e: this.notExpr(), pos: this.pos(t) };
    }
    return this.comparison();
  }
  private cmpOp(): CmpOp | null {
    const t = this.peek();
    if (t.type === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.value)) return t.value as CmpOp;
    if (this.isKw("is")) return this.isKw("not", 1) ? "is not" : "is";
    if (this.isKw("in")) return "in";
    if (this.isKw("not") && this.isKw("in", 1)) return "not in";
    return null;
  }
  private comparison(): Expr {
    const l = this.additive();
    const op = this.cmpOp();
    if (!op) return l;
    const t = this.next();
    if (op === "is not" || op === "not in") this.next();
    const r = this.additive();
    if (this.cmpOp()) this.fail(this.peek(), "Chained comparisons (a < b < c) are not supported; use 'and'");
    return { k: "cmp", op, l, r, pos: this.pos(t) };
  }
  private additive(): Expr {
    let l = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const t = this.next();
      l = { k: "bin", op: t.value as "+" | "-", l, r: this.term(), pos: this.pos(t) };
    }
    return l;
  }
  private term(): Expr {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("//") || this.isOp("%")) {
      const t = this.next();
      l = { k: "bin", op: t.value as "*" | "/" | "//" | "%", l, r: this.unary(), pos: this.pos(t) };
    }
    return l;
  }
  private unary(): Expr {
    if (this.isOp("-") || this.isOp("+")) {
      const t = this.next();
      if (++this.exprDepth > MAX_EXPR_DEPTH) this.fail(t, "Expression is nested too deeply");
      try {
        return { k: "un", op: t.value as "-" | "+", e: this.unary(), pos: this.pos(t) };
      } finally {
        this.exprDepth--;
      }
    }
    return this.postfix();
  }
  private postfix(): Expr {
    let e = this.atom();
    for (;;) {
      if (this.isOp("(")) {
        const t = this.next();
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            if (this.peek().type === "name" && this.isOp("=", 1)) {
              this.fail(this.peek(), "Keyword arguments (name=value) are not supported; pass arguments by position");
            }
            args.push(this.expr());
            if (this.isOp(",")) {
              this.next();
              if (this.isOp(")")) break;
              continue;
            }
            break;
          }
        }
        this.expectOp(")", "to close the argument list");
        if (args.length > 16) this.fail(t, "Too many arguments (limit 16)");
        e = { k: "call", callee: e, args, pos: this.pos(t) };
      } else if (this.isOp(".")) {
        const t = this.next();
        const n = this.peek();
        if (n.type !== "name") this.fail(n, "Expected an attribute name after '.'");
        this.next();
        e = { k: "attr", obj: e, name: n.value, pos: this.pos(t) };
      } else if (this.isOp("[")) {
        const t = this.next();
        if (this.isOp(":")) this.fail(this.peek(), "Slices are not supported");
        const index = this.expr();
        if (this.isOp(":")) this.fail(this.peek(), "Slices are not supported");
        this.expectOp("]", "to close the index");
        e = { k: "index", obj: e, index, pos: this.pos(t) };
      } else {
        return e;
      }
    }
  }
  private atom(): Expr {
    const t = this.peek();
    const pos = this.pos(t);
    switch (t.type) {
      case "num": {
        this.next();
        const v = Number(t.value);
        if (!Number.isFinite(v)) this.fail(t, `Invalid number '${t.value}'`);
        return { k: "num", v, pos };
      }
      case "str":
        this.next();
        return { k: "str", v: t.value, pos };
      case "name":
        this.next();
        return { k: "name", name: t.value, pos };
      case "kw":
        if (t.value === "True" || t.value === "False") {
          this.next();
          return { k: "const", v: t.value === "True", pos };
        }
        if (t.value === "None") {
          this.next();
          return { k: "const", v: null, pos };
        }
        return this.fail(t, `Unexpected keyword '${t.value}'`);
      case "op":
        if (t.value === "(") {
          this.next();
          if (this.isOp(")")) this.fail(this.peek(), "Empty tuples are not supported");
          const e = this.expr();
          if (this.isOp(",")) this.fail(this.peek(), "Tuples are not supported; use a list [a, b]");
          this.expectOp(")", "to close the parenthesis");
          return e;
        }
        if (t.value === "[") {
          this.next();
          const items: Expr[] = [];
          if (!this.isOp("]")) {
            for (;;) {
              items.push(this.expr());
              if (this.isOp(",")) {
                this.next();
                if (this.isOp("]")) break;
                continue;
              }
              break;
            }
          }
          this.expectOp("]", "to close the list");
          if (items.length > 256) this.fail(t, "List literal is too long (limit 256 items)");
          return { k: "list", items, pos };
        }
        if (t.value === "{") {
          this.next();
          const keys: Expr[] = [];
          const values: Expr[] = [];
          if (!this.isOp("}")) {
            for (;;) {
              keys.push(this.expr());
              this.expectOp(":", "between a dictionary key and its value (sets are not supported)");
              values.push(this.expr());
              if (this.isOp(",")) {
                this.next();
                if (this.isOp("}")) break;
                continue;
              }
              break;
            }
          }
          this.expectOp("}", "to close the dictionary");
          if (keys.length > 256) this.fail(t, "Dictionary literal is too long (limit 256 entries)");
          return { k: "dict", keys, values, pos };
        }
        return this.fail(t, `Unexpected '${t.value}'`);
      default:
        return this.fail(t, `Expected an expression, found ${this.describe(t)}`);
    }
  }
}
