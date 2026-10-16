/** AST for the Code Farmer script language. Every node carries a source position. */

export interface Pos {
  line: number;
  col: number;
}

export type Expr =
  | { k: "num"; v: number; pos: Pos }
  | { k: "str"; v: string; pos: Pos }
  | { k: "const"; v: boolean | null; pos: Pos }
  | { k: "name"; name: string; pos: Pos }
  | { k: "list"; items: Expr[]; pos: Pos }
  | { k: "dict"; keys: Expr[]; values: Expr[]; pos: Pos }
  | { k: "bin"; op: BinOp; l: Expr; r: Expr; pos: Pos }
  | { k: "un"; op: "-" | "+" | "not"; e: Expr; pos: Pos }
  | { k: "bool"; op: "and" | "or"; l: Expr; r: Expr; pos: Pos }
  | { k: "cmp"; op: CmpOp; l: Expr; r: Expr; pos: Pos }
  | { k: "call"; callee: Expr; args: Expr[]; pos: Pos }
  | { k: "attr"; obj: Expr; name: string; pos: Pos }
  | { k: "index"; obj: Expr; index: Expr; pos: Pos };

export type BinOp = "+" | "-" | "*" | "/" | "//" | "%";
export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "is" | "is not" | "in" | "not in";
export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=";

export type Stmt =
  | { k: "expr"; e: Expr; pos: Pos }
  | { k: "assign"; target: Expr; op: AssignOp; value: Expr; pos: Pos }
  | { k: "if"; branches: { cond: Expr; body: Stmt[] }[]; orelse: Stmt[] | null; pos: Pos }
  | { k: "while"; cond: Expr; body: Stmt[]; pos: Pos }
  | { k: "for"; name: string; iter: Expr; body: Stmt[]; pos: Pos }
  | { k: "def"; name: string; params: string[]; body: Stmt[]; pos: Pos }
  | { k: "try"; body: Stmt[]; errName: string | null; handler: Stmt[]; pos: Pos }
  | { k: "return"; e: Expr | null; pos: Pos }
  | { k: "break"; pos: Pos }
  | { k: "continue"; pos: Pos }
  | { k: "pass"; pos: Pos };

export interface Diagnostic {
  message: string;
  line: number;
  col: number;
  severity: "error" | "warning";
}

export class ScriptSyntaxError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = "ScriptSyntaxError";
    this.line = line;
    this.col = col;
  }
}
