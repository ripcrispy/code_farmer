import { useEffect, useState, type JSX } from "react";
import { HERO_TRAINING, heroDefForRace, heroDefForType, heroTrainingCost, type AbilityDef } from "../../shared/defs/heroes.ts";
import { STAT_LABELS, isStatKey } from "../../shared/defs/effects.ts";
import type { UnitView } from "../../shared/protocol.ts";
import { canAfford, formatCostText } from "./format.ts";
import { useGame } from "./context.ts";
import { rendererRef } from "./WorldCanvas.tsx";

/** Re-render every second (cooldown countdowns). */
function useSecondTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return n;
}

/** When each unit's ability cooldowns were last reported (they count down locally between updates). */
const reportedAt = new WeakMap<object, number>();

function abilityRange(a: AbilityDef): number {
  const e = a.effect;
  return "range" in e ? e.range : 0;
}

function describeBuff(stat: string, pct: number): string {
  if (stat === "invulnerable") return "cannot be harmed";
  if (stat === "stealth") return "hidden";
  if (stat === "vulnerable") return `takes ${Math.round(pct * 100)}% more damage`;
  const label = isStatKey(stat) ? STAT_LABELS[stat] : stat;
  return `${pct > 0 ? "+" : ""}${Math.round(pct * 100)}% ${label}`;
}

/** Hero details and ability buttons, shown in the selection panel for your hero. */
export function HeroBlock({ u }: { u: UnitView }): JSX.Element | null {
  useSecondTick();
  const { state, actions } = useGame();
  const hd = heroDefForType(u.type);
  const own = u.own;
  if (!hd || !own) return null;
  const abilities = own.abilities ?? [];
  if (!reportedAt.has(abilities)) reportedAt.set(abilities, Date.now());
  const elapsed = (Date.now() - (reportedAt.get(abilities) ?? Date.now())) / 1000;
  const ranks = state.player?.hero?.ranks ?? {};
  return (
    <div className="hero-block">
      <h3>Hero: {hd.name}</h3>
      <p className="small">
        <b>Strong:</b> {hd.strengths}. <b>Weak:</b> {hd.weaknesses}.
      </p>
      <div className="kv">
        {own.damage !== undefined && (
          <>
            <span>Attack</span>
            <span>{own.damage} damage{state.combatEnabled ? "" : " (combat is off on this server)"}</span>
          </>
        )}
        <span>Armor</span>
        <span>{Math.round((own.armor ?? 0) * 100)}% damage reduction</span>
        {hd.aura && (
          <>
            <span>Aura</span>
            <span>
              {hd.aura.name}: {hd.aura.description.toLowerCase()} (within {Math.round(hd.aura.radius * Math.max(0.2, 1 + state.modifierPct("heroAura")))} tiles)
            </span>
          </>
        )}
        {hd.trait && (
          <>
            <span>Trait</span>
            <span>{hd.trait}</span>
          </>
        )}
        <span>Training</span>
        <span>{Object.values(HERO_TRAINING).map((t) => `${t.name} ${ranks[t.id] ?? 0}/${t.maxRank}`).join(" · ")}</span>
      </div>
      {own.buffs.length > 0 && (
        <p className="small good">
          Active: {own.buffs.map((b) => `${describeBuff(b.stat, b.pct)} (${Math.max(0, Math.round(b.seconds - elapsed))}s)`).join(" · ")}
        </p>
      )}
      <ul className="ability-list">
        {hd.abilities.map((a) => {
          const st = abilities.find((x) => x.id === a.id);
          const wait = Math.max(0, Math.ceil((st?.readyIn ?? 0) - elapsed));
          const blocked = a.combat && !state.combatEnabled;
          const aiming = state.targeting?.unitId === u.id && state.targeting.ability === a.id;
          return (
            <li key={a.id} className={`ability ${blocked ? "locked" : ""}`}>
              <button
                className={aiming ? "primary" : ""}
                disabled={blocked || wait > 0}
                title={a.description}
                onClick={() => {
                  if (a.target === "none") actions.useAbility(u.id, a.id);
                  else if (aiming) state.setTargeting(null);
                  else state.setTargeting({ unitId: u.id, ability: a.id, name: a.name, target: a.target, range: abilityRange(a) });
                }}
              >
                {a.combat ? "⚔ " : ""}
                {a.name}
                {wait > 0 ? ` (${wait}s)` : ""}
              </button>
              <span className="muted small">
                {a.description} Cooldown {Math.round(a.cooldown * Math.max(0.2, 1 + state.modifierPct("heroCooldown")))}s.
                {blocked ? " Needs combat, which is off on this server." : ""}
                {a.target !== "none" && !blocked ? ` Click it, then click ${a.target === "enemy" ? "a unit" : "a spot"} (Esc cancels).` : ""}
              </span>
              <code className="small">use_ability("{a.id}"{a.target === "enemy" ? ", target" : a.target === "point" ? ", x, y" : ""})</code>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Recruit or revive your hero (Town Hall; revive also at a Barracks). */
export function HeroRecruitBlock({ buildingId, type }: { buildingId: number; type: string }): JSX.Element | null {
  const { state, actions } = useGame();
  const h = state.player?.hero;
  const hd = heroDefForRace(state.race);
  if (!h || !hd) return null;
  const queued = [...state.buildings.values()].some((b) => b.own?.queue.some((q) => q.kind === "hero"));
  if (type === "barracks" && !h.recruited) return null;
  return (
    <>
      <h3>Hero</h3>
      {h.unitId !== null ? (
        <div className="row">
          <span className="small">Your {hd.name} is alive.</span>
          <span className="spacer" />
          <button
            className="small"
            onClick={() => {
              const u = state.units.get(h.unitId as number);
              state.select({ kind: "unit", id: h.unitId as number });
              if (u) rendererRef.current?.centerOn(u.x, u.y);
            }}
          >
            Select
          </button>
        </div>
      ) : queued ? (
        <p className="small muted">Your {hd.name} is on the way.</p>
      ) : (
        <>
          <button className="primary" disabled={!canAfford(state, h.cost)} onClick={() => actions.recruitHero(buildingId)}>
            {h.revive ? "Revive" : "Recruit"} {hd.name} ({RESOURCE_SUM(h.cost) === 0 ? "free" : formatCostText(h.cost)}, {h.time}s)
          </button>
          <p className="small muted">
            {h.revive ? `Your ${hd.name} fell${h.deaths > 1 ? ` ${h.deaths} times` : ""}; reviving keeps all of their training.` : `${hd.strengths}. One hero per player.`}
          </p>
        </>
      )}
    </>
  );
}

function RESOURCE_SUM(c: Record<string, number>): number {
  return Object.values(c).reduce((a, b) => a + b, 0);
}

/** Barracks battle training ranks. */
export function BattleTraining({ buildingId }: { buildingId: number }): JSX.Element | null {
  const { state, actions } = useGame();
  const h = state.player?.hero;
  if (!h) return null;
  const queued: Record<string, number> = {};
  for (const b of state.buildings.values()) for (const q of b.own?.queue ?? []) if (q.kind === "hero_training") queued[q.id.split(":")[0] as string] = (queued[q.id.split(":")[0] as string] ?? 0) + 1;
  return (
    <>
      <h3>Battle training</h3>
      {!h.recruited && <p className="small muted">Recruit your hero at a Town Hall first.</p>}
      <ul className="tech-list">
        {Object.values(HERO_TRAINING).map((t) => {
          const rank = (h.ranks[t.id] ?? 0) + (queued[t.id] ?? 0);
          const next = rank + 1;
          const c = heroTrainingCost(next);
          return (
            <li key={t.id} className="tech">
              <div className="row">
                <b>{t.name}</b> <span className="muted small">&nbsp;rank {h.ranks[t.id] ?? 0}/{t.maxRank}{queued[t.id] ? ` (+${queued[t.id]} queued)` : ""}</span>
                <span className="spacer" />
                {next <= t.maxRank ? (
                  <button className="small" disabled={!h.recruited || !canAfford(state, c.cost)} onClick={() => actions.trainHero(buildingId, t.id)}>
                    Rank {next} ({formatCostText(c.cost)}, {c.time}s)
                  </button>
                ) : (
                  <span className="badge badge-running">max</span>
                )}
              </div>
              <div className="muted small">{t.description}. Kept if your hero falls.</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Top-bar shortcut: select your hero (Y), or go to the Town Hall to recruit one. */
export function HeroButton(): JSX.Element | null {
  const { state } = useGame();
  const h = state.player?.hero;
  const hd = heroDefForRace(state.race);
  if (!h || !hd) return null;
  const u = h.unitId !== null ? state.units.get(h.unitId) : undefined;
  const label = u ? `★ ${hd.name}` : h.recruited ? "★ Revive" : "★ Recruit";
  return (
    <button
      className={`hero-btn ${u ? "" : "hero-missing"}`}
      title={u ? `Select your ${hd.name} (Y)` : `Recruit or revive your ${hd.name} at your Town Hall`}
      onClick={() => {
        if (u) {
          state.select({ kind: "unit", id: u.id });
          rendererRef.current?.centerOn(u.x, u.y);
          return;
        }
        const hall = [...state.buildings.values()].find((b) => b.owner === state.playerId && b.type === "town_hall" && b.complete);
        if (hall) {
          state.select({ kind: "building", id: hall.id });
          rendererRef.current?.centerOn(hall.x + 1, hall.y + 1);
        }
      }}
    >
      {label}
      {u && (
        <span className="xpbar" aria-hidden>
          <span style={{ width: `${u.hpPct}%`, background: "#5cd35c" }} />
        </span>
      )}
    </button>
  );
}
