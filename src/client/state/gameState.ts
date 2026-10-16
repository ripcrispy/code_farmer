import { chunkKey, localIndex } from "../../shared/coords.ts";
import { NODE_DEFS, isNodeKind } from "../../shared/defs/resources.ts";
import { decodeTerritory, decodeTiles, type BuildingView, type LairView, type OwnerInfo, type PlayerView, type ServerMessage, type UnitView } from "../../shared/protocol.ts";
import type { ConnectionStatus } from "../net/connection.ts";
import { inCircle } from "../../shared/zones.ts";
import { findDiscoveryDef } from "../../shared/defs/discoveries.ts";
import { describeEffect } from "../../shared/defs/effects.ts";

/**
 * Client-side mirror of what the server has told us. Nothing here is authoritative:
 * every field is overwritten by server messages. The renderer reads it every frame;
 * React subscribes only to the coarse "ui" channel so unit movement does not
 * re-render the component tree.
 */

export interface ClientUnit extends UnitView {
  /** Render position in tile units (smoothed toward x/y). */
  rx: number;
  ry: number;
  /** When the unit last stepped to a new tile (ms, performance clock), and the smoothed time between steps. */
  movedAt: number;
  stepMs: number;
}

export interface ClientChunk {
  cx: number;
  cy: number;
  tiles: Uint8Array;
  /** local tile index -> node */
  nodes: Map<number, { kind: string; amount: number }>;
  /** local tile index -> owner player id (0 = unclaimed). */
  territory: Int32Array;
  /** local tile index -> ruin (generation v2+). */
  ruins: Map<number, ClientRuin>;
}

export interface ClientRuin {
  x: number;
  y: number;
  tier: "common" | "ancient";
  looted: boolean;
}

export type Selection = { kind: "unit"; id: number } | { kind: "building"; id: number } | { kind: "units"; ids: number[] } | null;

export interface Notification {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
  at: number;
}

type Listener = () => void;

export class GameState {
  playerId = 0;
  name = "";
  race = "";
  chunkSize = 64;
  tickRate = 10;
  visionChunkRadius = 2;
  /** The server has combat enabled (players still opt in to PvP individually). */
  combatEnabled = false;
  /** How the server stores resources: one shared stock, or per-building storage networks. */
  storageMode: "shared" | "networks" = "shared";
  /** Contested zones are active (PvP for everyone inside them). */
  contestedZones = false;
  /** Units may fight lair monsters (even when combat is off). */
  pveEnabled = false;
  /** PvE lairs seen so far, by id; `at` is when the view arrived (for countdowns). */
  lairs = new Map<string, LairView & { at: number }>();
  /** Bumped when a lair appears or changes (the renderer redraws lair marks). */
  lairsVersion = 0;
  /** Contested zones seen so far (from chunk messages), by id. */
  zones = new Map<string, { id: string; x: number; y: number; r: number }>();
  spawn = { x: 0, y: 0 };
  tick = 0;
  connection: ConnectionStatus = "idle";
  connectionDetail = "";
  units = new Map<number, ClientUnit>();
  buildings = new Map<number, BuildingView>();
  owners = new Map<number, OwnerInfo>();
  player: PlayerView | null = null;
  chunks = new Map<string, ClientChunk>();
  /** Chunks whose textures must be (re)built by the renderer. */
  dirtyChunks = new Set<string>();
  /** Tiles whose resource node changed (renderer patches the chunk texture). */
  dirtyTiles: { x: number; y: number }[] = [];
  /** Chunks whose territory overlay must be redrawn. */
  dirtyTerritory = new Set<string>();
  showTerritory = true;
  statsOpen = false;
  lessonsOpen = false;
  /** Code to put into the editor when it next opens (from a lesson), unsaved. */
  editorSeed: string | null = null;
  talentsOpen = false;
  selection: Selection = null;
  placing: string | null = null;
  /** Aiming a hero ability: the next left click picks its target. */
  targeting: { unitId: number; ability: string; name: string; target: "enemy" | "point"; range: number } | null = null;
  notifications: Notification[] = [];
  editorUnitId: number | null = null;
  libraryOpen = false;
  /** Bumped whenever something React displays changes. */
  uiVersion = 0;
  private listeners = new Set<Listener>();
  private nextNote = 1;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.uiVersion;

  bump(): void {
    this.uiVersion++;
    for (const l of this.listeners) l();
  }

  reset(): void {
    this.units.clear();
    this.buildings.clear();
    this.chunks.clear();
    this.lastChunk = { cx: NaN, cy: NaN, c: undefined };
    this.dirtyChunks.clear();
    this.dirtyTiles = [];
    this.player = null;
    this.bump();
  }

  notify(kind: Notification["kind"], text: string): void {
    this.notifications.push({ id: this.nextNote++, kind, text, at: Date.now() });
    if (this.notifications.length > 6) this.notifications.splice(0, this.notifications.length - 6);
    this.bump();
  }

  dismiss(id: number): void {
    this.notifications = this.notifications.filter((n) => n.id !== id);
    this.bump();
  }

  setConnection(s: ConnectionStatus, detail = ""): void {
    this.connection = s;
    this.connectionDetail = detail;
    this.bump();
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.bump();
  }

  setPlacing(type: string | null): void {
    this.placing = type;
    if (type) this.targeting = null;
    this.bump();
  }

  setTargeting(t: GameState["targeting"]): void {
    this.targeting = t;
    if (t) this.placing = null;
    this.bump();
  }

  openEditor(unitId: number | null): void {
    this.editorUnitId = unitId;
    this.bump();
  }

  openTalents(open: boolean): void {
    this.talentsOpen = open;
    this.bump();
  }

  openLessons(open: boolean): void {
    this.lessonsOpen = open;
    this.bump();
  }

  openStats(open: boolean): void {
    this.statsOpen = open;
    this.bump();
  }

  territoryAt(x: number, y: number): number {
    return this.territoryKnownAt(x, y) ?? 0;
  }

  /** Territory owner of a tile, or null when its chunk has not been received yet. */
  territoryKnownAt(x: number, y: number): number | null {
    const c = this.chunkAtTile(x, y);
    return c ? (c.territory[localIndex(x, y, this.chunkSize)] ?? 0) : null;
  }

  /** A chunk's territory changed: redraw it and its loaded neighbours, whose borders depend on it. */
  private markTerritoryDirty(cx: number, cy: number): void {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = chunkKey(cx + dx, cy + dy);
      if (this.chunks.has(k)) this.dirtyTerritory.add(k);
    }
  }

  /** Percentage modifier for a stat from the player's view (research, race, talents). */
  modifierPct(stat: string): number {
    return this.player?.modifiers.find((m) => m.stat === stat)?.pct ?? 0;
  }

  openLibrary(open: boolean): void {
    this.libraryOpen = open;
    this.bump();
  }

  /** Ids of the currently selected own/visible units (single or multi selection). */
  selectedUnitIds(): number[] {
    const sel = this.selection;
    if (sel?.kind === "unit") return [sel.id];
    if (sel?.kind === "units") return sel.ids;
    return [];
  }

  isUnitSelected(id: number): boolean {
    const sel = this.selection;
    return (sel?.kind === "unit" && sel.id === id) || (sel?.kind === "units" && sel.ids.includes(id));
  }

  selectUnits(ids: number[]): void {
    if (ids.length === 0) this.select(null);
    else if (ids.length === 1) this.select({ kind: "unit", id: ids[0] as number });
    else this.select({ kind: "units", ids });
  }

  ownerName(id: number): string {
    return this.owners.get(id)?.name ?? `player ${id}`;
  }

  /** Is this owner currently attackable in PvP (as last reported by the server)? */
  ownerPvp(id: number): boolean {
    return this.owners.get(id)?.pvp ?? false;
  }

  ownerRace(id: number): string {
    return this.owners.get(id)?.race ?? "human";
  }

  /** Last chunk looked up by tile (most lookups hit the same chunk repeatedly). */
  private lastChunk: { cx: number; cy: number; c: ClientChunk | undefined } = { cx: NaN, cy: NaN, c: undefined };

  /** The chunk holding tile (x, y), if the client has it. */
  chunkAtTile(x: number, y: number): ClientChunk | undefined {
    const s = this.chunkSize;
    const cx = Math.floor(x / s);
    const cy = Math.floor(y / s);
    const l = this.lastChunk;
    if (l.cx === cx && l.cy === cy) return l.c;
    const c = this.chunks.get(chunkKey(cx, cy));
    this.lastChunk = { cx, cy, c };
    return c;
  }

  nodeAt(x: number, y: number): { kind: string; amount: number } | undefined {
    return this.chunkAtTile(x, y)?.nodes.get(localIndex(x, y, this.chunkSize));
  }

  terrainAt(x: number, y: number): number | undefined {
    const c = this.chunkAtTile(x, y);
    return c ? c.tiles[localIndex(x, y, this.chunkSize)] : undefined;
  }

  /**
   * Forget chunks far from the view so memory (and the renderer's textures) stay bounded
   * on long journeys. Chunks in `keep` (the current subscription) are never dropped; the
   * server sends a chunk again when it is subscribed again.
   */
  retainChunks(keep: Set<string>, max: number, cx: number, cy: number): void {
    if (this.chunks.size <= max) return;
    const far = [...this.chunks.values()].filter((c) => !keep.has(chunkKey(c.cx, c.cy)));
    far.sort((a, b) => Math.hypot(b.cx - cx, b.cy - cy) - Math.hypot(a.cx - cx, a.cy - cy));
    for (const c of far) {
      if (this.chunks.size <= max) break;
      const key = chunkKey(c.cx, c.cy);
      this.chunks.delete(key);
      this.dirtyTerritory.delete(key);
      this.dirtyChunks.delete(key);
    }
    this.lastChunk = { cx: NaN, cy: NaN, c: undefined };
  }

  private setLair(l: LairView): void {
    this.lairs.set(l.id, { ...l, at: performance.now() });
    this.lairsVersion++;
  }

  /** The known lair whose area contains tile (x, y). */
  lairAt(x: number, y: number): (LairView & { at: number }) | undefined {
    for (const l of this.lairs.values()) if (Math.hypot(l.x - x, l.y - y) <= l.r) return l;
    return undefined;
  }

  /** Can units fight right now (PvP combat or PvE)? */
  get fightingEnabled(): boolean {
    return this.combatEnabled || this.pveEnabled;
  }

  /** The contested zone containing tile (x, y), if the client knows of one. */
  zoneAt(x: number, y: number): { id: string; x: number; y: number; r: number } | undefined {
    for (const z of this.zones.values()) if (inCircle(z, x, y)) return z;
    return undefined;
  }

  ruinAt(x: number, y: number): ClientRuin | undefined {
    const s = this.chunkSize;
    return this.chunks.get(chunkKey(Math.floor(x / s), Math.floor(y / s)))?.ruins.get(localIndex(x, y, s));
  }

  buildingAt(x: number, y: number): BuildingView | undefined {
    for (const b of this.buildings.values()) if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h) return b;
    return undefined;
  }

  unitAt(x: number, y: number): ClientUnit | undefined {
    let best: ClientUnit | undefined;
    for (const u of this.units.values()) {
      if (u.x === x && u.y === y && (!best || u.owner === this.playerId)) best = u;
    }
    return best;
  }

  /** Apply one server message. */
  apply(m: ServerMessage): void {
    switch (m.t) {
      case "welcome": {
        const reconnect = this.playerId === m.playerId;
        if (!reconnect) this.selection = null;
        this.reset();
        this.playerId = m.playerId;
        this.name = m.name;
        this.race = m.race;
        this.chunkSize = m.world.chunkSize;
        this.tickRate = m.world.tickRate;
        this.visionChunkRadius = m.world.visionChunkRadius;
        this.combatEnabled = m.world.combatEnabled;
        this.contestedZones = m.world.contestedZones;
        this.pveEnabled = m.world.pveEnabled ?? false;
        this.lairs.clear();
        this.lairsVersion++;
        this.storageMode = m.world.storageMode;
        this.zones.clear();
        this.spawn = m.spawn;
        this.notify("success", m.created ? `Welcome, ${m.name}! Your settlement has been founded.` : reconnect ? "Reconnected." : `Welcome back, ${m.name}.`);
        return;
      }
      case "chunk": {
        const s = this.chunkSize;
        const nodes = new Map<number, { kind: string; amount: number }>();
        for (const [kind, x, y, amount] of m.nodes) nodes.set(localIndex(x, y, s), { kind, amount });
        const ruins = new Map<number, ClientRuin>();
        for (const [x, y, tier, looted] of m.ruins ?? []) ruins.set(localIndex(x, y, s), { x, y, tier, looted: looted === 1 });
        for (const z of m.zones ?? []) this.zones.set(z.id, z);
        for (const l of m.lairs ?? []) this.setLair(l);
        const key = chunkKey(m.cx, m.cy);
        this.lastChunk = { cx: NaN, cy: NaN, c: undefined };
        this.chunks.set(key, { cx: m.cx, cy: m.cy, tiles: decodeTiles(m.tiles), nodes, territory: decodeTerritory(m.territory ?? [], s), ruins });
        this.dirtyChunks.add(key);
        this.markTerritoryDirty(m.cx, m.cy);
        return;
      }
      case "chunk_denied":
        return;
      case "tick": {
        this.tick = m.tick;
        let ui = false;
        const sel = this.selection;
        for (const o of m.owners ?? []) this.owners.set(o.id, o);
        // Owner colours may arrive after territory: refresh overlays that could show them.
        if (m.owners?.length) {
          const ids = new Set(m.owners.map((o) => o.id));
          for (const [k, c] of this.chunks) if (c.territory.some((v) => ids.has(v))) this.dirtyTerritory.add(k);
        }
        for (const v of m.units ?? []) {
          const prev = this.units.get(v.id);
          if (v.own && prev?.own) {
            // Logs and traces are only sent when they change.
            if (v.own.log === undefined) v.own.log = prev.own.log;
            if (v.own.trace === undefined) v.own.trace = prev.own.trace;
          }
          const now = performance.now();
          let movedAt = prev?.movedAt ?? now;
          let stepMs = prev?.stepMs ?? 400;
          if (prev && (prev.x !== v.x || prev.y !== v.y)) {
            // Learn how fast this unit walks from how often it steps, so it can glide at that pace.
            const gap = now - movedAt;
            if (gap > 40 && gap < 1500) stepMs = stepMs * 0.6 + gap * 0.4;
            movedAt = now;
          }
          this.units.set(v.id, { ...v, rx: prev?.rx ?? v.x, ry: prev?.ry ?? v.y, movedAt, stepMs });
          if (this.isUnitSelected(v.id)) ui = true;
        }
        for (const id of m.removedUnits ?? []) {
          if (this.isUnitSelected(id)) ui = true;
          this.units.delete(id);
        }
        for (const b of m.buildings ?? []) {
          this.buildings.set(b.id, b);
          if (sel?.kind === "building" && sel.id === b.id) ui = true;
        }
        for (const id of m.removedBuildings ?? []) {
          this.buildings.delete(id);
          if (sel?.kind === "building" && sel.id === id) ui = true;
        }
        for (const [kind, x, y, amount] of m.nodes ?? []) {
          const s = this.chunkSize;
          const c = this.chunks.get(chunkKey(Math.floor(x / s), Math.floor(y / s)));
          if (!c) continue;
          const li = localIndex(x, y, s);
          const regrows = isNodeKind(kind) && NODE_DEFS[kind].regrowPerMinute > 0;
          const prev = c.nodes.get(li);
          if (amount <= 0 && !regrows) {
            if (c.nodes.delete(li)) this.dirtyTiles.push({ x, y });
          } else {
            c.nodes.set(li, { kind, amount });
            // Repaint when a node appears, or a regrowing node switches between empty and full.
            if (!prev || (prev.amount > 0) !== (amount > 0)) this.dirtyTiles.push({ x, y });
          }
        }
        for (const [x, y, tier, looted] of m.ruins ?? []) {
          const c = this.chunks.get(chunkKey(Math.floor(x / this.chunkSize), Math.floor(y / this.chunkSize)));
          c?.ruins.set(localIndex(x, y, this.chunkSize), { x, y, tier, looted: looted === 1 });
        }
        for (const t of m.territory ?? []) {
          const key = chunkKey(t.cx, t.cy);
          const c = this.chunks.get(key);
          if (!c) continue;
          c.territory = decodeTerritory(t.runs, this.chunkSize);
          this.markTerritoryDirty(t.cx, t.cy);
        }
        for (const n of m.notices ?? []) this.notify(n.kind, n.text);
        for (const l of m.lairs ?? []) {
          this.setLair(l);
          ui = true;
        }
        if (m.levelUp !== undefined) {
          const free = m.player ? m.player.talentPoints - m.player.talentPointsSpent : 0;
          this.notify("success", `Level ${m.levelUp}!${free > 0 ? ` You have ${free} unspent talent point${free === 1 ? "" : "s"}.` : ""}`);
        }
        if (m.player) {
          const before = this.player;
          if (before) {
            for (const d of m.player.discoveries) {
              const def = findDiscoveryDef(d);
              if (!before.discoveries.includes(d)) this.notify("success", `Discovery: ${def?.name ?? d}. ${def?.effects.map(describeEffect).join(", ") ?? ""}`);
            }
            for (const sp of m.player.observed) {
              if (!before.observed.includes(sp)) this.notify("info", `You learned how the ${sp} behaves. Its code is under Stats → Known species.`);
            }
          }
          this.player = m.player;
          this.spawn = m.player.spawn;
          ui = true;
        }
        if (ui) this.bump();
        return;
      }
      case "error":
        if (m.reqId === undefined) this.notify("error", m.message);
        return;
      case "kicked":
        this.notify("error", `Disconnected: ${m.reason}`);
        return;
      default:
        return;
    }
  }
}
