import { useState, type JSX } from "react";
import { RECIPES } from "../../script/recipes.ts";
import { heroDefForRace } from "../../shared/defs/heroes.ts";
import { useGame } from "./context.ts";

/** Tested building blocks: insert at the cursor, or start a new program from one. */
export function RecipesTab({ onInsert, onReplace }: { onInsert: (code: string) => void; onReplace: (code: string) => void }): JSX.Element {
  const { state } = useGame();
  const [open, setOpen] = useState<string | null>(null);
  const heroAbilities = heroDefForRace(state.race)?.abilities ?? [];
  return (
    <div className="recipes">
      <p className="small muted">
        Ready-made pieces of code. <b>Insert</b> adds one at the cursor; <b>Use as program</b> replaces the code (Save to apply). Read them to learn how
        loops, checks and functions fit together.
      </p>
      {RECIPES.filter((r) => r.for !== "combat" || state.combatEnabled).map((r) => {
        const code = r.code({ heroAbilities });
        const shown = open === r.id;
        return (
          <div key={r.id} className="recipe">
            <div className="row">
              <button className="link recipe-title" onClick={() => setOpen(shown ? null : r.id)} aria-expanded={shown}>
                {shown ? "▾" : "▸"} {r.title}
              </button>
              <span className="badge">{r.for}</span>
            </div>
            <div className="muted small">{r.description}</div>
            {shown && <pre className="code-view">{code}</pre>}
            <div className="buttons">
              <button className="small" onClick={() => onInsert(code)}>Insert</button>
              <button className="small" onClick={() => onReplace(code)}>Use as program</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
