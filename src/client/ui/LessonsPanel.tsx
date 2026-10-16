import { useEffect, useState, type JSX } from "react";
import { LESSONS, lessonExample, type LessonDef } from "../../shared/defs/lessons.ts";
import { heroDefForRace } from "../../shared/defs/heroes.ts";
import type { GameState } from "../state/gameState.ts";
import { useGame, useUiVersion } from "./context.ts";

/** The unit a lesson's example suits best: the selected own unit, else a fitting one. */
function unitFor(state: GameState, l: LessonDef): number | null {
  const own = [...state.units.values()].filter((u) => u.owner === state.playerId);
  if (l.id === "hero") return state.player?.hero?.unitId ?? null;
  const sel = state.selection;
  if (sel?.kind === "unit" && own.some((u) => u.id === sel.id)) return sel.id;
  const prefer = l.id === "build" ? ["builder", "worker"] : ["woodcutter", "worker", "builder"];
  for (const t of prefer) {
    const u = own.find((x) => x.type === t);
    if (u) return u.id;
  }
  return own[0]?.id ?? null;
}

/** Guided coding lessons: one idea each, completed by what your programs actually do. */
export function LessonsPanel(): JSX.Element {
  useUiVersion();
  const { state } = useGame();
  const done = new Set(state.player?.lessons ?? []);
  const firstOpen = LESSONS.find((l) => !done.has(l.id)) ?? LESSONS[0]!;
  const [id, setId] = useState(firstOpen.id);
  const [hints, setHints] = useState(0);
  const lesson = LESSONS.find((l) => l.id === id) ?? firstOpen;
  const example = lessonExample(lesson, heroDefForRace(state.race)?.abilities ?? []);
  const target = unitFor(state, lesson);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") state.openLessons(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);
  useEffect(() => setHints(0), [id]);
  const tryIt = (): void => {
    if (target === null) return;
    state.editorSeed = example;
    state.openLessons(false);
    state.openEditor(target);
  };
  return (
    <div className="editor-backdrop" role="dialog" aria-label="Coding lessons" onClick={() => state.openLessons(false)}>
      <div className="lessons" onClick={(e) => e.stopPropagation()}>
        <div className="editor-head">
          <h2>
            Coding lessons <span className="muted small">{done.size} / {LESSONS.length} complete</span>
          </h2>
          <div className="spacer" />
          <button onClick={() => state.openLessons(false)}>Close (Esc)</button>
        </div>
        <div className="lessons-body">
          <ol className="lesson-list">
            {LESSONS.map((l) => (
              <li key={l.id} className={`${l.id === id ? "active" : ""} ${done.has(l.id) ? "done" : ""}`}>
                <button className="link" onClick={() => setId(l.id)}>
                  {done.has(l.id) ? "✓" : "○"} {l.title}
                </button>
                <span className="muted small"> {l.teaches}</span>
              </li>
            ))}
          </ol>
          <div className="lesson">
            <h3>
              {lesson.title} {done.has(lesson.id) ? <span className="badge badge-running">done</span> : <span className="badge">+{lesson.xp} XP</span>}
            </h3>
            <p>{lesson.explanation}</p>
            <pre className="code-view">{example}</pre>
            <p>
              <b>Goal:</b> {lesson.goal}
            </p>
            <div className="buttons">
              <button className="primary" disabled={target === null} onClick={tryIt} title="Opens the editor with this example (save to run it)">
                Try it in the editor
              </button>
              <button disabled={hints >= lesson.hints.length} onClick={() => setHints(hints + 1)}>
                {hints === 0 ? "I need a hint" : hints < lesson.hints.length ? "Another hint" : "No more hints"}
              </button>
            </div>
            {target === null && <p className="muted small">{lesson.id === "hero" ? "Recruit your hero at the Town Hall first." : "You have no unit to try this with."}</p>}
            {lesson.hints.slice(0, hints).map((h, i) => (
              <p key={i} className="hint">
                💡 {h}
              </p>
            ))}
            <p className="muted small">The lesson completes by itself when one of your units' programs does what the goal says.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
