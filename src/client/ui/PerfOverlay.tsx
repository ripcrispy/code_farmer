import { useEffect, useState, type JSX } from "react";
import type { PerfSnapshot } from "../render/perf.ts";
import { rendererRef } from "./WorldCanvas.tsx";

const KEY = "cf.perf";

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** F3: frame rate, where frame time goes, slow frames, and what is being drawn. */
export function PerfOverlay(): JSX.Element | null {
  const [open, setOpen] = useState(readOpen);
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "F3") return;
      e.preventDefault();
      setOpen((o) => {
        try {
          localStorage.setItem(KEY, o ? "0" : "1");
        } catch {
          /* the choice lasts for this page only */
        }
        return !o;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setSnap(rendererRef.current?.perf.snapshot() ?? null), 250);
    return () => window.clearInterval(id);
  }, [open]);
  if (!open || !snap) return null;
  const c = snap.counts;
  return (
    <div className="perf" data-testid="perf">
      <div>
        <b>{snap.fps.toFixed(0)} fps</b> · frame {snap.total.toFixed(1)} ms · worst {snap.worst.toFixed(0)} ms · slow frames (5 s) <span className={snap.slow ? "warn" : ""}>{snap.slow}</span>
        {snap.longTasks !== null && (
          <>
            {" "}· long tasks <span className={snap.longTasks ? "warn" : ""}>{snap.longTasks}</span>
            {snap.longTasks ? ` (max ${snap.longestTask.toFixed(0)} ms)` : ""}
          </>
        )}
      </div>
      <div>
        ms avg/peak: {snap.sections.map(([k, v, m]) => `${k} ${v.toFixed(1)}/${m.toFixed(0)}`).join(" · ")} · render {snap.render.toFixed(1)}/{snap.renderPeak.toFixed(0)}
      </div>
      <div>
        units {c.units}/{c.unitsKnown} · buildings {c.buildings} · trees/rocks {c.nodes} · sprites {c.objects} · chunks {c.chunks}
        {c.paintQueue ? ` · painting ${c.paintQueue}` : ""}
      </div>
    </div>
  );
}
