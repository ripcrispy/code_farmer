import type { JSX } from "react";
import { useEffect } from "react";
import { useGame, useUiVersion } from "./context.ts";

export function Notifications(): JSX.Element {
  useUiVersion();
  const { state } = useGame();
  const notes = state.notifications;
  useEffect(() => {
    if (notes.length === 0) return;
    const oldest = notes[0];
    if (!oldest) return;
    const t = setTimeout(() => state.dismiss(oldest.id), Math.max(500, 6000 - (Date.now() - oldest.at)));
    return () => clearTimeout(t);
  }, [notes, state]);
  return (
    <div className="toasts" aria-live="polite">
      {notes.map((n) => (
        <div key={n.id} className={`toast toast-${n.kind}`} onClick={() => state.dismiss(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  );
}
