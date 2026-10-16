import type { JSX } from "react";
import { COMMANDS, NAMESPACES } from "../../script/commands.ts";
import { KEYWORDS } from "../../script/lexer.ts";

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));
const TOKEN = /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_"'#]+)/g;

/**
 * Display-only syntax colouring. It is deliberately simple; correctness of the
 * program is decided by the real compiler (diagnostics panel), not by colours.
 */
export function highlightLine(line: string, key: number): JSX.Element {
  const parts: JSX.Element[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line)) !== null) {
    if (m[0] === "") break;
    let cls = "";
    if (m[1]) cls = "tk-comment";
    else if (m[2]) cls = "tk-string";
    else if (m[3]) cls = "tk-number";
    else if (m[4]) {
      const w = m[4];
      if (w === "True" || w === "False" || w === "None") cls = "tk-const";
      else if (KEYWORDS.has(w)) cls = "tk-keyword";
      else if (COMMAND_NAMES.has(w)) cls = "tk-command";
      else if (Object.hasOwn(NAMESPACES, w) || w === "alive") cls = "tk-namespace";
    }
    parts.push(cls ? <span key={i++} className={cls}>{m[0]}</span> : <span key={i++}>{m[0]}</span>);
  }
  return <div key={key}>{parts.length ? parts : "​"}</div>;
}
