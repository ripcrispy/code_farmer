import { useEffect, useState, type JSX } from "react";
import { describeEffect } from "../../shared/defs/effects.ts";
import { MAX_LEVEL, XP_AWARDS } from "../../shared/defs/progression.ts";
import { raceDef } from "../../shared/defs/races.ts";
import { TALENT_CATEGORIES, TALENT_DEFS, type TalentDef } from "../../shared/defs/talents.ts";
import { useGame, useUiVersion } from "./context.ts";

/** Character level, racial passives and talent trees. The server validates every allocation. */
export function TalentsPanel(): JSX.Element {
  useUiVersion();
  const { state, actions } = useGame();
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") state.openTalents(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);
  const p = state.player;
  const race = raceDef(state.race);
  if (!p) return <div />;
  const free = p.talentPoints - p.talentPointsSpent;
  const lock = (t: TalentDef): string | null => {
    const rank = p.talents[t.id] ?? 0;
    if (rank >= t.maxRank) return null;
    if (p.level < t.requiredLevel) return `Requires level ${t.requiredLevel}`;
    for (const pre of t.prerequisites) if ((p.talents[pre.talent] ?? 0) < pre.rank) return `Requires ${TALENT_DEFS[pre.talent]?.name} rank ${pre.rank}`;
    if (free < t.cost) return "No talent points";
    return null;
  };
  const visible = Object.values(TALENT_DEFS).filter((t) => !t.race || t.race === state.race);
  const fee = p.talentPointsSpent * XP_AWARDS.respecGoldPerPoint;
  return (
    <div className="editor-backdrop" role="dialog" aria-label="Talents" onClick={() => state.openTalents(false)}>
      <div className="help talents" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2>
            Level {p.level}
            {p.level >= MAX_LEVEL ? " (maximum)" : ""} · {free} talent point{free === 1 ? "" : "s"} available
          </h2>
          <span className="spacer" />
          {p.talentPointsSpent > 0 &&
            (confirmReset ? (
              <button className="danger" onClick={() => void actions.resetTalents().then(() => setConfirmReset(false))}>
                Confirm reset ({fee} gold)
              </button>
            ) : (
              <button onClick={() => setConfirmReset(true)}>Reset talents…</button>
            ))}
          <button onClick={() => state.openTalents(false)}>Close (Esc)</button>
        </div>
        <p className="muted small">
          {p.xp} experience{p.level < MAX_LEVEL ? `; ${p.xpNextLevel - p.xp} more for level ${p.level + 1}` : ""}. You earn experience by gathering, building,
          exploring new chunks, claiming territory and completing research. One talent point is awarded at every even level (30 at level {MAX_LEVEL}).
        </p>
        {race && (
          <div className="tech">
            <b>{race.name} — {race.theme}</b>
            <div className="muted small">{race.passives.map(describeEffect).join(" · ")}</div>
            {race.plannedPassives.length > 0 && <div className="muted small"><em>Not yet implemented: {race.plannedPassives.join("; ")}</em></div>}
          </div>
        )}
        <div className="talent-grid">
          {TALENT_CATEGORIES.map((cat) => {
            const list = visible.filter((t) => t.category === cat);
            if (list.length === 0) return null;
            return (
              <section key={cat} className="talent-cat">
                <h4>{cat === "racial" ? `${race?.name ?? ""} talents` : cat}</h4>
                {list.map((t) => {
                  const rank = p.talents[t.id] ?? 0;
                  const why = lock(t);
                  const maxed = rank >= t.maxRank;
                  return (
                    <div key={t.id} className={`talent ${maxed ? "maxed" : why ? "locked" : ""}`}>
                      <div className="row">
                        <b>{t.name}</b>
                        <span className="muted small">{rank}/{t.maxRank}</span>
                        {!maxed && (
                          <button className="small" disabled={!!why} title={why ?? `Costs ${t.cost} point${t.cost > 1 ? "s" : ""}`} onClick={() => void actions.allocateTalent(t.id)}>
                            Learn
                          </button>
                        )}
                      </div>
                      <div className="small">{t.description} <span className="muted">({t.effects.map(describeEffect).join(", ")} per rank)</span></div>
                      {why && !maxed && <div className="muted small">{why}</div>}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
