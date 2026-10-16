import { findUnitDef } from "../shared/defs/units.ts";
import { LIMITS, type LibraryProgramInfo, type ServerMessage } from "../shared/protocol.ts";
import { LANGUAGE_VERSION, compileSource } from "../script/compiler.ts";
import { COMMANDS } from "../script/commands.ts";
import type { World } from "../sim/world.ts";
import type { GameStore, LibraryMeta, LibraryProgramRecord } from "./persistence/store.ts";

/**
 * Player code library: named, versioned programs that can be assigned to groups of
 * units, exported to and imported from a validated text format, and optionally shared.
 * Every program is only ever source text for the game interpreter; nothing here evaluates code.
 */

export const LIBRARY_FORMAT = "codefarmer-program";
export const LIBRARY_FORMAT_VERSION = 1;
export const MAX_LIBRARY_PROGRAMS = 100;
/** Every unlockable command: used where program text is stored but not run. */
const ALL_UNLOCKS: ReadonlySet<string> = new Set(COMMANDS.flatMap((c) => (c.requires ? [c.requires] : [])));
const NAME_RE = /^[A-Za-z0-9 _\-().,'!]+$/;

type Reply = ServerMessage[];

function err(reqId: number, code: string, message: string): Reply {
  return [{ t: "error", reqId, code, message }];
}

export function libInfo(r: LibraryProgramRecord, viewerId: number): LibraryProgramInfo {
  return {
    id: r.id,
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    own: r.ownerId === viewerId,
    name: r.name,
    description: r.description,
    unitTypes: r.unitTypes,
    shared: r.shared,
    latestVersion: r.latestVersion,
    updatedAt: r.updatedAt,
  };
}

/** Validate metadata; returns an error message or null. */
export function validateMeta(meta: LibraryMeta): string | null {
  const name = meta.name.trim();
  if (name.length < 1 || name.length > LIMITS.maxLibraryName) return `Program name must be 1-${LIMITS.maxLibraryName} characters`;
  if (!NAME_RE.test(name)) return "Program name may contain letters, digits, spaces and - _ ( ) . , ' !";
  if (meta.description.length > LIMITS.maxLibraryDescription) return `Description must be at most ${LIMITS.maxLibraryDescription} characters`;
  if (meta.unitTypes.length > 10) return "At most 10 unit types";
  for (const t of meta.unitTypes) if (!findUnitDef(t)) return `Unknown unit type '${t}'`;
  return null;
}

function checkSource(source: string, unlocks: ReadonlySet<string>): string | null {
  const c = compileSource(source, { unlocks });
  if (c.ok) return null;
  const d = c.diagnostics[0];
  return d ? `Line ${d.line}, col ${d.col}: ${d.message}` : "Syntax error";
}

/** Read access: own programs, or programs their owner shared. */
function readable(store: GameStore, pid: number, programId: number): LibraryProgramRecord | null {
  const p = store.libGet(programId);
  if (!p) return null;
  if (p.ownerId !== pid && !p.shared) return null;
  return p;
}

export function exportText(p: LibraryProgramRecord, source: string, languageVersion: number): string {
  return JSON.stringify(
    {
      format: LIBRARY_FORMAT,
      formatVersion: LIBRARY_FORMAT_VERSION,
      languageVersion,
      name: p.name,
      description: p.description,
      unitTypes: p.unitTypes,
      source,
    },
    null,
    2,
  );
}

/** Strictly parse an exported program. Unknown fields, wrong types and newer versions are rejected. */
export function parseImport(text: string, unlocks: ReadonlySet<string> = new Set()): { ok: true; meta: LibraryMeta; source: string } | { ok: false; message: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, message: "Import is not valid JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, message: "Import must be a JSON object" };
  const o = v as Record<string, unknown>;
  const allowed = new Set(["format", "formatVersion", "languageVersion", "name", "description", "unitTypes", "source"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return { ok: false, message: `Unknown field '${k}' in import` };
  if (o.format !== LIBRARY_FORMAT) return { ok: false, message: `Not a Code Farmer program (format must be "${LIBRARY_FORMAT}")` };
  if (o.formatVersion !== LIBRARY_FORMAT_VERSION) return { ok: false, message: `Unsupported format version ${String(o.formatVersion)}` };
  if (typeof o.languageVersion !== "number" || !Number.isInteger(o.languageVersion) || o.languageVersion < 1) return { ok: false, message: "languageVersion must be a positive integer" };
  if (o.languageVersion > LANGUAGE_VERSION) return { ok: false, message: `Program needs language version ${o.languageVersion}; this server supports ${LANGUAGE_VERSION}` };
  if (typeof o.name !== "string" || typeof o.description !== "string" || typeof o.source !== "string") return { ok: false, message: "name, description and source must be strings" };
  if (!Array.isArray(o.unitTypes) || !o.unitTypes.every((t) => typeof t === "string")) return { ok: false, message: "unitTypes must be a list of strings" };
  if (o.source.length > LIMITS.maxSourceLength) return { ok: false, message: `source exceeds ${LIMITS.maxSourceLength} characters` };
  const meta: LibraryMeta = { name: o.name.trim(), description: o.description, unitTypes: o.unitTypes as string[], shared: false };
  const m = validateMeta(meta);
  if (m) return { ok: false, message: m };
  const s = checkSource(o.source, unlocks);
  if (s) return { ok: false, message: `Imported program does not compile: ${s}` };
  return { ok: true, meta, source: o.source };
}

function uniqueName(store: GameStore, pid: number, base: string): string {
  const trimmed = base.slice(0, LIMITS.maxLibraryName - 5);
  if (!store.libFindByName(pid, trimmed)) return trimmed;
  for (let i = 2; i < 1000; i++) {
    const n = `${trimmed} (${i})`.slice(0, LIMITS.maxLibraryName);
    if (!store.libFindByName(pid, n)) return n;
  }
  return `${trimmed} ${Date.now() % 100000}`;
}

export type LibraryRequest =
  | { t: "lib_list"; reqId: number }
  | { t: "lib_get"; reqId: number; programId: number; version?: number }
  | { t: "lib_save"; reqId: number; programId?: number; name: string; description: string; unitTypes: string[]; shared: boolean; source: string }
  | { t: "lib_delete"; reqId: number; programId: number }
  | { t: "lib_copy"; reqId: number; programId: number }
  | { t: "lib_assign"; reqId: number; programId: number; version?: number; unitIds?: number[]; unitType?: string; run: boolean }
  | { t: "lib_export"; reqId: number; programId: number; version?: number }
  | { t: "lib_import"; reqId: number; text: string };

export function handleLibrary(world: World, store: GameStore, pid: number, msg: LibraryRequest): Reply {
  const reqId = msg.reqId;
  switch (msg.t) {
    case "lib_list":
      return [{ t: "library", reqId, programs: store.libList(pid).map((r) => libInfo(r, pid)) }];
    case "lib_get": {
      const p = readable(store, pid, msg.programId);
      if (!p) return err(reqId, "not_found", "Program not found (or not shared with you)");
      const v = store.libGetVersion(p.id, msg.version ?? p.latestVersion);
      if (!v) return err(reqId, "not_found", `Version ${msg.version ?? p.latestVersion} not found`);
      const versions = store.libVersions(p.id, 30).map((x) => ({ version: x.version, createdAt: x.createdAt, note: x.note }));
      return [{ t: "library_program", reqId, program: libInfo(p, pid), version: v.version, source: v.source, versions }];
    }
    case "lib_save": {
      const meta: LibraryMeta = { name: msg.name.trim(), description: msg.description, unitTypes: msg.unitTypes, shared: msg.shared };
      const m = validateMeta(meta);
      if (m) return err(reqId, "bad_request", m);
      // Library programs are text: saving may use commands you have not unlocked yet (assignment checks them).
      const s = checkSource(msg.source, ALL_UNLOCKS);
      if (s) return err(reqId, "syntax_error", s);
      const clash = store.libFindByName(pid, meta.name);
      if (msg.programId === undefined) {
        if (clash) return err(reqId, "name_taken", `You already have a program named "${meta.name}"`);
        if (store.libCount(pid) >= MAX_LIBRARY_PROGRAMS) return err(reqId, "limit", `Library limit reached (${MAX_LIBRARY_PROGRAMS} programs)`);
        const p = store.libCreate(pid, meta, msg.source, LANGUAGE_VERSION, "created");
        return [{ t: "ack", reqId, id: p.id, message: `Saved "${p.name}" v1` }];
      }
      const p = store.libGet(msg.programId);
      if (!p) return err(reqId, "not_found", "Program not found");
      if (p.ownerId !== pid) return err(reqId, "permission_denied", "Permission denied: only the author can change a program; copy it to your library first");
      if (clash && clash.id !== p.id) return err(reqId, "name_taken", `You already have a program named "${meta.name}"`);
      const version = store.libUpdate(p.id, meta, msg.source, LANGUAGE_VERSION, "edited");
      return [{ t: "ack", reqId, id: p.id, message: `Saved "${meta.name}" v${version}` }];
    }
    case "lib_delete": {
      const p = store.libGet(msg.programId);
      if (!p) return err(reqId, "not_found", "Program not found");
      if (p.ownerId !== pid) return err(reqId, "permission_denied", "Permission denied: not your program");
      store.libDelete(p.id);
      return [{ t: "ack", reqId, message: `Deleted "${p.name}" (units keep their current code)` }];
    }
    case "lib_copy": {
      const p = readable(store, pid, msg.programId);
      if (!p) return err(reqId, "not_found", "Program not found (or not shared with you)");
      if (store.libCount(pid) >= MAX_LIBRARY_PROGRAMS) return err(reqId, "limit", `Library limit reached (${MAX_LIBRARY_PROGRAMS} programs)`);
      const v = store.libGetVersion(p.id, p.latestVersion);
      if (!v) return err(reqId, "not_found", "Program has no versions");
      const s = checkSource(v.source, ALL_UNLOCKS);
      if (s) return err(reqId, "syntax_error", `Program no longer compiles: ${s}`);
      const name = uniqueName(store, pid, p.ownerId === pid ? `${p.name} copy` : p.name);
      const note = p.ownerId === pid ? `copied from "${p.name}" v${v.version}` : `copied from ${p.ownerName}'s "${p.name}" v${v.version}`;
      const copy = store.libCreate(pid, { name, description: p.description, unitTypes: p.unitTypes, shared: false }, v.source, LANGUAGE_VERSION, note);
      return [{ t: "ack", reqId, id: copy.id, message: `Copied to your library as "${copy.name}"` }];
    }
    case "lib_export": {
      const p = readable(store, pid, msg.programId);
      if (!p) return err(reqId, "not_found", "Program not found (or not shared with you)");
      const v = store.libGetVersion(p.id, msg.version ?? p.latestVersion);
      if (!v) return err(reqId, "not_found", "Version not found");
      const filename = `${p.name.replace(/[^A-Za-z0-9_-]+/g, "_")}.v${v.version}.cfprog.json`;
      return [{ t: "library_export", reqId, filename, text: exportText(p, v.source, v.languageVersion) }];
    }
    case "lib_import": {
      const r = parseImport(msg.text, ALL_UNLOCKS);
      if (!r.ok) return err(reqId, "bad_import", r.message);
      if (store.libCount(pid) >= MAX_LIBRARY_PROGRAMS) return err(reqId, "limit", `Library limit reached (${MAX_LIBRARY_PROGRAMS} programs)`);
      const name = uniqueName(store, pid, r.meta.name);
      const p = store.libCreate(pid, { ...r.meta, name }, r.source, LANGUAGE_VERSION, "imported");
      return [{ t: "ack", reqId, id: p.id, message: `Imported "${p.name}"` }];
    }
    case "lib_assign": {
      const p = readable(store, pid, msg.programId);
      if (!p) return err(reqId, "not_found", "Program not found (or not shared with you)");
      const v = store.libGetVersion(p.id, msg.version ?? p.latestVersion);
      if (!v) return err(reqId, "not_found", "Version not found");
      const s = checkSource(v.source, world.mods(pid).unlocks);
      if (s) return err(reqId, "syntax_error", `Program cannot run for you: ${s}`);
      const ids = msg.unitIds ?? [...world.unitsOf(pid)].filter((id) => world.units.get(id)?.type === msg.unitType);
      // Validate ownership of every unit before changing any of them.
      for (const id of ids) {
        const u = world.units.get(id);
        if (u && u.owner !== pid) return err(reqId, "permission_denied", `Permission denied: unit #${id} is not yours`);
      }
      const skipped: string[] = [];
      let assigned = 0;
      for (const id of ids) {
        const u = world.units.get(id);
        if (!u) {
          skipped.push(`#${id} not found`);
          continue;
        }
        if (p.unitTypes.length > 0 && !p.unitTypes.includes(u.type)) {
          skipped.push(`#${id} (${u.type}) is not a compatible unit type`);
          continue;
        }
        const unitVersion = store.addProgramVersion(u.id, v.source, LANGUAGE_VERSION, `from library "${p.name}" v${v.version}`);
        const r = world.setProgram(pid, u.id, v.source, unitVersion, { id: p.id, version: v.version, name: p.name });
        if (!r.ok) {
          skipped.push(`#${id}: ${r.message}`);
          continue;
        }
        if (msg.run && u.program.state !== "running") world.controlProgram(pid, u.id, "run");
        assigned++;
      }
      if (assigned === 0) {
        return err(reqId, "no_units", ids.length === 0 ? "No matching units" : `No units were assigned: ${skipped.slice(0, 3).join("; ")}`);
      }
      const extra = skipped.length ? ` (${skipped.length} skipped: ${skipped.slice(0, 3).join("; ")})` : "";
      return [{ t: "ack", reqId, message: `Assigned "${p.name}" v${v.version} to ${assigned} unit${assigned === 1 ? "" : "s"}${extra}` }];
    }
  }
}
