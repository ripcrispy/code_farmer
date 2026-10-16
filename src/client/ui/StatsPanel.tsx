import { useCallback, useEffect, useState, type JSX } from "react";
import { findBuildingDef } from "../../shared/defs/buildings.ts";
import { STAT_LABELS, describeEffect, isStatKey } from "../../shared/defs/effects.ts";
import { DISCOVERY_DEFS } from "../../shared/defs/discoveries.ts";
import { LAIR_DEFS, findLairDef } from "../../shared/defs/lairs.ts";
import { lairStatusText } from "./HoverInfo.tsx";
import { rendererRef } from "./WorldCanvas.tsx";
import { findUnitDef } from "../../shared/defs/units.ts";
import { SpeciesBehaviour } from "./SpeciesBehaviour.tsx";
import { raceDef } from "../../shared/defs/races.ts";
import { TECH_DEFS } from "../../shared/defs/techs.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { formatDuration } from "./format.ts";
import { useGame, useUiVersion } from "./context.ts";

type Stats = Extract<ServerMessage, { t: "stats" }>;

/** Territory statistics, expansion history, leaderboard, research and active bonuses. */
export function StatsPanel(): JSX.Element {
  useUiVersion();
  const { state, actions } = useGame();
  const [stats, setStats] = useState<Stats | null>(null);
  const refresh = useCallback(async () => {
    const r = await actions.stats();
    if (r.t === "stats") setStats(r);
  }, [actions]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") state.openStats(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, state]);
  const p = state.player;
  return (
    <div className="editor-backdrop" role="dialog" aria-label="Statistics" onClick={() => state.openStats(false)}>
      <div className="help stats" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2>Civilisation</h2>
          <span className="spacer" />
          <button onClick={() => state.openStats(false)}>Close (Esc)</button>
        </div>
        <div className="stat-tiles">
          <div><b>{stats?.territory ?? p?.territory ?? 0}</b><span>tiles of territory</span></div>
          <div><b>{stats?.explored ?? p?.explored ?? 0}</b><span>chunks explored</span></div>
          <div><b>{p?.unitCount ?? 0}</b><span>units</span></div>
          <div><b>{p?.buildingCount ?? 0}</b><span>buildings</span></div>
          <div><b>{p ? `${p.limits.units} / ${p.limits.buildings}` : "-"}</b><span>unit / building limits (research raises them)</span></div>
        </div>
        <div className="cols">
          <section>
            <h3>Territory leaderboard</h3>
            <ol className="leaderboard">
              {stats?.leaderboard.map((r) => (
                <li key={r.id} className={r.id === state.playerId ? "me" : ""}>
                  <i style={{ background: `#${(raceDef(r.race)?.color ?? 0xffffff).toString(16).padStart(6, "0")}` }} />
                  {r.name} <span className="muted small">{raceDef(r.race)?.name}</span>
                  <span className="spacer" />
                  {r.territory}
                </li>
              ))}
            </ol>
            <h3>Expansion history</h3>
            {stats && stats.history.length === 0 && <p className="muted small">No expansions recorded yet.</p>}
            <ul className="history-list">
              {stats?.history.map((h, i) => (
                <li key={i}>
                  <span className="muted">{formatDuration(h.seconds)}</span> {findBuildingDef(h.buildingType)?.name ?? h.buildingType} #{h.buildingId} claimed {h.tiles} tiles
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>Research</h3>
            {p?.techs.length ? (
              <ul className="history-list">{p.techs.map((t) => <li key={t}>{TECH_DEFS[t]?.name ?? t}</li>)}</ul>
            ) : (
              <p className="muted small">Nothing researched yet. Build a Lodge, then a Library.</p>
            )}
            <h3>Discoveries</h3>
            <ul className="discovery-list">
              {Object.values(DISCOVERY_DEFS).map((d) => {
                const known = p?.discoveries.includes(d.id) ?? false;
                if (!known && d.tier === "hidden") return <li key={d.id} className="unknown">??? <span className="muted small">(hidden discovery)</span></li>;
                return (
                  <li key={d.id} className={known ? "" : "unknown"}>
                    <b>{d.name}</b> {known ? <span className="badge badge-running">found</span> : <span className="muted small">— {d.source}</span>}
                    <div className="muted small">{known ? `${d.description} ${d.effects.map(describeEffect).join(", ")}` : ""}</div>
                  </li>
                );
              })}
            </ul>
            <h3>Trophies</h3>
            <ul className="discovery-list">
              {Object.values(LAIR_DEFS).map((l) => {
                const won = p?.trophies.includes(l.trophy.id) ?? false;
                return (
                  <li key={l.trophy.id} className={won ? "" : "unknown"}>
                    <b>{l.trophy.name}</b> {won ? <span className="badge badge-running">won</span> : <span className="muted small">— defeat the {findUnitDef(l.boss)?.name ?? l.boss} of a {l.name}</span>}
                    {won && <div className="muted small">{l.trophy.description} {l.trophy.effects.map(describeEffect).join(", ")}</div>}
                  </li>
                );
              })}
            </ul>
            <h3>Known lairs</h3>
            {state.lairs.size ? (
              <ul className="history-list">
                {[...state.lairs.values()].map((l) => (
                  <li key={l.id}>
                    <button className="link" onClick={() => rendererRef.current?.centerOn(l.x, l.y)}>
                      {findLairDef(l.kind)?.name ?? l.kind} at {l.x}, {l.y}
                    </button>{" "}
                    <span className="muted small">{lairStatusText(l)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None seen yet. Lairs lie at least 120 tiles from the world's centre: explore to find them.</p>
            )}
            <h3>Known species</h3>
            {p?.observed.length ? (
              <ul className="discovery-list">
                {p.observed.map((sp) => (
                  <li key={sp}>
                    <b>{findUnitDef(sp)?.name ?? sp}</b>
                    <SpeciesBehaviour type={sp} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None yet. Have a unit observe() a creature to learn how it behaves.</p>
            )}
            <h3>Active bonuses</h3>
            {p?.modifiers.length ? (
              <ul className="history-list">
                {p.modifiers.map((m) => (
                  <li key={m.stat}>
                    {isStatKey(m.stat) ? STAT_LABELS[m.stat] : m.stat}: {m.pct ? `${m.pct > 0 ? "+" : ""}${Math.round(m.pct * 100)}%` : ""}
                    {m.add ? ` ${m.add > 0 ? "+" : ""}${m.add}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
