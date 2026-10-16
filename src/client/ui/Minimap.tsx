import { useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import { OVERVIEW_SAMPLES } from "../../shared/protocol.ts";
import { TERRAIN } from "../../shared/defs/terrain.ts";
import { raceDef } from "../../shared/defs/races.ts";
import { useGame } from "./context.ts";
import { rendererRef } from "./WorldCanvas.tsx";

/** Canvas size in pixels. */
const SIZE = 200;
/** Zoom levels: chunks shown in each direction from the camera's chunk. */
const RADII = [3, 6, 12] as const;
const OTHER_TINT = 0xd04040;

type Overview = { cx: number; cy: number; radius: number; chunks: Map<string, string>; buildings: [number, number][]; units: [number, number][]; zones: [number, number, number][] };

function mix(a: number, b: number, t: number): string {
  const ch = (c: number, s: number): number => Math.round(((c >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return `rgb(${ch(a, 16)},${ch(a, 8)},${ch(a, 0)})`;
}

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

/**
 * Regional overview: explored chunks around the camera, your territory and others',
 * your buildings and units, and the current view. Click to move the camera there.
 * The data comes from the server's overview, which only describes explored chunks.
 */
export function Minimap(): JSX.Element {
  const { state, actions } = useGame();
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef<Overview | null>(null);
  const [open, setOpen] = useState(() => readPref("cf.minimap", "1") !== "0");
  const [zoom, setZoom] = useState(() => Math.min(RADII.length - 1, Math.max(0, Number(readPref("cf.minimapZoom", "0")) || 0)));
  const radius = RADII[zoom] ?? 3;

  useEffect(() => {
    writePref("cf.minimap", open ? "1" : "0");
    writePref("cf.minimapZoom", String(zoom));
    if (!open) return;
    let alive = true;
    let lastFetch = 0;
    let fetching = false;
    const base = document.createElement("canvas");
    base.width = SIZE;
    base.height = SIZE;
    const cs = (): number => state.chunkSize;
    const camChunk = (): [number, number] | null => {
      const v = rendererRef.current?.view();
      return v ? [Math.floor(v.x / cs()), Math.floor(v.y / cs())] : null;
    };
    /** Pixels per tile at this zoom. */
    const scale = (): number => SIZE / ((radius * 2 + 1) * cs());
    const toPx = (d: Overview, x: number, y: number): [number, number] => {
      const k = scale();
      return [(x - (d.cx - d.radius) * cs()) * k, (y - (d.cy - d.radius) * cs()) * k];
    };
    const paintBase = (): void => {
      const d = data.current;
      const ctx = base.getContext("2d");
      if (!d || !ctx) return;
      ctx.fillStyle = "#0b0e11";
      ctx.fillRect(0, 0, SIZE, SIZE);
      const own = raceDef(state.race)?.color ?? 0xffffff;
      const n = OVERVIEW_SAMPLES;
      const sampleTiles = cs() / n;
      const sp = sampleTiles * scale();
      for (const [key, s] of d.chunks) {
        const [cx, cy] = key.split(",").map(Number) as [number, number];
        const [ox, oy] = toPx(d, cx * cs(), cy * cs());
        for (let k = 0; k < n * n; k++) {
          const v = s.charCodeAt(k) - 48;
          const terrain = TERRAIN[v % 8]?.color ?? 0xff00ff;
          const owner = Math.floor(v / 8);
          ctx.fillStyle = mix(terrain, owner === 1 ? own : OTHER_TINT, owner === 0 ? 0 : 0.45);
          // Slight overlap avoids hairline gaps between samples at fractional scales.
          ctx.fillRect(ox + (k % n) * sp, oy + Math.floor(k / n) * sp, sp + 0.5, sp + 0.5);
        }
      }
    };
    const fetchOverview = async (): Promise<void> => {
      const c = camChunk();
      if (!c || fetching || !state.playerId) return;
      fetching = true;
      lastFetch = Date.now();
      try {
        const r = await actions.overview(c[0], c[1], radius);
        if (!alive || r.t !== "overview") return;
        data.current = { cx: c[0], cy: c[1], radius, chunks: new Map(r.chunks.map(([x, y, s]) => [`${x},${y}`, s])), buildings: r.buildings, units: r.units, zones: r.zones };
        paintBase();
      } finally {
        fetching = false;
      }
    };
    const draw = (): void => {
      const d = data.current;
      const ctx = canvas.current?.getContext("2d");
      if (!d || !ctx || d.radius !== radius) return;
      ctx.drawImage(base, 0, 0);
      const dot = Math.max(1.5, scale() * 2);
      // Contested zones: red rings.
      ctx.strokeStyle = "rgba(255, 64, 64, 0.95)";
      ctx.lineWidth = 1.5;
      for (const [zx, zy, zr] of d.zones) {
        const [px, py] = toPx(d, zx, zy);
        ctx.beginPath();
        ctx.arc(px, py, Math.max(2, zr * scale()), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "#ffffff";
      for (const [x, y] of d.buildings) {
        const [px, py] = toPx(d, x, y);
        ctx.fillRect(px - dot / 2, py - dot / 2, dot * 1.5, dot * 1.5);
      }
      // Units from the overview (a few seconds old), then live positions on top.
      ctx.fillStyle = "rgba(255, 224, 102, 0.5)";
      for (const [x, y] of d.units) {
        const [px, py] = toPx(d, x, y);
        ctx.fillRect(px - dot / 2, py - dot / 2, dot, dot);
      }
      ctx.fillStyle = "#ffe066";
      for (const u of state.units.values()) {
        if (u.owner !== state.playerId) continue;
        const [px, py] = toPx(d, u.x, u.y);
        ctx.fillRect(px - dot / 2, py - dot / 2, dot, dot);
      }
      const v = rendererRef.current?.view();
      if (v) {
        // The isometric view covers a diamond-shaped area of the map.
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        v.corners.forEach(([cx, cy], i) => {
          const [px, py] = toPx(d, cx, cy);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
      }
    };
    const timer = setInterval(() => {
      const c = camChunk();
      const d = data.current;
      // Refresh every 5 s, or sooner when the camera moves away from the overview's centre.
      const stale = !d || d.radius !== radius || Date.now() - lastFetch > 5000 || (c !== null && Math.max(Math.abs(c[0] - d.cx), Math.abs(c[1] - d.cy)) > radius / 3);
      if (c && stale) void fetchOverview();
      draw();
    }, 250);
    void fetchOverview();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, zoom, radius, state, actions]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const d = data.current;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const tilesPerPx = ((d.radius * 2 + 1) * state.chunkSize) / SIZE;
    const x = (d.cx - d.radius) * state.chunkSize + ((e.clientX - rect.left) * SIZE) / rect.width * tilesPerPx;
    const y = (d.cy - d.radius) * state.chunkSize + ((e.clientY - rect.top) * SIZE) / rect.height * tilesPerPx;
    rendererRef.current?.centerOn(Math.floor(x), Math.floor(y));
  };

  return (
    <div className="minimap" aria-label="Minimap">
      <div className="row">
        <span className="muted">Map</span>
        <span className="spacer" />
        {open && (
          <>
            <button className="small" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)} title="Zoom in" aria-label="Zoom minimap in">
              +
            </button>
            <button className="small" disabled={zoom === RADII.length - 1} onClick={() => setZoom(zoom + 1)} title="Zoom out" aria-label="Zoom minimap out">
              −
            </button>
          </>
        )}
        <button className="small" onClick={() => setOpen(!open)} title={open ? "Hide the minimap" : "Show the minimap"}>
          {open ? "Hide" : "Map"}
        </button>
      </div>
      {open && <canvas ref={canvas} width={SIZE} height={SIZE} onClick={onClick} />}
    </div>
  );
}
