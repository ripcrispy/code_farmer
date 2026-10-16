import type { JSX } from "react";
import { useGame, useUiVersion } from "./context.ts";

/**
 * "What is my unit doing, and why?" in plain words: the line being executed and what
 * it means in the world, or why the program is not running.
 */
export function UnitActivity({ unitId, dirty }: { unitId: number; dirty: boolean }): JSX.Element | null {
  useUiVersion();
  const { state } = useGame();
  const u = state.units.get(unitId);
  const own = u?.own;
  if (!own) return null;
  const trace = own.trace ?? [];
  const last = trace[trace.length - 1];
  const lastFail = [...trace].reverse().find((e) => !e.ok && e.result !== "");
  const p = own.program;
  let main: JSX.Element;
  switch (p.state) {
    case "running":
      main =
        last && last.result === "" ? (
          <>
            ▶ <b>Line {last.line}</b>: <code>{last.call}</code> — {own.task}
            {own.target ? ` (${own.target})` : ""}
          </>
        ) : (
          <>▶ Running — {own.task}{own.target ? ` (${own.target})` : ""}</>
        );
      break;
    case "paused":
      main = <>⏸ Paused{last ? ` at line ${last.line}` : ""}. Press Resume to continue.</>;
      break;
    case "error":
      main = <>✖ Stopped by an error{p.error ? ` on line ${p.error.line}: ${p.error.message}` : ""}. Fix it and press Save &amp; run.</>;
      break;
    case "finished":
      main = (
        <>
          ■ The program reached its last line and ended. To repeat forever, put the work inside <code>while alive:</code>.
        </>
      );
      break;
    default:
      main = <>■ Not running. Press Run (or Save &amp; run) to start the program.</>;
  }
  return (
    <div className="unit-activity" aria-live="polite">
      <div>{main}</div>
      {dirty && p.state === "running" && <div className="muted small">You have unsaved edits: the unit is still running the saved version. Save to run your changes.</div>}
      {own.blocked && (
        <div className="warn small">
          ⚠ {lastFail ? `Line ${lastFail.line}: ` : ""}
          {own.blocked}
        </div>
      )}
    </div>
  );
}
