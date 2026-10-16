import { CanvasSource, Container, Graphics, Matrix, RendererType, Sprite, Texture, UPDATE_PRIORITY, type Application } from "pixi.js";
import { WaterFilter, waterShaderWorks } from "./waterFilter.ts";
import { PerfStats, type PerfCounts } from "./perf.ts";
import { chunkKey, localIndex } from "../../shared/coords.ts";
import { findBuildingDef } from "../../shared/defs/buildings.ts";
import { findLairDef } from "../../shared/defs/lairs.ts";
import { raceDef } from "../../shared/defs/races.ts";
import { findUnitDef } from "../../shared/defs/units.ts";
import { heroDefForType } from "../../shared/defs/heroes.ts";
import { NEUTRAL_OWNER } from "../../shared/protocol.ts";
import { terrainDef } from "../../shared/defs/terrain.ts";
import type { BuildingView } from "../../shared/protocol.ts";
import type { ClientChunk, ClientUnit, GameState } from "../state/gameState.ts";
import { GROUND, GROUND_MATRIX, HH, HW, depthOf, toScreen, toTile } from "./iso.ts";
import { TEX, type PaintSource } from "./terrainPainter.ts";
import { GroundPainter, type GroundResult } from "./groundJobs.ts";
import { alphaAt, buildingArt, bushArt, creatureArt, lairArt, paddockFrontArt, shade, flagArt, personArt, rockArt, ruinArt, toolArt, treeArt, weaponFor, type Art } from "./art.ts";

export interface RendererCallbacks {
  /** Left click on a tile (not a drag). `shift` toggles multi-selection. */
  onClick(x: number, y: number, shift: boolean): void;
  /** Shift+drag on screen: select these of your units. */
  onSelectUnits(ids: number[]): void;
  /** Right click on a tile. `force` is true with Ctrl held (attack whatever is there). */
  onCommand(x: number, y: number, force: boolean): void;
  /** Left click while in placement mode. */
  onPlace(type: string, x: number, y: number): void;
  /** Left click while aiming a hero ability. */
  onAbilityTarget(target: { unitId: number } | { x: number; y: number }): void;
  /** The set of chunks covering the viewport changed. */
  onVisibleChunks(chunks: [number, number][]): void;
  onHover(x: number, y: number): void;
}

interface GroundChunk {
  sprite: Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: Texture;
}

interface FlatSprite {
  sprite: Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: Texture;
}

interface UnitSprite {
  root: Container;
  /** Mirrored to face left or right. */
  figure: Container;
  shadow: Graphics;
  back: Sprite | null;
  body: Sprite;
  team: Sprite | null;
  tool: Sprite | null;
  collar: Graphics | null;
  hpBar: Graphics;
  /** Silhouette drawn over buildings that hide the unit. */
  ghost: Sprite;
  key: string;
  creature: boolean;
  hero: boolean;
  scale: number;
  weapon: string;
  ranged: boolean;
  lastHpPct: number;
  hitAt: number;
  flip: boolean;
  type: string;
  owner: number;
  color: number;
  /** What the tool sprite currently shows, the health bar last drawn, the body tint. */
  toolKind: string;
  barSig: number;
  tint: number;
}

interface BuildingSprite {
  root: Container;
  art: Sprite;
  flag: Sprite | null;
  /** Paddocks: the front fences, drawn in front of the animals inside. */
  front: Sprite | null;
  bar: Graphics;
  key: string;
  flagFrame: number;
  barSig: number;
  /** Screen-space footprint corners and art height, for picking. */
  hit: { w: number; n: number; e: number; s: number; top: number; wx: number; ex: number };
}

const MAX_SUBSCRIBE = 49;
/** Chunks kept in memory (and as textures) before the farthest are forgotten. */
const MAX_KEPT_CHUNKS = 120;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.4;
const MAX_NODE_SPRITES = 9000;
/** Tiles of trees and rocks kept around the view, so panning rarely rebuilds them. */
const NODE_MARGIN = 10;
const NODE_POOL_MAX = 1500;
const TERRITORY_PER_FRAME = 3;
/** Chunks whose ground texture is painted per frame (painting is expensive). */
const PAINT_PER_FRAME = 1;

function texFromCanvas(canvas: HTMLCanvasElement): Texture {
  const source = new CanvasSource({ resource: canvas, scaleMode: "linear" });
  return new Texture({ source });
}

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function spriteFor(a: Art): Sprite {
  const s = new Sprite(a.texture);
  s.anchor.set(a.ax, a.ay);
  return s;
}

/**
 * Imperative PixiJS world renderer: an isometric view in the style of classic fantasy
 * RTS games. Flat layers (painted terrain, territory, contested zones, selection and
 * placement marks) live in a ground container projected with an affine matrix; trees,
 * rocks, ruins, buildings and units are upright painted sprites sorted by depth.
 * Reads GameState every frame; never mutates game state and never decides outcomes.
 */
export class WorldRenderer {
  private readonly app: Application;
  private readonly state: GameState;
  private readonly cb: RendererCallbacks;
  private readonly world = new Container();
  private readonly ground = new Container();
  private readonly terrainLayer = new Container();
  private readonly territoryLayer = new Container();
  private readonly zoneLayer = new Graphics();
  /** Lair areas on the ground; their landmarks are upright sprites. */
  private readonly lairLayer = new Graphics();
  private lairSig = -1;
  private lairSprites = new Map<string, { sprite: Sprite; key: string; x: number; y: number }>();
  private readonly groundMarks = new Graphics();
  private readonly objects = new Container();
  /** Silhouettes of units hidden behind buildings, drawn above everything. */
  private readonly xray = new Container();
  /** Visible buildings this frame (for occlusion tests). */
  private occluders: { z: number; hit: BuildingSprite["hit"]; b: BuildingView }[] = [];
  private readonly screenOverlay = new Graphics();
  private groundChunks = new Map<string, GroundChunk>();
  private paintQueue: string[] = [];
  private readonly painter: GroundPainter;
  private paintResults: GroundResult[] = [];
  private territorySprites = new Map<string, FlatSprite>();
  private zoneSig = "";
  private nodeSprites = new Map<number, { sprite: Sprite; key: string; x: number; y: number; tree: boolean }>();
  /** Tile region the node sprites were built for. */
  private nodeBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private nodePool = new Map<string, Sprite[]>();
  private nodesDirty = true;
  private ruinSprites = new Map<string, { sprite: Sprite; key: string }>();
  private unitSprites = new Map<number, UnitSprite>();
  private buildingSprites = new Map<number, BuildingSprite>();
  private camX = 0;
  private camY = 0;
  private zoom = 1.0;
  private time = 0;
  private hover: { x: number; y: number } | null = null;
  private hoverScreen: { x: number; y: number } | null = null;
  private lastChunkSig = "";
  private keys = new Set<string>();
  private drag: { sx: number; sy: number; camX: number; camY: number; moved: boolean; box: boolean } | null = null;
  private disposers: (() => void)[] = [];
  private centeredOn = 0;
  private readonly paintSrc: PaintSource;
  private frameStart = 0;
  /** Animated water (WebGL only; without it the painted water is simply still). */
  private water: WaterFilter | null = null;
  /** Frame timings and object counts for the performance overlay (F3). */
  readonly perf = new PerfStats();

  constructor(app: Application, state: GameState, cb: RendererCallbacks) {
    this.app = app;
    this.state = state;
    this.cb = cb;
    const m = GROUND_MATRIX;
    this.ground.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, 0, 0));
    this.ground.addChild(this.terrainLayer, this.territoryLayer, this.lairLayer, this.zoneLayer, this.groundMarks);
    this.objects.sortableChildren = true;
    this.world.addChild(this.ground, this.objects, this.xray);
    app.stage.addChild(this.world, this.screenOverlay);
    (app.canvas as unknown as HTMLCanvasElement).tabIndex = 0;
    this.paintSrc = {
      terrain: (x, y) => this.state.terrainAt(x, y),
      node: (x, y) => this.state.nodeAt(x, y),
    };
    this.painter = new GroundPainter((r) => this.paintResults.push(r));
    const gl = app.renderer.type === RendererType.WEBGL ? (app.renderer as unknown as { gl: WebGL2RenderingContext }).gl : null;
    if (gl && waterShaderWorks(gl)) {
      try {
        this.water = new WaterFilter();
        // Pixi clips the filtered area to the screen; the layer has at most ~120 chunk sprites to measure.
        this.terrainLayer.filters = [this.water];
      } catch (e) {
        console.warn("Water animation unavailable:", e);
        this.water = null;
      }
    }
    const tick = (): void => this.frame(app.ticker.deltaMS / 1000);
    app.ticker.add(tick);
    // Runs after Pixi has rendered the frame: measures the render itself and the whole frame.
    const after = (): void => {
      const now = performance.now();
      this.perf.endFrame(now, this.frameStart, app.ticker.deltaMS, this.counts());
    };
    app.ticker.add(after, undefined, UPDATE_PRIORITY.UTILITY);
    this.disposers.push(() => {
      app.ticker.remove(tick);
      app.ticker.remove(after);
    });
    this.bindInput();
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.painter.destroy();
    this.perf.dispose();
    for (const c of this.groundChunks.values()) c.texture.destroy(true);
    for (const t of this.territorySprites.values()) t.texture.destroy(true);
    this.world.destroy({ children: true });
    this.screenOverlay.destroy();
  }

  /** Visible area for the minimap: centre tile, approximate size, and the four corner tiles. */
  view(): { x: number; y: number; w: number; h: number; corners: [number, number][] } {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const corners: [number, number][] = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ].map(([sx, sy]) => {
      const p = this.screenToWorld(sx as number, sy as number);
      const t = toTile(p.x, p.y);
      return [t.x, t.y] as [number, number];
    });
    const c = toTile(this.camX, this.camY);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    return { x: c.x, y: c.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), corners };
  }

  /** Object counts for the performance overlay. */
  private counts(): PerfCounts {
    let units = 0;
    for (const us of this.unitSprites.values()) if (us.root.visible) units++;
    let buildings = 0;
    for (const bs of this.buildingSprites.values()) if (bs.root.visible) buildings++;
    return {
      units,
      unitsKnown: this.state.units.size,
      buildings,
      nodes: this.nodeSprites.size,
      objects: this.objects.children.length,
      chunks: this.state.chunks.size,
      paintQueue: this.paintQueue.length + this.painter.pending,
    };
  }

  centerOn(x: number, y: number): void {
    const p = toScreen(x + 0.5, y + 0.5);
    this.camX = p.x;
    this.camY = p.y;
  }

  /** Force the next frame to resend the visible-chunk subscription (after reconnect). */
  resubscribe(): void {
    this.lastChunkSig = "";
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.app.screen.width / 2) / this.zoom + this.camX, y: (sy - this.app.screen.height / 2) / this.zoom + this.camY };
  }

  // ------------------------------------------------------------------ picking

  /**
   * What is under a screen point: the tile of the front-most unit, building or tree
   * drawn there (upright art covers tiles behind it), else the ground tile.
   */
  private pick(sx: number, sy: number): { x: number; y: number; unitId?: number } {
    const p = this.screenToWorld(sx, sy);
    const t = toTile(p.x, p.y);
    let best: { depth: number; x: number; y: number; unitId?: number } | null = null;
    const offer = (depth: number, x: number, y: number, unitId?: number): void => {
      if (!best || depth > best.depth) best = { depth, x, y, unitId };
    };
    /** Is the sprite's art opaque at the cursor? (Its transparent margins do not count.) */
    const opaque = (sp: Sprite, ox: number, oy: number): boolean => {
      const tex = sp.texture;
      const lx = (p.x - ox) / sp.scale.x + sp.anchor.x * tex.width;
      const ly = (p.y - oy) / sp.scale.y + sp.anchor.y * tex.height;
      return alphaAt(tex, lx, ly) > 40;
    };
    for (const [id, us] of this.unitSprites) {
      if (!us.root.visible) continue;
      const u = this.state.units.get(id);
      if (!u) continue;
      const bx = us.root.x;
      const by = us.root.y;
      const s = us.scale;
      const half = us.creature ? 16 : 10;
      if (Math.abs(p.x - bx) <= half * s && p.y >= by - (us.creature ? 30 : 38) * s && p.y <= by + 5) offer(us.root.zIndex + 1, u.x, u.y, u.id);
    }
    for (const [id, bs] of this.buildingSprites) {
      if (!bs.root.visible) continue;
      const b = this.state.buildings.get(id);
      if (!b) continue;
      const h = bs.hit;
      if (p.x < h.wx || p.x > h.ex || p.y < bs.root.y - bs.art.anchor.y * bs.art.texture.height || p.y > h.s) continue;
      // On the drawn building, or on its footprint on the ground.
      const onFootprint = t.x >= b.x && t.x < b.x + b.w && t.y >= b.y && t.y < b.y + b.h;
      if (!onFootprint && !opaque(bs.art, bs.root.x, bs.root.y)) continue;
      offer(bs.root.zIndex, Math.min(b.x + b.w - 1, Math.max(b.x, Math.floor(t.x))), Math.min(b.y + b.h - 1, Math.max(b.y, Math.floor(t.y))));
    }
    for (const ns of this.nodeSprites.values()) {
      if (!ns.tree || !ns.sprite.visible) continue;
      const s = ns.sprite;
      if (Math.abs(p.x - s.x) <= 26 && p.y >= s.y - 80 && p.y <= s.y + 6 && opaque(s, s.x, s.y)) offer(s.zIndex, ns.x, ns.y);
    }
    const r = best as { depth: number; x: number; y: number; unitId?: number } | null;
    if (r) return { x: r.x, y: r.y, unitId: r.unitId };
    return { x: Math.floor(t.x), y: Math.floor(t.y) };
  }

  // ------------------------------------------------------------------ input

  private bindInput(): void {
    const canvas = this.app.canvas as unknown as HTMLCanvasElement;
    const local = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on(canvas, "contextmenu", (e) => e.preventDefault());
    on(canvas, "pointerdown", (e) => {
      canvas.focus();
      if (e.button === 0) {
        this.drag = { sx: e.clientX, sy: e.clientY, camX: this.camX, camY: this.camY, moved: false, box: e.shiftKey && !this.state.placing && !this.state.targeting };
      }
      if (e.button === 2) {
        if (this.state.placing) this.state.setPlacing(null);
        else if (this.state.targeting) this.state.setTargeting(null);
        else {
          const l = local(e);
          const t = this.pick(l.x, l.y);
          this.cb.onCommand(t.x, t.y, e.ctrlKey || e.metaKey);
        }
      }
    });
    on(window, "pointermove", (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.sx;
        const dy = e.clientY - this.drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 6) this.drag.moved = true;
        if (this.drag.moved && !this.drag.box) {
          this.camX = this.drag.camX - dx / this.zoom;
          this.camY = this.drag.camY - dy / this.zoom;
        }
      }
      if (e.target === canvas) {
        const l = local(e);
        this.hoverScreen = l;
        const t = this.pick(l.x, l.y);
        if (!this.hover || this.hover.x !== t.x || this.hover.y !== t.y) {
          this.hover = { x: t.x, y: t.y };
          this.cb.onHover(t.x, t.y);
        }
      }
    });
    on(window, "pointerup", (e) => {
      const d = this.drag;
      this.drag = null;
      if (d?.box && d.moved && e.button === 0) {
        const a = local({ clientX: d.sx, clientY: d.sy });
        const b = local(e);
        this.boxSelect(a, b);
        return;
      }
      if (!d || d.moved || e.button !== 0 || e.target !== canvas) return;
      const l = local(e);
      const placing = this.state.placing;
      if (placing) {
        const p = this.screenToWorld(l.x, l.y);
        const t = toTile(p.x, p.y);
        const def = findBuildingDef(placing);
        if (def) this.cb.onPlace(placing, Math.floor(t.x) - Math.floor((def.width - 1) / 2), Math.floor(t.y) - Math.floor((def.height - 1) / 2));
        return;
      }
      const t = this.pick(l.x, l.y);
      const aim = this.state.targeting;
      if (aim) {
        if (aim.target === "enemy") {
          if (t.unitId === undefined) {
            this.state.notify("error", `Click a unit to use ${aim.name} on`);
            return;
          }
          this.cb.onAbilityTarget({ unitId: t.unitId });
        } else {
          const p = this.screenToWorld(l.x, l.y);
          const g = toTile(p.x, p.y);
          this.cb.onAbilityTarget({ x: Math.floor(g.x), y: Math.floor(g.y) });
        }
        this.state.setTargeting(null);
        return;
      }
      this.cb.onClick(t.x, t.y, e.shiftKey);
    });
    on(
      canvas,
      "wheel",
      (e) => {
        e.preventDefault();
        const l = local(e);
        const before = this.screenToWorld(l.x, l.y);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
        const after = this.screenToWorld(l.x, l.y);
        this.camX += before.x - after.x;
        this.camY += before.y - after.y;
      },
      { passive: false },
    );
    const typing = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    };
    on(window, "keydown", (e) => {
      if (typing(e) || this.state.editorUnitId !== null || this.state.libraryOpen || this.state.statsOpen || this.state.talentsOpen || this.state.lessonsOpen) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
      if (k === "+" || k === "=") this.zoom = Math.min(MAX_ZOOM, this.zoom * 1.15);
      if (k === "-" || k === "_") this.zoom = Math.max(MIN_ZOOM, this.zoom / 1.15);
      if (k === "escape") {
        if (this.state.targeting) this.state.setTargeting(null);
        else if (this.state.placing) this.state.setPlacing(null);
        else this.state.select(null);
      }
      if (k === "h") this.centerOn(this.state.spawn.x, this.state.spawn.y);
      if (k === "t") {
        this.state.showTerritory = !this.state.showTerritory;
        this.state.notify("info", this.state.showTerritory ? "Territory overlay on (T)" : "Territory overlay off (T)");
      }
      if (k === "y") {
        // Select and centre on your hero.
        const id = this.state.player?.hero?.unitId;
        const u = id ? this.state.units.get(id) : undefined;
        if (u) {
          this.state.select({ kind: "unit", id: u.id });
          this.centerOn(u.x, u.y);
        } else this.state.notify("info", "You have no hero right now: recruit or revive one at your Town Hall");
      }
      if (k === " ") {
        const sel = this.state.selection;
        if (sel?.kind === "unit") {
          const u = this.state.units.get(sel.id);
          if (u) this.centerOn(u.x, u.y);
        } else if (sel?.kind === "building") {
          const b = this.state.buildings.get(sel.id);
          if (b) this.centerOn(b.x + b.w / 2 - 0.5, b.y + b.h / 2 - 0.5);
        }
        e.preventDefault();
      }
      if (k === "tab") {
        e.preventDefault();
        const own = [...this.state.units.values()].filter((u) => u.owner === this.state.playerId).sort((a, b) => a.id - b.id);
        if (own.length === 0) return;
        const sel = this.state.selection;
        const idx = sel?.kind === "unit" ? own.findIndex((u) => u.id === sel.id) : -1;
        const next = own[(idx + (e.shiftKey ? own.length - 1 : 1)) % own.length] as ClientUnit;
        this.state.select({ kind: "unit", id: next.id });
        this.centerOn(next.x, next.y);
      }
    });
    on(window, "keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    on(window, "blur", () => this.keys.clear());
  }

  private boxSelect(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const ids: number[] = [];
    for (const [id, us] of this.unitSprites) {
      const u = this.state.units.get(id);
      if (!u || u.owner !== this.state.playerId || !us.root.visible) continue;
      const sx = (us.root.x - this.camX) * this.zoom + this.app.screen.width / 2;
      const sy = (us.root.y - 12 - this.camY) * this.zoom + this.app.screen.height / 2;
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(id);
    }
    this.cb.onSelectUnits(ids.slice(0, 100));
  }

  // ------------------------------------------------------------------ frame

  private frame(dt: number): void {
    this.frameStart = performance.now();
    this.time += dt;
    const s = this.state;
    if (s.playerId && this.centeredOn !== s.playerId) {
      this.centeredOn = s.playerId;
      this.centerOn(s.spawn.x, s.spawn.y);
    }
    const pan = (700 * dt) / this.zoom;
    if (this.keys.has("w") || this.keys.has("arrowup")) this.camY -= pan;
    if (this.keys.has("s") || this.keys.has("arrowdown")) this.camY += pan;
    if (this.keys.has("a") || this.keys.has("arrowleft")) this.camX -= pan;
    if (this.keys.has("d") || this.keys.has("arrowright")) this.camX += pan;

    const w = this.app.screen.width;
    const h = this.app.screen.height;
    this.world.scale.set(this.zoom);
    this.world.position.set(Math.round(w / 2 - this.camX * this.zoom), Math.round(h / 2 - this.camY * this.zoom));
    this.water?.update(this.time, this.world.position.x, this.world.position.y, this.zoom);
    (this.app.canvas as unknown as HTMLCanvasElement).style.cursor = s.targeting ? "crosshair" : s.placing ? "copy" : "default";

    // Visible screen rectangle in world pixels, with a margin for tall art.
    const vx0 = this.camX - w / 2 / this.zoom - HW * 2;
    const vx1 = this.camX + w / 2 / this.zoom + HW * 2;
    const vy0 = this.camY - h / 2 / this.zoom - HH * 2;
    const vy1 = this.camY + h / 2 / this.zoom + 170;
    const view = { x0: vx0, x1: vx1, y0: vy0, y1: vy1 };
    // Tile-space bounding box of that rectangle.
    const cs = [toTile(vx0, vy0), toTile(vx1, vy0), toTile(vx1, vy1), toTile(vx0, vy1)];
    const tx0 = Math.floor(Math.min(...cs.map((c) => c.x)));
    const tx1 = Math.ceil(Math.max(...cs.map((c) => c.x)));
    const ty0 = Math.floor(Math.min(...cs.map((c) => c.y)));
    const ty1 = Math.ceil(Math.max(...cs.map((c) => c.y)));
    const inView = (x: number, y: number): boolean => {
      const p = toScreen(x + 0.5, y + 0.5);
      return p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1;
    };
    const P = this.perf;
    let t = performance.now();
    const lap = (name: string): void => {
      const n = performance.now();
      P.add(name, n - t);
      t = n;
    };
    this.updateVisibleChunks(tx0, ty0, tx1, ty1);
    this.syncGround(tx0, ty0, tx1, ty1);
    lap("ground");
    this.syncTerritory(tx0, ty0, tx1, ty1);
    this.syncZones();
    this.syncLairs(inView);
    lap("territory");
    this.syncNodes(tx0, ty0, tx1, ty1, view);
    this.syncRuins(inView);
    lap("nodes");
    this.syncBuildings(view);
    this.occluders = [];
    for (const [id, bs] of this.buildingSprites) {
      const b = this.state.buildings.get(id);
      if (b && bs.root.visible && !bs.front) this.occluders.push({ z: bs.root.zIndex, hit: bs.hit, b });
    }
    lap("buildings");
    this.syncUnits(dt, view);
    lap("units");
    this.drawGroundMarks();
    this.drawScreenOverlay();
    lap("marks");
    P.frameStart = this.frameStart;
  }

  private updateVisibleChunks(x0: number, y0: number, x1: number, y1: number): void {
    const cs = this.state.chunkSize;
    if (!this.state.playerId) return;
    const cx0 = Math.floor(x0 / cs);
    const cy0 = Math.floor(y0 / cs);
    const cx1 = Math.floor(x1 / cs);
    const cy1 = Math.floor(y1 / cs);
    const c = toTile(this.camX, this.camY);
    const ccx = c.x / cs;
    const ccy = c.y / cs;
    let list: [number, number][] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) list.push([cx, cy]);
    list.sort((a, b) => Math.hypot(a[0] + 0.5 - ccx, a[1] + 0.5 - ccy) - Math.hypot(b[0] + 0.5 - ccx, b[1] + 0.5 - ccy));
    if (list.length > MAX_SUBSCRIBE) list = list.slice(0, MAX_SUBSCRIBE);
    const sig = list.map((p) => p.join(",")).sort().join(";");
    if (sig !== this.lastChunkSig) {
      this.lastChunkSig = sig;
      this.cb.onVisibleChunks(list);
      this.state.retainChunks(new Set(list.map(([x, y]) => chunkKey(x, y))), MAX_KEPT_CHUNKS, ccx, ccy);
    }
  }

  // ------------------------------------------------------------------ painted ground

  private syncGround(x0: number, y0: number, x1: number, y1: number): void {
    const s = this.state;
    const cs = s.chunkSize;
    for (const key of s.dirtyChunks) {
      if (!this.paintQueue.includes(key)) this.paintQueue.push(key);
      this.nodesDirty = true;
      // Neighbours' edges blend into this chunk: repaint their borders once it is known.
      const c = s.chunks.get(key);
      if (c) this.repaintNeighbourEdges(c);
    }
    s.dirtyChunks.clear();
    // Send queued chunks to the painters, nearest the camera first.
    if (this.paintQueue.length && this.painter.ready) {
      const cam = toTile(this.camX, this.camY);
      const dist = (k: string): number => {
        const [ax, ay] = k.split(",").map(Number) as [number, number];
        return Math.hypot((ax + 0.5) * cs - cam.x, (ay + 0.5) * cs - cam.y);
      };
      this.paintQueue.sort((a, b) => dist(a) - dist(b));
      const budget = this.painter.fallback ? PAINT_PER_FRAME : 4;
      for (let i = 0; i < budget && this.paintQueue.length && this.painter.ready; i++) {
        const key = this.paintQueue.shift() as string;
        const c = s.chunks.get(key);
        if (c) this.painter.paint(key, c.cx * cs, c.cy * cs, (c.cx + 1) * cs, (c.cy + 1) * cs, this.paintSrc);
      }
    }
    if (s.dirtyTiles.length) {
      for (const t of s.dirtyTiles) {
        const key = chunkKey(Math.floor(t.x / cs), Math.floor(t.y / cs));
        // A chunk still queued is painted whole later, with this change included.
        if (!s.chunks.has(key) || this.paintQueue.includes(key)) continue;
        this.painter.paint(key, t.x, t.y, t.x + 1, t.y + 1, this.paintSrc);
      }
      s.dirtyTiles = [];
      this.nodesDirty = true;
    }
    // Draw finished paintings (a few per frame: each one uploads a texture).
    const touched = new Set<string>();
    let applied = 0;
    while (this.paintResults.length && applied < 3) {
      const r = this.paintResults.shift() as GroundResult;
      const c = s.chunks.get(r.key);
      if (!c) continue;
      const gc = this.ensureGroundChunk(r.key, c);
      const w = (r.tx1 - r.tx0) * TEX;
      const h = (r.ty1 - r.ty0) * TEX;
      gc.ctx.putImageData(new ImageData(r.pixels as Uint8ClampedArray<ArrayBuffer>, w, h), (r.tx0 - c.cx * cs) * TEX, (r.ty0 - c.cy * cs) * TEX);
      touched.add(r.key);
      if (w * h > 4096) applied++;
    }
    for (const k of touched) this.groundChunks.get(k)?.texture.source.update();
    for (const [key, gc] of this.groundChunks) {
      const c = s.chunks.get(key);
      if (!c) {
        gc.sprite.destroy();
        gc.texture.destroy(true);
        this.groundChunks.delete(key);
        continue;
      }
      gc.sprite.visible = c.cx * cs < x1 && (c.cx + 1) * cs > x0 && c.cy * cs < y1 && (c.cy + 1) * cs > y0;
    }
  }

  private ensureGroundChunk(key: string, c: ClientChunk): GroundChunk {
    let gc = this.groundChunks.get(key);
    if (gc) return gc;
    const cs = this.state.chunkSize;
    const canvas = document.createElement("canvas");
    canvas.width = cs * TEX;
    canvas.height = cs * TEX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    const texture = texFromCanvas(canvas);
    const sprite = new Sprite(texture);
    sprite.position.set(c.cx * cs * GROUND, c.cy * cs * GROUND);
    sprite.scale.set(GROUND / TEX);
    this.terrainLayer.addChild(sprite);
    gc = { sprite, canvas, ctx, texture };
    this.groundChunks.set(key, gc);
    return gc;
  }

  private repaintNeighbourEdges(c: ClientChunk): void {
    const cs = this.state.chunkSize;
    const edges: [number, number, number, number, number, number][] = [
      // neighbour chunk dx, dy, and the strip of it next to c (tile rect)
      [-1, 0, c.cx * cs - 1, c.cy * cs, c.cx * cs, (c.cy + 1) * cs],
      [1, 0, (c.cx + 1) * cs, c.cy * cs, (c.cx + 1) * cs + 1, (c.cy + 1) * cs],
      [0, -1, c.cx * cs, c.cy * cs - 1, (c.cx + 1) * cs, c.cy * cs],
      [0, 1, c.cx * cs, (c.cy + 1) * cs, (c.cx + 1) * cs, (c.cy + 1) * cs + 1],
    ];
    for (const [dx, dy, x0, y0, x1, y1] of edges) {
      const key = chunkKey(c.cx + dx, c.cy + dy);
      if (!this.state.chunks.has(key) || this.paintQueue.includes(key)) continue;
      this.painter.paint(key, x0, y0, x1, y1, this.paintSrc);
    }
  }

  // ------------------------------------------------------------------ territory overlay

  private syncTerritory(x0: number, y0: number, x1: number, y1: number): void {
    const s = this.state;
    const cs = s.chunkSize;
    // Redraw a few changed chunks per frame (visible ones first) to avoid long frames.
    if (s.dirtyTerritory.size) {
      const vis = (k: string): boolean => {
        const c = s.chunks.get(k);
        return !!c && c.cx * cs < x1 && (c.cx + 1) * cs > x0 && c.cy * cs < y1 && (c.cy + 1) * cs > y0;
      };
      const keys = [...s.dirtyTerritory].sort((a, b) => Number(vis(b)) - Number(vis(a)));
      for (const key of keys.slice(0, TERRITORY_PER_FRAME)) {
        s.dirtyTerritory.delete(key);
        const c = s.chunks.get(key);
        if (c) this.drawTerritory(key, c);
      }
    }
    for (const [key, ts] of this.territorySprites) {
      const c = s.chunks.get(key);
      if (!c) {
        ts.sprite.destroy();
        ts.texture.destroy(true);
        this.territorySprites.delete(key);
        continue;
      }
      ts.sprite.visible = s.showTerritory && c.cx * cs < x1 && (c.cx + 1) * cs > x0 && c.cy * cs < y1 && (c.cy + 1) * cs > y0;
    }
  }

  /** A faint wash in the owner's colour and a thin dashed line along borders. */
  private drawTerritory(key: string, c: ClientChunk): void {
    const s = this.state;
    const cs = s.chunkSize;
    const K = 8;
    let ts = this.territorySprites.get(key);
    const any = c.territory.some((v) => v !== 0);
    if (!any && !ts) return;
    if (!ts) {
      const canvas = document.createElement("canvas");
      canvas.width = cs * K;
      canvas.height = cs * K;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      const texture = texFromCanvas(canvas);
      const sprite = new Sprite(texture);
      sprite.position.set(c.cx * cs * GROUND, c.cy * cs * GROUND);
      sprite.scale.set(GROUND / K);
      this.territoryLayer.addChild(sprite);
      ts = { sprite, canvas, ctx, texture };
      this.territorySprites.set(key, ts);
    }
    const img = ts.ctx.createImageData(cs * K, cs * K);
    const ownerAt = (lx: number, ly: number): number => {
      if (lx >= 0 && ly >= 0 && lx < cs && ly < cs) return c.territory[ly * cs + lx] ?? 0;
      // Unknown neighbouring chunk: draw no border yet; it is redrawn when the neighbour arrives.
      return s.territoryKnownAt(c.cx * cs + lx, c.cy * cs + ly) ?? (c.territory[Math.min(cs - 1, Math.max(0, ly)) * cs + Math.min(cs - 1, Math.max(0, lx))] ?? 0);
    };
    for (let ly = 0; ly < cs; ly++) {
      for (let lx = 0; lx < cs; lx++) {
        const o = c.territory[ly * cs + lx] ?? 0;
        if (o === 0) continue;
        const color = raceDef(s.ownerRace(o))?.color ?? 0xffffff;
        const L = ownerAt(lx - 1, ly) !== o;
        const R = ownerAt(lx + 1, ly) !== o;
        const U = ownerAt(lx, ly - 1) !== o;
        const D = ownerAt(lx, ly + 1) !== o;
        for (let py = 0; py < K; py++) {
          for (let px = 0; px < K; px++) {
            const dashX = (lx * K + px) % 8 < 5;
            const dashY = (ly * K + py) % 8 < 5;
            const edge = ((L && px === 0) || (R && px === K - 1)) ? dashY : ((U && py === 0) || (D && py === K - 1)) && dashX;
            const i = ((ly * K + py) * cs * K + lx * K + px) * 4;
            img.data[i] = (color >> 16) & 255;
            img.data[i + 1] = (color >> 8) & 255;
            img.data[i + 2] = color & 255;
            img.data[i + 3] = edge ? 230 : o === s.playerId ? 22 : 34;
          }
        }
      }
    }
    ts.ctx.putImageData(img, 0, 0);
    ts.texture.source.update();
  }

  // ------------------------------------------------------------------ contested zones

  private syncZones(): void {
    const zones = [...this.state.zones.values()];
    const sig = zones.map((z) => z.id).join(",");
    if (sig !== this.zoneSig) {
      this.zoneSig = sig;
      const g = this.zoneLayer;
      g.clear();
      for (const z of zones) {
        const cx = (z.x + 0.5) * GROUND;
        const cy = (z.y + 0.5) * GROUND;
        const r = (z.r + 0.5) * GROUND;
        g.circle(cx, cy, r).fill({ color: 0xc02020, alpha: 0.16 });
        const dashes = Math.max(24, Math.round(z.r * 2));
        for (let i = 0; i < dashes; i += 2) {
          const a0 = (i / dashes) * Math.PI * 2;
          const a1 = ((i + 1) / dashes) * Math.PI * 2;
          g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r).arc(cx, cy, r, a0, a1).stroke({ width: 3, color: 0xff4040, alpha: 0.9 });
        }
        g.moveTo(cx - 10, cy - 10).lineTo(cx + 10, cy + 10).stroke({ width: 3, color: 0xffd0d0, alpha: 0.8 });
        g.moveTo(cx + 10, cy - 10).lineTo(cx - 10, cy + 10).stroke({ width: 3, color: 0xffd0d0, alpha: 0.8 });
      }
    }
    this.zoneLayer.alpha = 0.8 + 0.2 * Math.sin(this.time * 1.5);
  }

  // ------------------------------------------------------------------ PvE lairs

  /** Lair areas (a trampled, darkened circle with a ragged rim) and their landmark sprites. */
  private syncLairs(inView: (x: number, y: number) => boolean): void {
    const s = this.state;
    if (s.lairsVersion !== this.lairSig) {
      this.lairSig = s.lairsVersion;
      const g = this.lairLayer;
      g.clear();
      const G = GROUND;
      for (const l of s.lairs.values()) {
        const def = findLairDef(l.kind);
        const color = def?.color ?? 0x5a4a3a;
        const cx = (l.x + 0.5) * G;
        const cy = (l.y + 0.5) * G;
        const r = (l.r + 0.5) * G;
        const cleared = l.status === "cleared";
        g.circle(cx, cy, r).fill({ color, alpha: cleared ? 0.18 : 0.34 });
        g.circle(cx, cy, r * 0.55).fill({ color: shade(color, 0.7), alpha: cleared ? 0.12 : 0.28 });
        const n = Math.max(20, Math.round(l.r * 3));
        for (let i = 0; i < n; i += 2) {
          const a0 = (i / n) * Math.PI * 2;
          const a1 = ((i + 1) / n) * Math.PI * 2;
          g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r)
            .arc(cx, cy, r, a0, a1)
            .stroke({ width: 2.5, color: cleared ? 0xb0b0a0 : 0xb03020, alpha: cleared ? 0.5 : 0.75 });
        }
      }
      for (const [id, ls] of this.lairSprites) {
        const l = s.lairs.get(id);
        if (!l || ls.key !== `${l.kind}|${l.status === "cleared"}`) {
          ls.sprite.destroy();
          this.lairSprites.delete(id);
        }
      }
      for (const l of s.lairs.values()) {
        if (this.lairSprites.has(l.id)) continue;
        const sprite = spriteFor(lairArt(l.kind, l.status === "cleared"));
        const p = toScreen(l.x + 0.5, l.y + 0.5);
        sprite.position.set(p.x, p.y);
        sprite.scale.set(1.6);
        sprite.zIndex = depthOf(l.x + 0.5, l.y + 0.5) - 8;
        this.objects.addChild(sprite);
        this.lairSprites.set(l.id, { sprite, key: `${l.kind}|${l.status === "cleared"}`, x: l.x, y: l.y });
      }
    }
    for (const ls of this.lairSprites.values()) ls.sprite.visible = inView(ls.x, ls.y);
  }

  // ------------------------------------------------------------------ trees, rocks, bushes

  /**
   * Trees, rocks and bushes near the view. Sprites are made for a region somewhat
   * larger than the screen and only rebuilt when the view leaves it (or nodes change),
   * so panning does not rebuild them every frame; reused sprites come from a pool.
   */
  private syncNodes(x0: number, y0: number, x1: number, y1: number, view: { x0: number; x1: number; y0: number; y1: number }): void {
    const r = this.nodeBox;
    const inside = r && x0 >= r.x0 && y0 >= r.y0 && x1 <= r.x1 && y1 <= r.y1;
    if (!inside || this.nodesDirty) this.rebuildNodes(x0 - NODE_MARGIN, y0 - NODE_MARGIN, x1 + NODE_MARGIN, y1 + NODE_MARGIN, view);
    // Cull to the screen: only sprites that can be seen are drawn.
    for (const ns of this.nodeSprites.values()) {
      const sp = ns.sprite;
      sp.visible = sp.x >= view.x0 && sp.x <= view.x1 && sp.y >= view.y0 && sp.y - 70 <= view.y1;
    }
  }

  private rebuildNodes(x0: number, y0: number, x1: number, y1: number, view: { x0: number; x1: number; y0: number; y1: number }): void {
    this.nodeBox = { x0, y0, x1, y1 };
    this.nodesDirty = false;
    const s = this.state;
    const cs = s.chunkSize;
    // Screen rectangle the region may need (the view plus the margin all round).
    const mx = NODE_MARGIN * HW * 2;
    const my = NODE_MARGIN * HH * 2;
    const sx0 = view.x0 - mx;
    const sx1 = view.x1 + mx;
    const sy0 = view.y0 - my;
    const sy1 = view.y1 + my + 70;
    const seen = new Set<number>();
    let count = 0;
    const tileKey = (x: number, y: number): number => x * 2097152 + y;
    const cx0 = Math.floor(x0 / cs);
    const cx1 = Math.floor(x1 / cs);
    const cy0 = Math.floor(y0 / cs);
    const cy1 = Math.floor(y1 / cs);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = s.chunks.get(chunkKey(cx, cy));
        if (!c) continue;
        for (const [li, node] of c.nodes) {
          if (count >= MAX_NODE_SPRITES) break;
          const x = cx * cs + (li % cs);
          const y = cy * cs + Math.floor(li / cs);
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
          const sx = (x - y) * HW;
          const sy = (x + y + 1) * HH;
          if (sx < sx0 || sx > sx1 || sy < sy0 || sy > sy1) continue;
          const h = hash2(x, y);
          let artKey: string;
          let art: Art;
          if (node.kind === "tree") {
            const forest = c.tiles[li] === 3;
            const v = forest ? ([2, 3, 0, 5, 2] as const)[Math.floor(h * 5)] : ([0, 1, 4, 5, 0] as const)[Math.floor(h * 5)];
            artKey = `t${v}`;
            art = treeArt(v ?? 0);
          } else if (node.kind === "stone" || node.kind === "gold") {
            const v = h < 0.5 ? 0 : 1;
            artKey = `${node.kind}${v}`;
            art = rockArt(node.kind === "gold", v);
          } else if (node.kind === "berries") {
            artKey = node.amount <= 0 ? "bush0" : "bush1";
            art = bushArt(node.amount <= 0);
          } else continue;
          const key = tileKey(x, y);
          seen.add(key);
          count++;
          let ns = this.nodeSprites.get(key);
          if (ns && ns.key === artKey) continue;
          if (ns) this.releaseNode(ns);
          const sprite = this.nodePool.get(artKey)?.pop() ?? spriteFor(art);
          const p = toScreen(x + 0.5 + (h - 0.5) * 0.25, y + 0.5 + (hash2(y, x) - 0.5) * 0.25);
          sprite.position.set(p.x, p.y);
          sprite.zIndex = depthOf(x + 0.5, y + 0.5);
          sprite.scale.x = node.kind === "tree" && h > 0.5 ? -1 : 1;
          this.objects.addChild(sprite);
          ns = { sprite, key: artKey, x, y, tree: node.kind === "tree" };
          this.nodeSprites.set(key, ns);
        }
      }
    }
    for (const [key, ns] of this.nodeSprites) {
      if (!seen.has(key)) {
        this.releaseNode(ns);
        this.nodeSprites.delete(key);
      }
    }
  }

  /** Take a node sprite off the map and keep it for reuse. */
  private releaseNode(ns: { sprite: Sprite; key: string }): void {
    this.objects.removeChild(ns.sprite);
    let pool = this.nodePool.get(ns.key);
    if (!pool) this.nodePool.set(ns.key, (pool = []));
    if (pool.length < NODE_POOL_MAX) pool.push(ns.sprite);
    else ns.sprite.destroy();
  }

  // ------------------------------------------------------------------ ruins

  private syncRuins(inView: (x: number, y: number) => boolean): void {
    const s = this.state;
    const seen = new Set<string>();
    for (const c of s.chunks.values()) {
      for (const r of c.ruins.values()) {
        const id = `${r.x},${r.y}`;
        seen.add(id);
        const key = `${r.tier}|${r.looted}`;
        let rs = this.ruinSprites.get(id);
        if (!rs || rs.key !== key) {
          rs?.sprite.destroy();
          const sprite = spriteFor(ruinArt(r.tier === "ancient", r.looted));
          const p = toScreen(r.x + 0.5, r.y + 0.5);
          sprite.position.set(p.x, p.y);
          sprite.zIndex = depthOf(r.x + 0.5, r.y + 0.5);
          this.objects.addChild(sprite);
          rs = { sprite, key };
          this.ruinSprites.set(id, rs);
        }
        rs.sprite.visible = inView(r.x, r.y);
        if (rs.sprite.visible && r.tier === "ancient" && !r.looted) rs.sprite.alpha = 0.88 + 0.12 * Math.sin(this.time * 3 + r.x);
      }
    }
    for (const [id, rs] of this.ruinSprites) {
      if (!seen.has(id)) {
        rs.sprite.destroy();
        this.ruinSprites.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ buildings

  private syncBuildings(view: { x0: number; x1: number; y0: number; y1: number }): void {
    const s = this.state;
    for (const [id, bs] of this.buildingSprites) {
      if (!s.buildings.has(id)) {
        bs.root.destroy({ children: true });
        bs.front?.destroy();
        this.buildingSprites.delete(id);
      }
    }
    for (const b of s.buildings.values()) {
      const stage = b.complete ? 4 : Math.min(3, Math.floor(b.progress * 4));
      const key = `${b.type}|${stage}|${b.owner}`;
      let bs = this.buildingSprites.get(b.id);
      if (!bs || bs.key !== key) {
        bs?.root.destroy({ children: true });
        bs?.front?.destroy();
        bs = this.makeBuilding(b, stage, key);
        this.buildingSprites.set(b.id, bs);
      }
      const n = toScreen(b.x, b.y);
      const sPt = toScreen(b.x + b.w, b.y + b.h);
      bs.root.visible = sPt.y >= view.y0 && n.y - 160 <= view.y1 && toScreen(b.x + b.w, b.y).x >= view.x0 && toScreen(b.x, b.y + b.h).x <= view.x1;
      if (bs.front) bs.front.visible = bs.root.visible;
      if (!bs.root.visible) continue;
      if (bs.flag) {
        const f = Math.floor(this.time * 5 + b.id) % 3;
        if (f !== bs.flagFrame) bs.flag.texture = flagArt((bs.flagFrame = f)).texture;
      }
      // Health bar while damaged; small (animated) flames below half health.
      const damaged = b.complete && b.hp < b.maxHp;
      const burning = damaged && b.hp / Math.max(1, b.maxHp) < 0.5;
      const barSig = damaged ? b.hp : -1;
      if (barSig === bs.barSig && !burning) continue;
      bs.barSig = barSig;
      bs.bar.clear();
      if (damaged) {
        const frac = Math.max(0, b.hp / Math.max(1, b.maxHp));
        const wpx = (b.w + b.h) * HW * 0.5;
        const y = bs.hit.top - n.y - 6;
        bs.bar.rect(-wpx / 2, y, wpx, 5).fill(0x1a1410).stroke({ width: 1, color: 0x000000 });
        bs.bar.rect(-wpx / 2 + 1, y + 1, (wpx - 2) * frac, 3).fill(frac > 0.5 ? 0x5cd35c : frac > 0.25 ? 0xe0c040 : 0xe04a3a);
        if (frac < 0.5) {
          for (let i = 0; i < 3; i++) {
            const fx = (i - 1) * wpx * 0.25;
            const fy = (b.w + b.h) * HH * 0.6 - 30 + Math.sin(this.time * 9 + i * 2) * 2;
            bs.bar.poly([fx - 4, fy, fx, fy - 12 - Math.abs(Math.sin(this.time * 7 + i)) * 6, fx + 4, fy]).fill({ color: 0xff8a20, alpha: 0.85 });
            bs.bar.poly([fx - 2, fy, fx, fy - 7, fx + 2, fy]).fill({ color: 0xffe060, alpha: 0.9 });
          }
        }
      }
    }
  }

  private makeBuilding(b: BuildingView, stage: number, key: string): BuildingSprite {
    const root = new Container();
    const { art, flag } = buildingArt(b.type, b.w, b.h, stage, this.state.ownerRace(b.owner));
    const sprite = spriteFor(art);
    root.addChild(sprite);
    let flagSprite: Sprite | null = null;
    if (flag) {
      flagSprite = spriteFor(flagArt(0));
      flagSprite.position.set(flag.x, flag.y);
      flagSprite.tint = raceDef(this.state.ownerRace(b.owner))?.color ?? 0xffffff;
      root.addChild(flagSprite);
    }
    const bar = new Graphics();
    root.addChild(bar);
    const n = toScreen(b.x, b.y);
    root.position.set(n.x, n.y);
    root.zIndex = depthOf(b.x + b.w - 0.75, b.y + b.h - 0.75);
    // A finished paddock is open: its back half sorts behind the animals inside, its front fences in front.
    let front: Sprite | null = null;
    if (stage === 4 && findBuildingDef(b.type)?.pen) {
      root.zIndex = depthOf(b.x, b.y);
      front = spriteFor(paddockFrontArt(b.w, b.h));
      front.position.set(n.x, n.y);
      front.zIndex = depthOf(b.x + b.w - 0.5, b.y + b.h - 0.5) + 3;
      this.objects.addChild(front);
    }
    this.objects.addChild(root);
    const texH = art.texture.height;
    const top = n.y - art.ay * texH + 20;
    return {
      root,
      art: sprite,
      flag: flagSprite,
      front,
      bar,
      key,
      flagFrame: -1,
      barSig: -1,
      hit: {
        w: toScreen(b.x, b.y + b.h).y,
        n: n.y,
        e: toScreen(b.x + b.w, b.y).y,
        s: toScreen(b.x + b.w, b.y + b.h).y,
        top: Math.max(top, n.y - 150),
        wx: toScreen(b.x, b.y + b.h).x,
        ex: toScreen(b.x + b.w, b.y).x,
      },
    };
  }

  // ------------------------------------------------------------------ units

  private syncUnits(dt: number, view: { x0: number; x1: number; y0: number; y1: number }): void {
    const s = this.state;
    for (const [id, us] of this.unitSprites) {
      if (!s.units.has(id)) {
        us.root.destroy({ children: true });
        us.ghost.destroy();
        this.unitSprites.delete(id);
      }
    }
    for (const u of s.units.values()) {
      // Glide toward the server position at the unit's observed walking pace (one tile per
      // step interval), catching up faster when behind, instead of easing to a stop on
      // every tile.
      const dx = u.x - u.rx;
      const dy = u.y - u.ry;
      const dist = Math.hypot(dx, dy);
      if (dist > 4) {
        u.rx = u.x;
        u.ry = u.y;
      } else if (dist > 0.001) {
        const pace = 1000 / Math.max(60, u.stepMs);
        const v = pace * (dist > 1.5 ? 1 + (dist - 1.5) * 2 : 1);
        const step = Math.min(dist, v * dt);
        u.rx += (dx / dist) * step;
        u.ry += (dy / dist) * step;
      }
      // Off-screen units are not drawn or animated (and get no sprite until first seen).
      const px = (u.rx - u.ry) * HW;
      const py = (u.rx + u.ry + 1) * HH;
      const vis = px >= view.x0 && px <= view.x1 && py >= view.y0 && py <= view.y1;
      let us = this.unitSprites.get(u.id);
      if (!vis) {
        if (us) {
          us.root.visible = false;
          us.ghost.visible = false;
        }
        continue;
      }
      if (!us || us.type !== u.type || us.owner !== u.owner) {
        const race = u.owner === NEUTRAL_OWNER ? "" : s.ownerRace(u.owner);
        const color = u.owner === NEUTRAL_OWNER ? 0x000000 : (raceDef(race)?.color ?? 0xffffff);
        const key = `${u.type}|${race}|${color}`;
        if (!us || us.key !== key) {
          us?.root.destroy({ children: true });
          us?.ghost.destroy();
          us = this.makeUnit(u.type, race, u.owner === NEUTRAL_OWNER, color, key);
          this.unitSprites.set(u.id, us);
        }
        us.type = u.type;
        us.owner = u.owner;
        us.color = color;
      }
      us.root.visible = true;
      us.ghost.visible = false;
      this.animateUnit(us, u, px, py);
      // Behind a building: show a silhouette in the owner's colour on top.
      if (u.owner !== NEUTRAL_OWNER && this.occluded(px, py - 14 * us.scale, us.root.zIndex)) {
        us.ghost.visible = true;
        us.ghost.position.set(px, py + us.figure.y);
        us.ghost.scale.set(us.figure.scale.x, us.figure.scale.y);
        us.ghost.tint = us.color;
        us.ghost.alpha = 0.55;
      }
    }
  }

  /** Is screen point (x, y) of something at depth z covered by a building drawn in front of it? */
  private occluded(x: number, y: number, z: number): boolean {
    for (const o of this.occluders) {
      if (o.z <= z) continue;
      const h = o.hit;
      if (x < h.wx + 6 || x > h.ex - 6 || y < h.top + 10 || y > h.s) continue;
      const b = o.b;
      const sMid = toScreen(b.x + b.w, b.y + b.h);
      const wPt = toScreen(b.x, b.y + b.h);
      const ePt = toScreen(b.x + b.w, b.y);
      const edgeY = x <= sMid.x ? wPt.y + ((x - wPt.x) / Math.max(1, sMid.x - wPt.x)) * (sMid.y - wPt.y) : sMid.y + ((x - sMid.x) / Math.max(1, ePt.x - sMid.x)) * (ePt.y - sMid.y);
      if (y < edgeY - 4) return true;
    }
    return false;
  }

  private makeUnit(type: string, race: string, wild: boolean, color: number, key: string): UnitSprite {
    const def = findUnitDef(type);
    const root = new Container();
    const figure = new Container();
    const shadow = new Graphics();
    const hpBar = new Graphics();
    const hero = def?.hero === true;
    const beast = !!def?.creature || (!!def?.monster && !def.monster.humanoid);
    const scale = (hero ? 1.28 : beast ? 0.9 : 1) * (def?.size ?? 1);
    if (beast) {
      shadow.ellipse(0, 0, 18, 7).fill({ color: 0x000000, alpha: 0.28 });
      const body = spriteFor(creatureArt(type));
      figure.addChild(body);
      let collar: Graphics | null = null;
      if (!wild && def?.creature) {
        collar = new Graphics().circle(14, -26, 3).fill(color).stroke({ width: 1, color: 0x111111 });
        figure.addChild(collar);
      }
      figure.scale.set(scale);
      root.addChild(shadow, figure, hpBar);
      this.objects.addChild(root);
      const ghost = spriteFor(creatureArt(type));
      this.xray.addChild(ghost);
      return { root, figure, shadow, back: null, body, team: null, tool: null, collar, hpBar, ghost, key, creature: true, hero: false, scale, weapon: "", ranged: false, lastHpPct: 100, hitAt: -10, flip: false, type, owner: 0, color, toolKind: "", barSig: -1, tint: 0xffffff };
    }
    shadow.ellipse(0, 0, 11 * scale, 4.5 * scale).fill({ color: 0x000000, alpha: 0.32 });
    // Humanoid monsters wear their own colours (no owner).
    const art = personArt(type, def?.monster ? "monster" : race || "human");
    const back = art.back ? spriteFor(art.back) : null;
    if (back) back.tint = def?.monster ? shade(def.monster.color, 0.8) : color;
    const body = spriteFor(art.body);
    const team = spriteFor(art.team);
    team.tint = def?.monster ? def.monster.color : color;
    const weapon = weaponFor(type);
    const tool = spriteFor(toolArt(weapon));
    tool.position.set(7.8, -15);
    if (back) figure.addChild(back);
    figure.addChild(body, team, tool);
    figure.scale.set(scale);
    root.addChild(shadow, figure, hpBar);
    this.objects.addChild(root);
    const ghost = spriteFor(art.body);
    this.xray.addChild(ghost);
    return { root, figure, shadow, back, body, team, tool, collar: null, hpBar, ghost, key, creature: false, hero, scale, weapon, ranged: (def?.attack?.range ?? 1) > 1, lastHpPct: 100, hitAt: -10, flip: false, type, owner: 0, color, toolKind: "", barSig: -1, tint: 0xffffff };
  }

  private animateUnit(us: UnitSprite, u: ClientUnit, px: number, py: number): void {
    const t = this.time + u.id * 0.37;
    let bob = 0;
    let lean = 0;
    const tool = us.tool;
    // Face left or right on screen according to the server's facing (0 = +x, 2 = +y).
    const ang = (u.facing * Math.PI) / 4;
    const sxDir = Math.cos(ang) - Math.sin(ang);
    if (Math.abs(sxDir) > 0.1) us.flip = sxDir < 0;
    us.figure.scale.x = (us.flip ? -1 : 1) * us.scale;
    // Textures are only reassigned when the tool changes.
    const show = (kind: string): void => {
      if (!tool) return;
      if (us.toolKind !== kind) {
        us.toolKind = kind;
        tool.texture = toolArt(kind).texture;
      }
      tool.visible = true;
    };
    if (tool) {
      tool.visible = false;
      tool.rotation = 0;
    }
    const swing = (kind: string, speed: number, amp: number, base = -0.4): void => {
      if (!tool) return;
      show(kind);
      tool.rotation = base + Math.abs(Math.sin(t * speed)) * amp;
    };
    switch (u.activity) {
      case "walking":
      case "carrying":
        bob = -Math.abs(Math.sin(t * 10)) * 1.8;
        lean = 0.05;
        if (tool && (us.hero || us.weapon === "sword")) {
          show(us.weapon);
          tool.rotation = 0.35;
        }
        break;
      case "harvesting":
        swing("axe", 9, 1.6, -1.1);
        break;
      case "mining":
        swing("pick", 7, 1.7, -1.2);
        break;
      case "foraging":
        if (tool) {
          show("basket");
          tool.rotation = Math.sin(t * 6) * 0.2;
        }
        bob = -Math.abs(Math.sin(t * 6)) * 1;
        break;
      case "building":
      case "repairing":
        swing("hammer", 8, 1.5, -1.0);
        break;
      case "observing":
        if (tool) {
          show("spyglass");
          tool.rotation = 1.2;
        }
        bob = Math.sin(t * 1.5) * 0.4;
        break;
      case "investigating":
        swing("trowel", 6, 1.0, 0.4);
        bob = 2;
        break;
      case "taming":
        if (tool) {
          show("basket");
          tool.rotation = 0.8;
        }
        break;
      case "guarding":
        if (us.creature) us.figure.rotation = Math.sin(t * 0.8) * 0.08;
        break;
      case "attacking":
        if (us.creature) {
          bob = -Math.abs(Math.sin(t * 9)) * 3;
          lean = Math.sin(t * 9) * 0.12;
        } else if (us.ranged) {
          if (tool) {
            show(us.weapon);
            tool.rotation = 1.45 + Math.sin(t * 4) * 0.05;
          }
        } else if (tool) {
          show(us.weapon);
          tool.rotation = -1.3 + Math.abs(Math.sin(t * 7)) * 2.4;
        }
        break;
      default:
        bob = Math.sin(t * 2) * 0.5;
        if (tool && us.hero) {
          show(us.weapon);
          tool.rotation = 0.25;
        }
        break;
    }
    us.root.position.set(px, py);
    us.figure.position.set(0, bob);
    us.figure.rotation = us.creature ? lean : lean * (us.flip ? -1 : 1);
    // Changing zIndex makes the layer re-sort, so only set it when it changes.
    const z = depthOf(u.rx + 0.5, u.ry + 0.5) + 2;
    if (us.root.zIndex !== z) us.root.zIndex = z;
    // Hit flash and health bar (redrawn only when the health shown changes).
    if (u.hpPct < us.lastHpPct) us.hitAt = this.time;
    us.lastHpPct = u.hpPct;
    const tint = this.time - us.hitAt < 0.25 ? 0xff7070 : 0xffffff;
    if (us.tint !== tint) us.body.tint = us.tint = tint;
    const barSig = u.hpPct < 100 || us.hero ? Math.round(u.hpPct) : -2;
    if (barSig === us.barSig) {
      us.root.alpha = u.own?.hidden ? 0.55 : 1;
      return;
    }
    us.barSig = barSig;
    us.hpBar.clear();
    const top = -(us.creature ? 34 : 50) * us.scale;
    if (u.hpPct < 100 || us.hero) {
      const w = us.hero ? 30 : 18;
      us.hpBar.rect(-w / 2, top, w, 4).fill(0x141414).stroke({ width: 1, color: 0x000000 });
      us.hpBar.rect(-w / 2 + 0.5, top + 0.5, ((w - 1) * u.hpPct) / 100, 3).fill(u.hpPct > 50 ? 0x5cd35c : u.hpPct > 25 ? 0xe0c040 : 0xe04a3a);
    }
    // Your hidden (stealthy) units are drawn faded; other players never receive them.
    us.root.alpha = u.own?.hidden ? 0.55 : 1;
  }

  // ------------------------------------------------------------------ flat marks (ground space)

  private drawGroundMarks(): void {
    const g = this.groundMarks;
    g.clear();
    const s = this.state;
    const G = GROUND;
    // Hero rings, buff glows and selection rings under units.
    for (const u of s.units.values()) {
      const us = this.unitSprites.get(u.id);
      if (!us?.root.visible) continue;
      const cx = (u.rx + 0.5) * G;
      const cy = (u.ry + 0.5) * G;
      if (us.hero) g.circle(cx, cy, G * 0.62).stroke({ width: 2.2, color: 0xffd040, alpha: 0.65 + 0.25 * Math.sin(this.time * 3) });
      if (u.own?.buffs?.length) g.circle(cx, cy, G * 0.5).fill({ color: 0xffe080, alpha: 0.18 + 0.1 * Math.sin(this.time * 5) });
      if (s.isUnitSelected(u.id)) {
        const blocked = !!u.own?.blocked;
        g.circle(cx, cy, G * (us.hero ? 0.8 : us.creature ? 0.75 : 0.55)).stroke({ width: 2, color: blocked ? 0xff6060 : u.owner === s.playerId ? 0x60ff60 : u.owner === NEUTRAL_OWNER ? 0xffe066 : 0xff5050, alpha: 0.95 });
        // A selected hero shows its aura radius.
        const aura = heroDefForType(u.type)?.aura;
        if (aura && u.owner === s.playerId) {
          const r = aura.radius * Math.max(0.2, 1 + s.modifierPct("heroAura"));
          g.rect((u.x - r) * G, (u.y - r) * G, (2 * r + 1) * G, (2 * r + 1) * G).stroke({ width: 1.5, color: 0xffd040, alpha: 0.4 });
        }
      }
    }
    // Ability range while aiming.
    const aim = s.targeting;
    if (aim) {
      const u = s.units.get(aim.unitId);
      if (u) {
        const r = aim.range;
        g.rect((u.x - r) * G, (u.y - r) * G, (2 * r + 1) * G, (2 * r + 1) * G).fill({ color: 0x80c0ff, alpha: 0.07 }).stroke({ width: 2, color: 0x80c0ff, alpha: 0.8 });
      }
    }
    // Selected building outline.
    const sel = s.selection;
    if (sel?.kind === "building") {
      const b = s.buildings.get(sel.id);
      if (b) g.rect(b.x * G - 1, b.y * G - 1, b.w * G + 2, b.h * G + 2).stroke({ width: 2, color: b.owner === s.playerId ? 0x60ff60 : 0xff5050, alpha: 0.6 + 0.4 * Math.sin(this.time * 6) });
    }
    const h = this.hover;
    if (!h || this.drag?.box) return;
    const placing = s.placing;
    if (placing) {
      const def = findBuildingDef(placing);
      if (!def || !this.hoverScreen) return;
      const p = this.screenToWorld(this.hoverScreen.x, this.hoverScreen.y);
      const t = toTile(p.x, p.y);
      const bx = Math.floor(t.x) - Math.floor((def.width - 1) / 2);
      const by = Math.floor(t.y) - Math.floor((def.height - 1) / 2);
      for (let y = by; y < by + def.height; y++) {
        for (let x = bx; x < bx + def.width; x++) {
          const okTile = this.tileLooksBuildable(x, y, def.allowedTerrain, def.expansion);
          g.rect(x * G, y * G, G, G).fill({ color: okTile ? 0x40ff60 : 0xff4040, alpha: 0.4 });
        }
      }
      let contested = false;
      for (let y = by; y < by + def.height && !contested; y++) for (let x = bx; x < bx + def.width; x++) if (s.zoneAt(x, y)) contested = true;
      g.rect(bx * G, by * G, def.width * G, def.height * G).stroke({ width: contested ? 2 : 1, color: contested ? 0xff4040 : 0xffffff, alpha: 0.9 });
      return;
    }
    g.rect(h.x * G, h.y * G, G, G).stroke({ width: 1, color: 0xffffff, alpha: 0.55 });
  }

  /** Box selection rectangle, in screen space. */
  private drawScreenOverlay(): void {
    const g = this.screenOverlay;
    g.clear();
    const d = this.drag;
    if (!d?.box || !d.moved || !this.hoverScreen) return;
    const canvas = this.app.canvas as unknown as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const ax = d.sx - r.left;
    const ay = d.sy - r.top;
    const bx = this.hoverScreen.x;
    const by = this.hoverScreen.y;
    g.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)).fill({ color: 0xffe066, alpha: 0.1 }).stroke({ width: 1, color: 0xffe066, alpha: 0.9 });
  }

  /** Advisory client-side check for the placement ghost; the server decides. */
  private tileLooksBuildable(x: number, y: number, allowed: number[] | null, expansion: boolean): boolean {
    const t = this.state.terrainAt(x, y);
    if (t === undefined) return false;
    if (!terrainDef(t).buildable) return false;
    if (allowed && !allowed.includes(t)) return false;
    if (this.state.nodeAt(x, y)) return false;
    if (this.state.buildingAt(x, y)) return false;
    const owner = this.state.territoryAt(x, y);
    if (owner !== 0 && owner !== this.state.playerId) return false;
    if (!expansion && owner !== this.state.playerId) return false;
    return true;
  }
}

/** Exported for tests of the projection maths. */
export const _internal = { localIndex };
