import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { UNIT_DEFS } from "../../shared/defs/units.ts";
import type { LibraryProgramInfo, ProgramVersionInfo } from "../../shared/protocol.ts";
import { CodeArea, DiagnosticsBar, useAssistDiagnostics, useDiagnostics } from "./CodeArea.tsx";
import { applyFix, diagnose } from "../../script/assist.ts";
import { useAssistContext } from "./assistContext.ts";
import { useGame, useUiVersion } from "./context.ts";

interface Draft {
  programId: number | null;
  own: boolean;
  ownerName: string;
  name: string;
  description: string;
  unitTypes: string[];
  shared: boolean;
  source: string;
  version: number;
  latestVersion: number;
  versions: ProgramVersionInfo[];
}

const NEW_DRAFT: Draft = {
  programId: null,
  own: true,
  ownerName: "",
  name: "",
  description: "",
  unitTypes: [],
  shared: false,
  source: "while alive:\n    wait(1)\n",
  version: 0,
  latestVersion: 0,
  versions: [],
};

/** The player's code library: named versioned programs, sharing, import/export and group assignment. */
export function LibraryPanel(): JSX.Element {
  useUiVersion();
  const { state, actions } = useGame();
  const [programs, setPrograms] = useState<LibraryProgramInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = state.selectedUnitIds().filter((id) => state.units.get(id)?.owner === state.playerId);
  const [target, setTarget] = useState<string>(selected.length ? "selection" : "type:worker");
  const [runNow, setRunNow] = useState(true);
  const diags = useDiagnostics(draft?.source ?? "", state.player?.unlocks);
  // Library programs may run on any unit type.
  const assist = useAssistContext(state, null);
  const problems = useAssistDiagnostics(draft?.source ?? "", assist);

  const refresh = useCallback(async () => {
    const r = await actions.libList();
    if (r.t === "library") setPrograms(r.programs);
  }, [actions]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") state.openLibrary(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const open = async (id: number, version?: number): Promise<void> => {
    const r = await actions.libGet(id, version);
    if (r.t !== "library_program") {
      if (r.t === "error") setMsg({ ok: false, text: r.message });
      return;
    }
    const p = r.program;
    setDraft({
      programId: p.id,
      own: p.own,
      ownerName: p.ownerName,
      name: p.name,
      description: p.description,
      unitTypes: p.unitTypes,
      shared: p.shared,
      source: r.source,
      version: r.version,
      latestVersion: p.latestVersion,
      versions: r.versions,
    });
    setSaved(r.source);
    setConfirmDelete(false);
    setMsg(null);
  };

  const report = (r: { t: string; message?: string }, okText?: string): boolean => {
    if (r.t === "error") {
      setMsg({ ok: false, text: r.message ?? "Failed" });
      return false;
    }
    setMsg({ ok: true, text: okText ?? r.message ?? "Done" });
    return true;
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    if (diags.length) {
      setMsg({ ok: false, text: `Fix the syntax error on line ${diags[0]?.line} first.` });
      return;
    }
    const p: Parameters<typeof actions.libSave>[0] = { name: draft.name, description: draft.description, unitTypes: draft.unitTypes, shared: draft.shared, source: draft.source };
    if (draft.programId !== null) p.programId = draft.programId;
    const r = await actions.libSave(p);
    if (report(r) && r.t === "ack" && r.id) {
      await refresh();
      await open(r.id);
    }
  };

  const assign = async (): Promise<void> => {
    if (!draft?.programId) return;
    const p: Parameters<typeof actions.libAssign>[0] = { programId: draft.programId, version: draft.version, run: runNow };
    if (target === "selection") p.unitIds = selected;
    else p.unitType = target.slice(5);
    report(await actions.libAssign(p));
  };

  const doExport = async (): Promise<void> => {
    if (!draft?.programId) return;
    const r = await actions.libExport(draft.programId, draft.version);
    if (r.t !== "library_export") return void report(r);
    const blob = new Blob([r.text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setMsg({ ok: true, text: `Downloaded ${r.filename}` });
  };

  const doImport = async (): Promise<void> => {
    const r = await actions.libImport(importText);
    if (report(r) && r.t === "ack" && r.id) {
      setImportOpen(false);
      setImportText("");
      await refresh();
      await open(r.id);
    }
  };

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return programs.filter((p) => !f || p.name.toLowerCase().includes(f) || p.description.toLowerCase().includes(f) || p.ownerName.toLowerCase().includes(f));
  }, [programs, filter]);
  const own = list.filter((p) => p.own);
  const others = list.filter((p) => !p.own);
  const dirty = draft !== null && draft.source !== saved;
  const editable = draft?.own ?? false;
  const unitTypes = Object.keys(UNIT_DEFS);

  return (
    <div className="editor-backdrop" role="dialog" aria-label="Code library">
      <div className="editor">
        <div className="editor-head">
          <h2>Code library</h2>
          <div className="spacer" />
          <button onClick={() => state.openLibrary(false)}>Close (Esc)</button>
        </div>
        <div className="editor-body">
          <aside className="lib-list">
            <div className="row">
              <button className="primary" onClick={() => { setDraft({ ...NEW_DRAFT }); setSaved(""); setMsg(null); }}>New</button>
              <button onClick={() => setImportOpen((v) => !v)}>Import</button>
            </div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter programs" />
            {importOpen && (
              <div className="import">
                <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste an exported .cfprog.json" aria-label="Import text" />
                <input
                  type="file"
                  accept=".json,application/json"
                  aria-label="Import file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void f.text().then(setImportText);
                  }}
                />
                <button className="primary" disabled={!importText.trim()} onClick={() => void doImport()}>Import program</button>
              </div>
            )}
            <h4>My programs ({own.length})</h4>
            {own.length === 0 && <p className="muted small">None yet. Save code here or from a unit's editor.</p>}
            {own.map((p) => (
              <button key={p.id} className={`lib-item ${draft?.programId === p.id ? "active" : ""}`} onClick={() => void open(p.id)}>
                <b>{p.name}</b> <span className="muted small">v{p.latestVersion}{p.shared ? " · shared" : ""}</span>
                {p.description && <span className="muted small block">{p.description}</span>}
              </button>
            ))}
            <h4>Shared by others ({others.length})</h4>
            {others.map((p) => (
              <button key={p.id} className={`lib-item ${draft?.programId === p.id ? "active" : ""}`} onClick={() => void open(p.id)}>
                <b>{p.name}</b> <span className="muted small">v{p.latestVersion} · {p.ownerName}</span>
              </button>
            ))}
          </aside>
          {draft ? (
            <div className="editor-main">
              <div className="lib-meta">
                <input value={draft.name} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name" maxLength={40} aria-label="Program name" />
                <input value={draft.description} disabled={!editable} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" maxLength={500} aria-label="Description" />
                <div className="row wrap">
                  <span className="muted small">Compatible units:</span>
                  {unitTypes.map((t) => (
                    <label key={t} className="check">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={draft.unitTypes.includes(t)}
                        onChange={(e) => setDraft({ ...draft, unitTypes: e.target.checked ? [...draft.unitTypes, t] : draft.unitTypes.filter((x) => x !== t) })}
                      />
                      {t}
                    </label>
                  ))}
                  <span className="muted small">{draft.unitTypes.length === 0 ? "(none ticked = any unit)" : ""}</span>
                </div>
                <div className="row wrap">
                  <label className="check">
                    <input type="checkbox" disabled={!editable} checked={draft.shared} onChange={(e) => setDraft({ ...draft, shared: e.target.checked })} /> Share with other players
                  </label>
                  {!draft.own && <span className="muted small">By {draft.ownerName} (read-only; copy it to edit)</span>}
                  {draft.programId !== null && (
                    <label className="small">
                      Version{" "}
                      <select value={draft.version} onChange={(e) => void open(draft.programId as number, Number(e.target.value))}>
                        {draft.versions.map((v) => (
                          <option key={v.version} value={v.version}>v{v.version} · {v.note} · {new Date(v.createdAt).toLocaleDateString()}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
              <div className="editor-toolbar">
                {editable && <button className="primary" onClick={() => void save()}>{draft.programId === null ? "Create" : dirty || draft.version !== draft.latestVersion ? "Save as new version" : "Save details"}</button>}
                {draft.programId !== null && <button onClick={() => void actions.libCopy(draft.programId as number).then((r) => { if (report(r)) void refresh(); })}>Copy to my library</button>}
                {draft.programId !== null && <button onClick={() => void doExport()}>Export</button>}
                {draft.own && draft.programId !== null && (
                  confirmDelete ? (
                    <button className="danger" onClick={() => void actions.libDelete(draft.programId as number).then((r) => { if (report(r)) { setDraft(null); void refresh(); } })}>Confirm delete</button>
                  ) : (
                    <button onClick={() => setConfirmDelete(true)}>Delete</button>
                  )
                )}
              </div>
              <CodeArea source={draft.source} onChange={(s) => setDraft({ ...draft, source: s })} errorLines={new Set(diags.map((d) => d.line))} readOnly={!editable} onSave={() => void save()} assist={assist} />
              <DiagnosticsBar
                source={draft.source}
                diags={problems}
                onFix={
                  editable
                    ? (f) => {
                        const now = diagnose(draft.source, assist).flatMap((d) => d.fixes).find((x) => x.label === f.label);
                        if (now) setDraft({ ...draft, source: applyFix(draft.source, now) });
                      }
                    : undefined
                }
                extra={msg ? <div className={msg.ok ? "ok" : "err"}>{msg.text}</div> : null} />
              {draft.programId !== null && (
                <div className="editor-toolbar">
                  <b>Assign v{draft.version} to</b>
                  <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Assignment target">
                    <option value="selection" disabled={selected.length === 0}>Selected units ({selected.length})</option>
                    {unitTypes.map((t) => (
                      <option key={t} value={`type:${t}`}>All my {t}s</option>
                    ))}
                  </select>
                  <label className="check"><input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} /> run now</label>
                  <button className="primary" disabled={dirty} title={dirty ? "Save your edits first" : ""} onClick={() => void assign()}>Assign</button>
                </div>
              )}
            </div>
          ) : (
            <div className="editor-main lib-empty">
              <p className="muted">Select a program, create a new one, or import one.</p>
              <p className="muted small">
                Library programs are reusable: assign one to a group of units (shift-click or shift-drag on the map to select several), share it with other
                players, or export it as a file. Units keep their code if a program is later edited; assign again to update them.
              </p>
              {msg && <div className={msg.ok ? "ok" : "err"}>{msg.text}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
