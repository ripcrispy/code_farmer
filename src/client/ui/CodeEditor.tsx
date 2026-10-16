import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { findUnitDef } from "../../shared/defs/units.ts";
import type { LibraryProgramInfo, ProgramVersionInfo } from "../../shared/protocol.ts";
import { CodeArea, DiagnosticsBar, useAssistDiagnostics, useDiagnostics, type CodeAreaHandle } from "./CodeArea.tsx";
import { applyFix, diagnose, type Fix } from "../../script/assist.ts";
import { useAssistContext } from "./assistContext.ts";
import { RecipesTab } from "./RecipesTab.tsx";
import { UnitActivity } from "./UnitActivity.tsx";
import { CommandReference } from "./CommandReference.tsx";
import { TraceList } from "./SelectionPanel.tsx";
import { useGame, useUiVersion } from "./context.ts";

type Tab = "recipes" | "reference" | "library" | "history" | "log" | "trace";

/**
 * Program editor for one unit. Diagnostics come from the same compiler the
 * server uses; the server re-validates on save and is the final authority.
 */
export function CodeEditor({ unitId }: { unitId: number }): JSX.Element {
  useUiVersion();
  const { state, actions } = useGame();
  const unit = state.units.get(unitId);
  const def = unit ? findUnitDef(unit.type) : undefined;
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [versions, setVersions] = useState<ProgramVersionInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [serverMsg, setServerMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<Tab>("recipes");
  const diags = useDiagnostics(source, state.player?.unlocks);
  const assist = useAssistContext(state, unit?.type ?? null);
  const problems = useAssistDiagnostics(source, assist);
  const codeRef = useRef<CodeAreaHandle>(null);
  const insert = (code: string): void => codeRef.current?.insertAtCursor(code);
  // Fixes are recomputed for the current text so they never apply to stale offsets.
  const fix = (f: Fix): void => {
    const now = diagnose(source, assist).flatMap((d) => d.fixes).find((x) => x.label === f.label);
    if (now) setSource(applyFix(source, now));
  };

  const reload = useCallback(async () => {
    const r = await actions.getProgram(unitId);
    if (r.t === "program") {
      // A lesson's example replaces the code (unsaved) the first time the editor opens.
      const seed = state.editorSeed;
      state.editorSeed = null;
      setSource(seed ?? r.source);
      setSavedSource(r.source);
      if (seed) setServerMsg({ ok: true, text: "Lesson example loaded. Press Save & run (Ctrl+Enter) to try it." });
      setVersions(r.versions);
      setLoaded(true);
      setLoadError("");
    } else if (r.t === "error") {
      setLoadError(r.message);
    }
  }, [actions, unitId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Esc closes the editor wherever focus is inside the dialog.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") state.openEditor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const dirty = source !== savedSource;
  const runtimeError = unit?.own?.program.error ?? null;
  const errorLines = new Set<number>([...diags.map((d) => d.line), ...(runtimeError && !dirty ? [runtimeError.line] : [])]);
  // The line the unit is executing: the action in progress (from its trace), while the shown code is what runs.
  const trace = unit?.own?.trace ?? [];
  const last = trace[trace.length - 1];
  const running = !dirty && unit?.own?.program.state === "running" && last && last.result === "" ? last.line : null;

  const save = async (run: boolean): Promise<void> => {
    if (diags.length) {
      setServerMsg({ ok: false, text: `Fix the syntax error on line ${diags[0]?.line} first.` });
      return;
    }
    const r = await actions.saveProgram(unitId, source, run);
    if (r.t === "ack") {
      setSavedSource(source);
      setServerMsg({ ok: true, text: r.message ?? "Saved" });
      void reload();
    } else if (r.t === "error") {
      setServerMsg({ ok: false, text: r.message });
    }
  };

  const control = async (a: "run" | "pause" | "resume" | "stop"): Promise<void> => {
    const r = await actions.controlProgram(unitId, a);
    setServerMsg(r.t === "ack" ? { ok: true, text: r.message ?? a } : { ok: false, text: r.t === "error" ? r.message : "?" });
  };

  const restore = async (v: number): Promise<void> => {
    const r = await actions.restoreProgram(unitId, v);
    if (r.t === "ack") {
      setServerMsg({ ok: true, text: r.message ?? "Restored" });
      await reload();
    } else if (r.t === "error") setServerMsg({ ok: false, text: r.message });
  };

  const st = unit?.own?.program.state ?? "?";
  const lib = unit?.own?.program.library;
  return (
    <div className="editor-backdrop" role="dialog" aria-label="Program editor">
      <div className="editor code-editor">
        <div className="editor-head">
          <h2>
            {def?.name ?? "Unit"} #{unitId} program{" "}
            <span className={`badge badge-${st}`}>{st}</span>
            {dirty && <span className="badge badge-dirty">unsaved</span>}
            {lib && <span className="muted small"> · from library “{lib.name}” v{lib.version}</span>}
          </h2>
          <div className="spacer" />
          <button onClick={() => state.openEditor(null)} aria-label="Close editor">Close (Esc)</button>
        </div>
        <div className="editor-toolbar">
          <button className="primary" onClick={() => void save(true)} title="Ctrl+Enter">Save &amp; run</button>
          <button onClick={() => void save(false)} title="Ctrl+S">Save</button>
          <span className="sep" />
          <button onClick={() => void control("run")}>Run</button>
          <button onClick={() => void control("pause")} disabled={st !== "running"}>Pause</button>
          <button onClick={() => void control("resume")} disabled={st !== "paused"}>Resume</button>
          <button onClick={() => void control("stop")} disabled={st !== "running" && st !== "paused"}>Stop</button>
          <span className="sep" />
          <button onClick={() => def && setSource(def.defaultProgram)} title="Load this unit type's default program into the editor (save to apply)">Default program</button>
          <button onClick={() => setSource(savedSource)} disabled={!dirty}>Revert edits</button>
        </div>
        <div className="editor-body">
          <div className="editor-main">
            {loadError && <div className="blocked">{loadError}</div>}
            <CodeArea
              ref={codeRef}
              source={source}
              onChange={setSource}
              errorLines={errorLines}
              disabled={!loaded}
              onSave={() => void save(false)}
              onSaveRun={() => void save(true)}
              assist={assist}
              runningLine={running}
              runtimeError={runtimeError && !dirty ? runtimeError : null}
            />
            {unit && <UnitActivity unitId={unitId} dirty={dirty} />}
            <DiagnosticsBar
              source={source}
              diags={problems}
              onFix={fix}
              extra={
                <>
                  {runtimeError && <div className="err">Runtime error (line {runtimeError.line}): {runtimeError.message}</div>}
                  {serverMsg && <div className={serverMsg.ok ? "ok" : "err"}>Server: {serverMsg.text}</div>}
                </>
              }
            />
          </div>
          <aside className="editor-side">
            <div className="tabs" role="tablist">
              {(["recipes", "reference", "library", "history", "log", "trace"] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                  {t[0]?.toUpperCase()}{t.slice(1)}
                </button>
              ))}
            </div>
            {tab === "recipes" && <RecipesTab onInsert={insert} onReplace={(code) => setSource(code)} />}
            {tab === "reference" && <CommandReference onInsert={insert} />}
            {tab === "library" && (
              <UnitLibraryTab
                unitType={unit?.type ?? ""}
                source={source}
                canSave={diags.length === 0}
                onLoad={(src) => setSource(src)}
                onMessage={setServerMsg}
              />
            )}
            {tab === "history" && (
              <div className="history">
                {versions.length === 0 && <p className="muted">No saved versions yet. The unit is running its default program.</p>}
                {versions.map((v) => (
                  <div key={v.version} className="version">
                    <span>
                      v{v.version} <span className="muted small">{new Date(v.createdAt).toLocaleString()} · {v.note}</span>
                    </span>
                    <button className="small" onClick={() => void restore(v.version)}>Restore</button>
                  </div>
                ))}
              </div>
            )}
            {tab === "log" && <pre className="log tall">{unit?.own?.log?.join("\n") || "(empty)"}</pre>}
            {tab === "trace" && (
              <div className="history">
                <p className="small muted">Each action the program started, the line that called it, and its result.</p>
                <TraceList trace={unit?.own?.trace ?? []} />
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/** Load library programs into the editor, or save the editor's code as a new library program. */
function UnitLibraryTab(props: {
  unitType: string;
  source: string;
  canSave: boolean;
  onLoad: (src: string) => void;
  onMessage: (m: { ok: boolean; text: string }) => void;
}): JSX.Element {
  const { actions, state } = useGame();
  const [programs, setPrograms] = useState<LibraryProgramInfo[] | null>(null);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [onlyType, setOnlyType] = useState(false);
  const refresh = useCallback(async () => {
    const r = await actions.libList();
    if (r.t === "library") setPrograms(r.programs);
  }, [actions]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const load = async (id: number): Promise<void> => {
    const r = await actions.libGet(id);
    if (r.t === "library_program") {
      props.onLoad(r.source);
      props.onMessage({ ok: true, text: `Loaded "${r.program.name}" v${r.version} into the editor. Save to apply it to this unit.` });
    }
  };
  const saveNew = async (): Promise<void> => {
    const r = await actions.libSave({ name, description: "", unitTypes: onlyType ? [props.unitType] : [], shared, source: props.source });
    if (r.t === "ack") {
      setName("");
      void refresh();
    }
  };
  return (
    <div className="history">
      <h4>Save this code to your library</h4>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Program name" maxLength={40} aria-label="Library program name" />
        <button className="primary" disabled={!props.canSave || name.trim().length === 0} onClick={() => void saveNew()}>Save</button>
      </div>
      <label className="check"><input type="checkbox" checked={onlyType} onChange={(e) => setOnlyType(e.target.checked)} /> Only for {props.unitType}s</label>
      <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with other players</label>
      <h4>Load from library</h4>
      {programs === null && <p className="muted">Loading…</p>}
      {programs?.length === 0 && <p className="muted">Your library is empty.</p>}
      {programs?.map((p) => {
        const compatible = p.unitTypes.length === 0 || p.unitTypes.includes(props.unitType);
        return (
          <div key={p.id} className="version">
            <span>
              {p.name} <span className="muted small">v{p.latestVersion}{p.own ? "" : ` · by ${p.ownerName}`}{compatible ? "" : " · incompatible"}</span>
            </span>
            <button className="small" disabled={!compatible} onClick={() => void load(p.id)}>Load</button>
          </div>
        );
      })}
      <button className="link" onClick={() => { state.openEditor(null); state.openLibrary(true); }}>Open the full library…</button>
    </div>
  );
}
