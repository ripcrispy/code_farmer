import type { JSX } from "react";
import { RESOURCE_TYPES } from "../../shared/defs/resources.ts";
import { raceDef } from "../../shared/defs/races.ts";
import { describeEffect } from "../../shared/defs/effects.ts";
import { useGame, useUiVersion } from "./context.ts";
import { HeroButton } from "./HeroPanel.tsx";
import { LESSONS } from "../../shared/defs/lessons.ts";

const LESSON_COUNT = LESSONS.length;

/** PvP opt-in. Opting out takes effect after a delay (shown as a countdown). */
function PvpToggle(): JSX.Element | null {
  const { state, actions } = useGame();
  const c = state.player?.combat;
  if (!c) return null;
  const leaving = !c.optedIn && c.active && c.leavingInSeconds !== null;
  const label = c.optedIn ? "PvP on" : leaving ? `PvP ending ${c.leavingInSeconds}s` : "PvP off";
  const title = c.optedIn
    ? "You can attack, and be attacked by, other players who opted in. Click to opt out (takes effect after a delay)."
    : leaving
      ? "You are leaving PvP. Fighting restarts the countdown. Click to stay in PvP."
      : "Peaceful: other players cannot attack you or your buildings. Click to opt in to PvP combat.";
  return (
    <button className={`pvp ${c.active ? "pvp-on" : ""}`} title={title} onClick={() => void actions.setPvp(!c.optedIn)}>
      ⚔ {label}
    </button>
  );
}

const RES_COLORS: Record<string, string> = { wood: "#8b5a2b", stone: "#9a9a9a", gold: "#e5c040", food: "#c0406a" };

export function TopBar({ onHelp }: { onHelp: () => void }): JSX.Element {
  useUiVersion();
  const { state, logout } = useGame();
  const p = state.player;
  const race = raceDef(state.race);
  const statusText: Record<string, string> = { online: "Online", connecting: "Connecting", reconnecting: "Reconnecting", offline: "Offline", idle: "Idle" };
  return (
    <header className="topbar">
      <div className="brand">Code Farmer</div>
      <div className="resources" aria-label="Resources">
        {RESOURCE_TYPES.map((r) => (
          <span key={r} className="res" title={r}>
            <i style={{ background: RES_COLORS[r] }} />
            <b>{p ? p.resources[r] : "-"}</b> {r}
          </span>
        ))}
      </div>
      <div className="counts">
        {p ? `${p.unitCount}/${p.limits.units} units · ${p.buildingCount}/${p.limits.buildings} buildings · ${p.territory} tiles` : ""}
      </div>
      <div className="spacer" />
      <div className="who" title={race ? `${race.theme}: ${race.passives.map(describeEffect).join(", ")}` : ""}>
        {state.name} <span className="muted">· {race?.name ?? state.race}</span>
      </div>
      {p && (
        <button className="level" onClick={() => state.openTalents(true)} title={`${p.xp} XP${p.level < 60 ? ` · ${p.xpNextLevel - p.xp} to level ${p.level + 1}` : " · maximum level"}`}>
          Lv {p.level}
          <span className="xpbar" aria-hidden>
            <span style={{ width: `${p.xpNextLevel > p.xpLevelStart ? Math.min(100, ((p.xp - p.xpLevelStart) / (p.xpNextLevel - p.xpLevelStart)) * 100) : 100}%` }} />
          </span>
          {p.talentPoints - p.talentPointsSpent > 0 && <span className="badge badge-dirty">{p.talentPoints - p.talentPointsSpent} talent pts</span>}
        </button>
      )}
      <div className={`conn conn-${state.connection}`} title={state.connectionDetail} role="status">
        <i /> {statusText[state.connection] ?? state.connection}
      </div>
      {state.combatEnabled && p && <PvpToggle />}
      {p && <HeroButton />}
      <button onClick={() => state.openLessons(true)} title="Guided coding lessons">
        Lessons{p ? ` ${p.lessons.length}/${LESSON_COUNT}` : ""}
      </button>
      <button onClick={() => state.openStats(true)}>Stats</button>
      <button onClick={() => state.openLibrary(true)}>Library</button>
      <button onClick={onHelp}>Help</button>
      <button onClick={logout}>Log out</button>
    </header>
  );
}
