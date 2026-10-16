import { ScriptSyntaxError } from "./ast.ts";

export type TokType = "name" | "num" | "str" | "op" | "kw" | "newline" | "indent" | "dedent" | "eof";

export interface Token {
  type: TokType;
  value: string;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  "if", "elif", "else", "while", "for", "in", "def", "return", "break", "continue",
  "pass", "and", "or", "not", "is", "True", "False", "None", "try", "except", "as",
]);

/** Python keywords that are deliberately unsupported; using them yields a clear diagnostic. */
export const UNSUPPORTED_KEYWORDS: Record<string, string> = {
  import: "'import' is not supported: scripts cannot load modules. All game commands are already available.",
  from: "'from' imports are not supported in Code Farmer scripts.",
  class: "'class' is not supported. Use functions (def) and variables instead.",
  lambda: "'lambda' is not supported. Define a named function with 'def' instead.",
  finally: "'finally' is not supported; put clean-up code after the try/except block.",
  raise: "'raise' is not supported.",
  with: "'with' is not supported.",
  yield: "'yield' is not supported.",
  global: "'global' is not supported. Functions can read top-level variables; return values to update them.",
  nonlocal: "'nonlocal' is not supported.",
  async: "'async' is not supported. Actions such as move_to() already wait for completion.",
  await: "'await' is not supported. Actions such as move_to() already wait for completion.",
  del: "'del' is not supported.",
  assert: "'assert' is not supported.",
  exec: "'exec' is not available in Code Farmer scripts.",
  eval: "'eval' is not available in Code Farmer scripts.",
};

const THREE_CHAR_OPS: string[] = [];
const TWO_CHAR_OPS = ["==", "!=", "<=", ">=", "//", "+=", "-=", "*=", "/="];
const ONE_CHAR_OPS = "()[]{},:.+-*/%<>=";

export const MAX_SOURCE_LENGTH = 16_000;
export const MAX_TOKENS = 12_000;
const MAX_INDENT_DEPTH = 24;

export function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ScriptSyntaxError(`Program is too long (${source.length} characters; limit ${MAX_SOURCE_LENGTH})`, 1, 1);
  }
  const tokens: Token[] = [];
  const push = (t: Token): void => {
    tokens.push(t);
    if (tokens.length > MAX_TOKENS) throw new ScriptSyntaxError(`Program is too complex (more than ${MAX_TOKENS} tokens)`, t.line, t.col);
  };
  const indents = [0];
  let depth = 0; // bracket nesting; newlines inside brackets are ignored
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li] ?? "";
    const lineNo = li + 1;
    let i = 0;

    if (depth === 0) {
      // Measure indentation.
      let width = 0;
      while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) {
        width = raw[i] === "\t" ? width + 4 - (width % 4) : width + 1;
        i++;
      }
      const rest = raw.slice(i);
      if (rest.trim() === "" || rest.trimStart().startsWith("#")) continue; // blank or comment line
      const cur = indents[indents.length - 1] ?? 0;
      if (width > cur) {
        if (indents.length >= MAX_INDENT_DEPTH) throw new ScriptSyntaxError("Too many nested blocks", lineNo, i + 1);
        indents.push(width);
        push({ type: "indent", value: "", line: lineNo, col: 1 });
      } else if (width < cur) {
        while (width < (indents[indents.length - 1] ?? 0)) {
          indents.pop();
          push({ type: "dedent", value: "", line: lineNo, col: 1 });
        }
        if (width !== (indents[indents.length - 1] ?? 0)) {
          throw new ScriptSyntaxError("Unindent does not match any outer indentation level", lineNo, i + 1);
        }
      }
    }

    let produced = false;
    while (i < raw.length) {
      const ch = raw[i] as string;
      const col = i + 1;
      if (ch === " " || ch === "\t") {
        i++;
        continue;
      }
      if (ch === "#") break;
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < raw.length && /[A-Za-z0-9_]/.test(raw[j] as string)) j++;
        const word = raw.slice(i, j);
        if (Object.hasOwn(UNSUPPORTED_KEYWORDS, word)) {
          throw new ScriptSyntaxError(UNSUPPORTED_KEYWORDS[word] as string, lineNo, col);
        }
        push({ type: KEYWORDS.has(word) ? "kw" : "name", value: word, line: lineNo, col });
        if (word.startsWith("__")) {
          throw new ScriptSyntaxError(`Names starting with '__' are reserved ('${word}')`, lineNo, col);
        }
        i = j;
        produced = true;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(raw[i + 1] ?? ""))) {
        let j = i;
        while (j < raw.length && /[0-9_]/.test(raw[j] as string)) j++;
        if (raw[j] === "." && /[0-9]/.test(raw[j + 1] ?? "")) {
          j++;
          while (j < raw.length && /[0-9_]/.test(raw[j] as string)) j++;
        } else if (raw[j] === "." && !/[A-Za-z_]/.test(raw[j + 1] ?? "")) {
          j++;
        }
        if (/[A-Za-z_]/.test(raw[j] ?? "")) {
          throw new ScriptSyntaxError(`Invalid number literal '${raw.slice(i, j + 1)}'`, lineNo, col);
        }
        push({ type: "num", value: raw.slice(i, j).replace(/_/g, ""), line: lineNo, col });
        i = j;
        produced = true;
        continue;
      }
      if (ch === '"' || ch === "'") {
        if (raw.slice(i, i + 3) === ch.repeat(3)) {
          throw new ScriptSyntaxError("Triple-quoted strings are not supported; use # comments for notes", lineNo, col);
        }
        let j = i + 1;
        let out = "";
        let closed = false;
        while (j < raw.length) {
          const c = raw[j] as string;
          if (c === "\\") {
            const n = raw[j + 1];
            if (n === undefined) break;
            const map: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"' };
            const m = map[n];
            if (m === undefined) throw new ScriptSyntaxError(`Unsupported escape sequence '\\${n}'`, lineNo, j + 1);
            out += m;
            j += 2;
            continue;
          }
          if (c === ch) {
            closed = true;
            j++;
            break;
          }
          out += c;
          j++;
        }
        if (!closed) throw new ScriptSyntaxError("Unterminated string literal", lineNo, col);
        push({ type: "str", value: out, line: lineNo, col });
        i = j;
        produced = true;
        continue;
      }
      const three = raw.slice(i, i + 3);
      if (THREE_CHAR_OPS.includes(three)) {
        push({ type: "op", value: three, line: lineNo, col });
        i += 3;
        produced = true;
        continue;
      }
      const two = raw.slice(i, i + 2);
      if (two === "**") throw new ScriptSyntaxError("'**' (power) is not supported; multiply explicitly", lineNo, col);
      if (TWO_CHAR_OPS.includes(two)) {
        push({ type: "op", value: two, line: lineNo, col });
        i += 2;
        produced = true;
        continue;
      }
      if (ONE_CHAR_OPS.includes(ch)) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") {
          depth--;
          if (depth < 0) throw new ScriptSyntaxError(`Unmatched '${ch}'`, lineNo, col);
        }
        push({ type: "op", value: ch, line: lineNo, col });
        i++;
        produced = true;
        continue;
      }
      if (ch === ";") throw new ScriptSyntaxError("Semicolons are not supported; put each statement on its own line", lineNo, col);
      throw new ScriptSyntaxError(`Unexpected character '${ch}'`, lineNo, col);
    }
    if (produced && depth === 0) {
      push({ type: "newline", value: "", line: lineNo, col: raw.length + 1 });
    }
  }
  const lastLine = lines.length;
  if (depth > 0) throw new ScriptSyntaxError("Unclosed bracket at end of program", lastLine, 1);
  const last = tokens[tokens.length - 1];
  if (last && last.type !== "newline" && last.type !== "dedent") {
    push({ type: "newline", value: "", line: lastLine, col: 1 });
  }
  while (indents.length > 1) {
    indents.pop();
    push({ type: "dedent", value: "", line: lastLine, col: 1 });
  }
  push({ type: "eof", value: "", line: lastLine, col: 1 });
  return tokens;
}
