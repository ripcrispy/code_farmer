import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type JSX } from "react";
import { Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentService, indentUnit } from "@codemirror/language";
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { forceLinting, linter, lintGutter, type Action, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { compileSource } from "../../script/compiler.ts";
import type { Diagnostic } from "../../script/ast.ts";
import { COMMANDS, NAMESPACES } from "../../script/commands.ts";
import { KEYWORDS } from "../../script/lexer.ts";
import { complete, defaultContext, diagnose, hoverAt, signatureAt, type AssistContext, type AssistDiagnostic, type AssistOption, type Fix } from "../../script/assist.ts";

/** Compiler errors only (the server's verdict on whether the program can be saved), debounced. */
export function useDiagnostics(source: string, unlocks: readonly string[] = []): Diagnostic[] {
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const key = unlocks.join(",");
  useEffect(() => {
    const t = setTimeout(() => {
      const r = compileSource(source, { unlocks: key ? key.split(",") : [] });
      setDiags(r.ok ? [] : r.diagnostics);
    }, 200);
    return () => clearTimeout(t);
  }, [source, key]);
  return diags;
}

/** Errors with explanations and quick fixes, plus beginner warnings, debounced. */
export function useAssistDiagnostics(source: string, ctx: AssistContext): AssistDiagnostic[] {
  const [diags, setDiags] = useState<AssistDiagnostic[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setDiags(diagnose(source, ctx)), 250);
    return () => clearTimeout(t);
  }, [source, ctx]);
  return diags;
}

// ---------------------------------------------------------------- syntax colouring (same classes as before)

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));
const TOKEN = /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
const MARKS: Record<string, Decoration> = Object.fromEntries(["tk-comment", "tk-string", "tk-number", "tk-const", "tk-keyword", "tk-command", "tk-namespace"].map((c) => [c, Decoration.mark({ class: c })]));

function colourise(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      TOKEN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOKEN.exec(line.text)) !== null) {
        if (m[0] === "") {
          TOKEN.lastIndex++;
          continue;
        }
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
        if (cls) b.add(line.from + m.index, line.from + m.index + m[0].length, MARKS[cls] as Decoration);
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

const colourPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = colourise(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = colourise(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------- the line the unit is executing

const setRunningLine = StateEffect.define<number | null>();
const runningLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let d = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setRunningLine)) continue;
      if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) d = Decoration.none;
      else d = Decoration.set([Decoration.line({ class: "cm-cf-running" }).range(tr.state.doc.line(e.value).from)]);
    }
    return d;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------- signature help (above the cursor)

function signatureTooltips(state: EditorState): readonly Tooltip[] {
  const sel = state.selection.main;
  if (!sel.empty) return [];
  const help = signatureAt(state.doc.toString(), sel.head);
  if (!help) return [];
  return [
    {
      pos: sel.head,
      above: true,
      strictSide: true,
      arrow: false,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-cf-sig";
        const head = document.createElement("div");
        head.className = "cm-cf-sig-label";
        head.append(`${help.name}(`);
        help.params.forEach((p, i) => {
          if (i) head.append(", ");
          const s = document.createElement(i === Math.min(help.active, help.params.length - 1) && help.params.length ? "b" : "span");
          s.textContent = p;
          head.append(s);
        });
        head.append(")");
        const body = document.createElement("div");
        body.className = "cm-cf-sig-body";
        body.textContent = help.returns ? `${help.description} Returns: ${help.returns}.` : help.description;
        dom.append(head, body);
        return { dom };
      },
    },
  ];
}

const signatureField = StateField.define<readonly Tooltip[]>({
  create: (s) => signatureTooltips(s),
  update: (t, tr) => (tr.docChanged || tr.selection ? signatureTooltips(tr.state) : t),
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
});

// ---------------------------------------------------------------- completions

type CfCompletion = Completion & { cfNote?: string };

const KIND_TYPE: Record<AssistOption["kind"], string> = {
  command: "function",
  keyword: "keyword",
  variable: "variable",
  function: "method",
  constant: "constant",
  namespace: "namespace",
  attribute: "property",
  value: "text",
  snippet: "type",
};

function toCompletion(o: AssistOption): CfCompletion {
  return {
    label: o.label,
    detail: o.note ? "⚠" : o.detail,
    type: KIND_TYPE[o.kind],
    boost: Math.max(-99, -o.rank),
    cfNote: o.note,
    info: () => {
      const dom = document.createElement("div");
      dom.className = "cm-cf-info";
      if (o.detail) {
        const sig = document.createElement("code");
        sig.textContent = o.detail;
        dom.append(sig);
      }
      if (o.info) {
        const p = document.createElement("p");
        p.textContent = o.info;
        dom.append(p);
      }
      if (o.note) {
        const n = document.createElement("p");
        n.className = "cm-cf-note";
        n.textContent = `⚠ ${o.note}`;
        dom.append(n);
      }
      return dom;
    },
    apply: (view, _c, from, to) => {
      view.dispatch({ changes: { from, to, insert: o.insert }, selection: { anchor: from + (o.cursor ?? o.insert.length) }, userEvent: "input.complete" });
      // A command whose first argument is a word ("tree", "wood"…) opens the list of words.
      if (o.kind === "command" && o.insert.endsWith('("")')) setTimeout(() => startCompletion(view), 0);
    },
  };
}

// ---------------------------------------------------------------- the editor

export interface CodeAreaHandle {
  /** Insert text at the cursor (re-indented to the cursor's line) and focus the editor. */
  insertAtCursor(text: string): void;
  focus(): void;
}

export interface CodeAreaProps {
  source: string;
  onChange: (s: string) => void;
  /** Kept for compatibility; problems are shown as underlines from the assistant. */
  errorLines?: Set<number>;
  disabled?: boolean;
  readOnly?: boolean;
  onSave?: () => void;
  onSaveRun?: () => void;
  label?: string;
  /** What the program is for (unit type, unlocks…) to tailor suggestions. */
  assist?: AssistContext;
  /** Line the unit is executing right now (highlighted), or null. */
  runningLine?: number | null;
  /** Last runtime error, shown on its line. */
  runtimeError?: { line: number; message: string } | null;
}

/**
 * Code editor (CodeMirror 6) with Code Farmer colouring, auto-indent, autocomplete that
 * knows the unit, parameter hints, hover documentation, problem underlines with quick
 * fixes, and the line the unit is running. Validity is still decided by the compiler.
 */
export const CodeArea = forwardRef<CodeAreaHandle, CodeAreaProps>(function CodeArea(props, ref): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const ctxRef = useRef<AssistContext>(props.assist ?? defaultContext());
  ctxRef.current = props.assist ?? defaultContext();
  const editable = useMemo(() => new Compartment(), []);

  useEffect(() => {
    if (!host.current) return;
    const lint = linter(
      (view): CmDiagnostic[] => {
        const text = view.state.doc.toString();
        const out: CmDiagnostic[] = diagnose(text, ctxRef.current).map((d) => ({
          from: Math.min(d.from, text.length),
          to: Math.min(Math.max(d.to, d.from), text.length),
          severity: d.severity,
          message: d.hint ? `${d.message}\n💡 ${d.hint}` : d.message,
          actions: d.fixes.map(
            (f): Action => ({
              name: f.label,
              apply: (v) => {
                // Fixes refer to the text they were computed for.
                if (v.state.doc.toString() === text) v.dispatch({ changes: f.changes, userEvent: "input.fix" });
              },
            }),
          ),
        }));
        const rt = latest.current.runtimeError;
        if (rt && rt.line >= 1 && rt.line <= view.state.doc.lines) {
          const l = view.state.doc.line(rt.line);
          out.push({ from: l.from, to: Math.max(l.from, l.to), severity: "error", message: `Runtime error: ${rt.message}` });
        }
        return out;
      },
      { delay: 300 },
    );
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      indentUnit.of("    "),
      EditorState.tabSize.of(4),
      indentService.of((cx, pos) => {
        const line = cx.lineAt(pos, -1);
        const text = line.text.slice(0, Math.max(0, pos - line.from));
        const base = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
        return text.replace(/#.*$/, "").trimEnd().endsWith(":") ? base + 4 : base;
      }),
      colourPlugin,
      runningLineField,
      signatureField,
      autocompletion({
        override: [
          (cx: CompletionContext): CompletionResult | null => {
            const r = complete(cx.state.doc.toString(), cx.pos, ctxRef.current, cx.explicit);
            if (!r) return null;
            return { from: r.from, to: r.to, options: r.options.map(toCompletion), filter: false };
          },
        ],
        icons: true,
        optionClass: (c) => ((c as CfCompletion).cfNote ? "cm-cf-unavailable" : ""),
        maxRenderedOptions: 60,
      }),
      hoverTooltip((view, pos) => {
        const h = hoverAt(view.state.doc.toString(), pos, ctxRef.current);
        if (!h) return null;
        return {
          pos: h.from,
          end: h.to,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "cm-cf-hover";
            const t = document.createElement("code");
            t.textContent = h.title;
            const b = document.createElement("div");
            b.textContent = h.body;
            dom.append(t, b);
            return { dom };
          },
        };
      }),
      lint,
      lintGutter(),
      Prec.highest(
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (latest.current.onSave?.(), true) },
          { key: "Mod-Enter", preventDefault: true, run: () => (latest.current.onSaveRun?.(), true) },
          { key: "Tab", run: acceptCompletion },
        ]),
      ),
      keymap.of([...closeBracketsKeymap, ...completionKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
      editable.of([EditorState.readOnly.of(!!(props.readOnly || props.disabled)), EditorView.editable.of(!props.disabled)]),
      EditorView.contentAttributes.of({ "aria-label": props.label ?? "Program source", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange(u.state.doc.toString());
      }),
      EditorView.theme(
        {
          "&": { height: "100%", backgroundColor: "#0b0e11", color: "var(--text)", fontSize: "13px" },
          ".cm-content": { fontFamily: "var(--mono)", caretColor: "#fff", padding: "8px 0" },
          ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "18px" },
          ".cm-gutters": { backgroundColor: "#0b0e11", color: "#5b6670", borderRight: "1px solid var(--border)" },
          ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.035)" },
          ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.06)" },
          "&.cm-focused .cm-cursor": { borderLeftColor: "#fff" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(79, 143, 214, 0.35) !important" },
          ".cm-tooltip": { backgroundColor: "#1a2028", border: "1px solid #3a4450", color: "var(--text)" },
          ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#2f4a6a", color: "#fff" },
          ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", maxHeight: "16em" },
        },
        { dark: true },
      ),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: latest.current.source, extensions: exts }), parent: host.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once; later prop changes are pushed in by the effects below.
  }, []);

  // Source replaced from outside (load, revert, default program…).
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== props.source) v.dispatch({ changes: { from: 0, to: cur.length, insert: props.source } });
  }, [props.source]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(!!(props.readOnly || props.disabled)), EditorView.editable.of(!props.disabled)]) });
  }, [props.readOnly, props.disabled, editable]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setRunningLine.of(props.runningLine ?? null) });
  }, [props.runningLine, props.source]);

  // Re-check when the runtime error or the unit's context changes (not only on typing).
  useEffect(() => {
    if (viewRef.current) forceLinting(viewRef.current);
  }, [props.runtimeError?.line, props.runtimeError?.message, props.assist]);

  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor(text: string): void {
        const v = viewRef.current;
        if (!v) return;
        const sel = v.state.selection.main;
        const line = v.state.doc.lineAt(sel.from);
        const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
        const atBlank = line.text.trim() === "";
        const body = text.replace(/\n$/, "").split("\n").map((l, i) => (i === 0 ? l : indent + l)).join("\n");
        // On a non-empty line, insert on a new line below (same indentation).
        const insert = atBlank ? body : `\n${indent}${body}`;
        const from = atBlank ? line.from + indent.length : line.to;
        const to = atBlank ? line.to : line.to;
        v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.paste", scrollIntoView: true });
        v.focus();
      },
      focus(): void {
        viewRef.current?.focus();
      },
    }),
    [],
  );

  return <div className="code cm-host" ref={host} />;
});

/** Problems list under the editor: explanations and one-click fixes. */
export function DiagnosticsBar(props: { source: string; diags: AssistDiagnostic[]; onFix?: (fix: Fix) => void; extra?: JSX.Element | null }): JSX.Element {
  const errors = props.diags.filter((d) => d.severity === "error");
  return (
    <div className="diagnostics" aria-live="polite">
      {errors.length === 0 && <div className="ok">✓ No syntax errors ({props.source.length} / 16000 characters)</div>}
      {props.diags.map((d, i) => (
        <div key={i} className={d.severity === "error" ? "err" : "warn"}>
          {d.severity === "error" ? "✖" : "⚠"} Line {d.line}: {d.message}
          {d.hint && <div className="hint">💡 {d.hint}</div>}
          {props.onFix && d.fixes.length > 0 && (
            <div className="fixes">
              {d.fixes.map((f, k) => (
                <button key={k} className="small" onClick={() => props.onFix?.(f)}>
                  Fix: {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {props.extra}
    </div>
  );
}
