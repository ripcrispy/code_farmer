import type { JSX } from "react";
import { NEUTRAL_OWNER, type UnitOwnView } from "../../shared/protocol.ts";
import { SpeciesBehaviour } from "./SpeciesBehaviour.tsx";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { findBuildingDef, FERTILE_BONUS } from "../../shared/defs/buildings.ts";
import { BALANCE } from "../../shared/defs/balance.ts";
import { RESOURCE_TYPES, type ResourceBag } from "../../shared/defs/resources.ts";
import { findUnitDef } from "../../shared/defs/units.ts";
import { raceDef } from "../../shared/defs/races.ts";
import { TECH_DEFS } from "../../shared/defs/techs.ts";
import { STAT_LABELS, describeEffect } from "../../shared/defs/effects.ts";
import { canAfford, formatCostText, scaledCost } from "./format.ts";
import { useGame, useUiVersion } from "./context.ts";
import { rendererRef } from "./WorldCanvas.tsx";
import { BattleTraining, HeroBlock, HeroRecruitBlock } from "./HeroPanel.tsx";
import { HERO_TRAINING, heroDefForRace } from "../../shared/defs/heroes.ts";

function Bar({ value, max, color }: { value: number; max: number; color: string }): JSX.Element {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div style={{ width: `${pct}%`, background: color }} />
      <span>
        {Math.round(value)} / {max}
      </span>
    </div>
  );
}

export function TraceList({ trace, limit }: { trace: NonNullable<UnitOwnView["trace"]>; limit?: number }): JSX.Element {
  const items = limit ? trace.slice(-limit) : trace;
  if (items.length === 0) return <p className="muted small">No script actions yet.</p>;
  return (
    <ol className="trace">
      {items.map((e, i) => (
        <li key={i} className={e.result === "" ? "pending" : e.ok ? "ok" : "fail"}>
          <span className="muted">[{e.t}s] L{e.line}</span> <code>{e.call}</code> → {e.result === "" ? "in progress" : e.result}
        </li>
      ))}
    </ol>
  );
}

function ResearchList({ buildingId }: { buildingId: number }): JSX.Element {
  const { state, actions } = useGame();
  const done = new Set(state.player?.techs ?? []);
  const queued = new Set<string>();
  for (const b of state.buildings.values()) for (const q of b.own?.queue ?? []) if (q.kind === "tech") queued.add(q.id);
  return (
    <>
      <h3>Research</h3>
      <ul className="tech-list">
        {Object.values(TECH_DEFS).map((t) => {
          const missing = t.requires.find((r) => !done.has(r));
          const status = done.has(t.id) ? "done" : queued.has(t.id) ? "queued" : missing ? "locked" : "available";
          return (
            <li key={t.id} className={`tech ${status}`}>
              <div className="row">
                <b>{t.name}</b>
                <span className="spacer" />
                {status === "available" && (
                  <button className="small" disabled={!canAfford(state, t.cost)} onClick={() => actions.research(buildingId, t.id)}>
                    Research ({formatCostText(t.cost)}, {t.time}s)
                  </button>
                )}
                {status === "done" && <span className="badge badge-running">done</span>}
                {status === "queued" && <span className="badge badge-paused">in progress</span>}
                {status === "locked" && <span className="muted small">needs {TECH_DEFS[missing as string]?.name}</span>}
              </div>
              <div className="muted small">{t.effects.map(describeEffect).join(" · ")}</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Public creature facts (tier 1), plus taming/training details and the behaviour code once observed. */
function CreatureInfoBlock({ type, wild, learned }: { type: string; wild: boolean; learned: string[] }): JSX.Element | null {
  const { state } = useGame();
  const def = findUnitDef(type);
  const c = def?.creature;
  if (!def || !c) return null;
  const observed = state.player?.observed.includes(type) ?? false;
  return (
    <>
      <p className="muted small">{def.description}</p>
      <div className="kv">
        <span>Status</span>
        <span>{wild ? "Wild" : "Tamed"}</span>
        <span>Taming</span>
        <span>{c.tameCost > 0 ? `carry ${c.tameCost} food (Rangers: ${Math.ceil(c.tameCost / 2)})${observed ? "" : "; observe one first"}` : "cannot be tamed"}</span>
        {c.tameCost > 0 && (
          <>
            <span>In a paddock</span>
            <span>{paddockText(type)}</span>
          </>
        )}
        {Object.keys(c.trainable).length > 0 && (
          <>
            <span>Trainable</span>
            <span>
              {Object.entries(c.trainable).map(([k, t]) => `${k} (${t.cost} food, ${t.seconds}s${learned.includes(k) ? ", learned" : ""})`).join(" · ")}
            </span>
          </>
        )}
      </div>
      {wild && (
        <p className="muted small">
          {observed
            ? c.tameCost > 0
              ? "Select a unit carrying food and right-click this creature to tame it, or use tame() in a program."
              : "You know how this species behaves."
            : `Select a unit and right-click this creature to observe it for ${c.observeSeconds}s (or use observe() in a program) to learn its behaviour.`}
        </p>
      )}
      {observed && <SpeciesBehaviour type={type} />}
    </>
  );
}

/** What an animal does in a paddock (production, settlement bonus, breeding). */
export function paddockText(type: string): string {
  const pk = findUnitDef(type)?.creature?.paddock;
  if (!pk) return "cannot be kept in a paddock";
  const parts: string[] = [];
  const prod = RESOURCE_TYPES.filter((r) => pk.produces[r]).map((r) => `${pk.produces[r]} ${r}`);
  if (prod.length) parts.push(`${prod.join(" and ")} a minute`);
  if (pk.bonus) parts.push(`${pk.bonus.pct ? `+${Math.round(pk.bonus.pct * 100)}%` : `+${pk.bonus.add}`} ${STAT_LABELS[pk.bonus.stat]} each (up to ${pk.bonus.maxAnimals})`);
  parts.push(`a pair raises a young one every ${Math.round(pk.breedSeconds / 60)} min (${pk.breedCost} food)`);
  return parts.join("; ");
}

/** A PvE monster: what it is, its lair, and what killing it gives. */
function MonsterInfoBlock({ type }: { type: string }): JSX.Element | null {
  const { state } = useGame();
  const def = findUnitDef(type);
  const m = def?.monster;
  if (!def || !m) return null;
  return (
    <>
      <p className="muted small">{def.description}</p>
      <div className="kv">
        <span>Monster</span>
        <span>{m.boss ? "★ Boss of its lair" : "Lair guard"}</span>
        <span>Fights</span>
        <span>{def.attack ? `${def.attack.damage} damage every ${def.attack.cooldown}s, range ${def.attack.range}` : "no"}</span>
        <span>Reward</span>
        <span>
          {m.xp} XP{m.boss ? "; the lair's boss loot, a trophy and a discovery" : RESOURCE_TYPES.some((r) => m.loot[r]) ? `; ${formatCostText(m.loot)}` : ""}
        </span>
      </div>
      <p className="muted small">
        {state.fightingEnabled
          ? "It attacks anyone who enters its lair. Select your units and right-click it to attack; Knights, Soldiers, Archers, Clerics (healing) and your hero make a good hunting party."
          : "Fighting is disabled on this server."}
      </p>
      <SpeciesBehaviour type={type} />
    </>
  );
}

/** Send a tamed animal to your nearest paddock with room. */
function PenButton({ unitId, x, y }: { unitId: number; x: number; y: number }): JSX.Element {
  const { state, actions } = useGame();
  let best: { id: number; d: number } | null = null;
  for (const b of state.buildings.values()) {
    const def = findBuildingDef(b.type);
    if (b.owner !== state.playerId || !b.complete || !def?.pen) continue;
    if ((b.own?.paddock?.animals.length ?? 0) >= def.pen) continue;
    const d = Math.max(Math.abs(b.x - x), Math.abs(b.y - y));
    if (!best || d < best.d) best = { id: b.id, d };
  }
  return (
    <div className="buttons">
      <button disabled={!best} onClick={() => best && actions.penAnimal(unitId, best.id)} title="Or select it and right-click one of your paddocks">
        {best ? "Send to paddock" : "Build a Paddock to keep it"}
      </button>
    </div>
  );
}

/** A paddock's animals, output, bonuses and breeding. */
function PaddockBlock({ buildingId }: { buildingId: number }): JSX.Element | null {
  const { state, actions } = useGame();
  const b = state.buildings.get(buildingId);
  const pk = b?.own?.paddock;
  if (!b || !pk) return null;
  const counts = new Map<string, number>();
  for (const a of pk.animals) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  const output = RESOURCE_TYPES.filter((r) => pk.perMinute[r]).map((r) => `${pk.perMinute[r]} ${r}`);
  return (
    <>
      <h3>
        Animals ({pk.animals.length}/{pk.capacity})
      </h3>
      {pk.animals.length === 0 && <p className="muted small">Empty. Tame sheep, goats, horses, aurochs, bears, boars or wolves: most walk here by themselves; or select one and right-click the paddock.</p>}
      <ul className="unit-list">
        {[...counts].map(([type, n]) => (
          <li key={type}>
            <b>
              {n} × {findUnitDef(type)?.name ?? type}
            </b>{" "}
            <span className="muted small">{paddockText(type)}</span>
            <div className="buttons">
              {pk.animals
                .filter((a) => a.type === type)
                .map((a) => (
                  <button key={a.id} className="small" onClick={() => actions.releaseAnimal(b.id, a.id)} title="Let it out of the paddock">
                    Release #{a.id}
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
      {output.length > 0 && <p className="muted small">Produces {output.join(", ")} per minute.</p>}
      {pk.breeding.map((br) => (
        <div key={br.type} className="kv">
          <span>Young {findUnitDef(br.type)?.name ?? br.type}</span>
          <Bar value={Math.round(br.progress * 100)} max={100} color="#7ac070" />
        </div>
      ))}
      {pk.animals.length >= pk.capacity && <p className="muted small">Full: no room for young ones.</p>}
    </>
  );
}

function buildingInKnownZone(state: { zoneAt: (x: number, y: number) => unknown }, b: { x: number; y: number; w: number; h: number }): boolean {
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (state.zoneAt(x, y)) return true;
  return false;
}

function Inventory({ inv }: { inv: ResourceBag }): JSX.Element {
  const items = RESOURCE_TYPES.filter((r) => inv[r] > 0);
  return <span>{items.length ? items.map((r) => `${inv[r]} ${r}`).join(", ") : "empty"}</span>;
}

export function SelectionPanel(): JSX.Element {
  useUiVersion();
  const { state, actions } = useGame();
  const sel = state.selection;
  if (!sel) {
    return (
      <section className="panel">
        <h2>Nothing selected</h2>
        <p className="muted">Left-click a unit or building to inspect it. Press Tab to cycle through your units. Shift-click or shift-drag selects several units.</p>
        <p className="muted">With a unit selected, right-click a resource to gather, your construction site to build, your storage to deposit, or open ground to move.</p>
      </section>
    );
  }
  if (sel.kind === "units") {
    const units = sel.ids.map((id) => state.units.get(id)).filter((u): u is NonNullable<typeof u> => !!u);
    const byType = new Map<string, number>();
    for (const u of units) byType.set(u.type, (byType.get(u.type) ?? 0) + 1);
    const ids = units.map((u) => u.id);
    return (
      <section className="panel">
        <h2>{units.length} units selected</h2>
        <p className="muted small">{[...byType].map(([t, n]) => `${n} ${findUnitDef(t)?.name ?? t}`).join(" · ")}</p>
        <div className="buttons">
          <button className="primary" onClick={() => state.openLibrary(true)}>Assign library program…</button>
          <button onClick={() => void actions.unitsControl(ids, "run")}>Run all</button>
          <button onClick={() => void actions.unitsControl(ids, "pause")}>Pause all</button>
          <button onClick={() => void actions.unitsControl(ids, "stop")}>Stop all</button>
          <button onClick={() => state.select(null)}>Clear</button>
          {units.some((u) => u.owner === state.playerId && !findUnitDef(u.type)?.hero) && (
            <ConfirmButton
              label="Dismiss all"
              confirmLabel={`Dismiss ${units.filter((u) => u.owner === state.playerId && !findUnitDef(u.type)?.hero).length}? Click again`}
              title="Remove these units for good (tamed animals go back to the wild; your hero stays)"
              onConfirm={() => void actions.dismissUnits(units.filter((u) => u.owner === state.playerId && !findUnitDef(u.type)?.hero).map((u) => u.id))}
            />
          )}
        </div>
        <ul className="unit-list">
          {units.map((u) => (
            <li key={u.id}>
              <button className="link" onClick={() => state.select({ kind: "unit", id: u.id })}>
                {findUnitDef(u.type)?.name ?? u.type} #{u.id}
              </button>{" "}
              <span className={`badge badge-${u.own?.program.state ?? ""}`}>{u.own?.program.state}</span>{" "}
              <span className="muted small">{u.own?.program.library ? `“${u.own.program.library.name}”` : ""} {u.own?.task}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (sel.kind === "unit") {
    const u = state.units.get(sel.id);
    if (!u) return <section className="panel"><h2>Unit #{sel.id}</h2><p className="muted">No longer visible.</p></section>;
    const def = findUnitDef(u.type);
    const mine = u.owner === state.playerId;
    const own = u.own;
    const race = raceDef(state.ownerRace(u.owner));
    return (
      <section className="panel">
        <h2>
          {def?.name ?? u.type} <span className="muted">#{u.id}</span>
        </h2>
        <div className="kv">
          <span>Owner</span>
          <span>{mine ? "You" : state.ownerName(u.owner)}{u.owner === NEUTRAL_OWNER ? "" : ` (${race?.name ?? "?"})`}</span>
          <span>Position</span>
          <span>{u.x}, {u.y}</span>
          <span>Activity</span>
          <span>{u.activity}</span>
          {!own && (
            <>
              <span>Health</span>
              <Bar value={u.hpPct} max={100} color="#5cb85c" />
            </>
          )}
          {state.fightingEnabled && def?.attack && !def.monster && (
            <>
              <span>Combat</span>
              <span>
                {own?.damage ?? def.attack.damage} damage every {def.attack.cooldown}s, range {def.attack.range}
                {own?.armor ? `, ${Math.round(own.armor * 100)}% armor` : ""}
                {def.attack.buildingFactor > 0 && def.attack.buildingFactor !== 1 ? ` (×${def.attack.buildingFactor} vs buildings)` : ""}
              </span>
            </>
          )}
          {state.combatEnabled && !mine && u.owner !== NEUTRAL_OWNER && (
            <>
              <span>PvP</span>
              <span>{state.ownerPvp(u.owner) ? "opted in (can be attacked by players in PvP)" : "peaceful"}</span>
            </>
          )}
        </div>
        {def?.creature && <CreatureInfoBlock type={u.type} wild={u.owner === NEUTRAL_OWNER} learned={own?.learned ?? []} />}
        {def?.monster && <MonsterInfoBlock type={u.type} />}
        {own && def?.creature?.paddock && own.pen === undefined && <PenButton unitId={u.id} x={u.x} y={u.y} />}
        {own?.pen !== undefined && (
          <div className="buttons">
            <button onClick={() => state.select({ kind: "building", id: own.pen as number })}>Show its paddock</button>
          </div>
        )}
        {state.zoneAt(u.x, u.y) && u.owner !== NEUTRAL_OWNER && <p className="warn small">⚔ In a contested zone: any player can attack this unit here.</p>}
        {!mine && u.owner !== NEUTRAL_OWNER && (
          <p className="muted">
            Other players' inventories and programs are private. {u.carrying ? "This unit is carrying cargo." : ""}
          </p>
        )}
        {own && def?.hero && <HeroBlock u={u} />}
        {!own && def?.hero && <p className="muted small">A hero: {def.description}</p>}
        {own && (
          <>
            <div className="kv">
              <span>Health</span>
              <Bar value={own.hp} max={own.maxHp} color="#5cb85c" />
              {own.capacity > 0 && (
                <>
                  <span>Cargo</span>
                  <Bar value={RESOURCE_TYPES.reduce((a, r) => a + own.inventory[r], 0)} max={own.capacity} color="#c8a040" />
                  <span />
                  <Inventory inv={own.inventory} />
                </>
              )}
              <span>Task</span>
              <span>{own.task}</span>
              {own.target && (
                <>
                  <span>Target</span>
                  <span>{own.target}</span>
                </>
              )}
            </div>
            {own.hidden && <p className="muted small">👁 Hidden: other players cannot see this unit unless they have a unit within 5 tiles (12 for a Watchtower).</p>}
            {own.blocked && <div className="blocked" role="alert">⚠ {own.blocked}</div>}
            <h3>Program</h3>
            <div className="kv">
              <span>State</span>
              <span className={`badge badge-${own.program.state}`}>{own.program.state}</span>
              <span>Version</span>
              <span>{own.program.version === 0 ? "default" : `v${own.program.version}`}{own.program.library ? ` · library “${own.program.library.name}” v${own.program.library.version}` : ""}</span>
            </div>
            {own.program.note && <p className="muted small">{own.program.note}</p>}
            {own.program.error && (
              <div className="blocked" role="alert">
                Line {own.program.error.line}: {own.program.error.message}
              </div>
            )}
            <div className="buttons">
              <button className="primary" onClick={() => state.openEditor(u.id)}>Edit code</button>
              {own.program.state === "running" && <button onClick={() => void actions.controlProgram(u.id, "pause")}>Pause</button>}
              {own.program.state === "paused" && <button onClick={() => void actions.controlProgram(u.id, "resume")}>Resume</button>}
              {own.program.state !== "running" && <button onClick={() => void actions.controlProgram(u.id, "run")}>Run</button>}
              {(own.program.state === "running" || own.program.state === "paused") && <button onClick={() => void actions.controlProgram(u.id, "stop")}>Stop program</button>}
            </div>
            <div className="buttons">
              <button onClick={() => actions.stopUnit(u.id)} title="Cancel the current task (also stops the program)">Halt</button>
              {own.capacity > 0 && <button onClick={() => actions.depositUnit(u.id)} disabled={!u.carrying}>Deposit cargo</button>}
              <button onClick={() => rendererRef.current?.centerOn(u.x, u.y)}>Center</button>
              {!def?.hero && (
                <ConfirmButton
                  label={def?.creature ? "Release to the wild" : "Dismiss"}
                  confirmLabel="Click again to confirm"
                  title={def?.creature ? "It goes back to the wild where it stands" : "Remove this unit for good (anything it carries is lost)"}
                  onConfirm={() => void actions.dismissUnits([u.id])}
                />
              )}
            </div>
            <h3>Log</h3>
            <pre className="log">{own.log?.length ? own.log.join("\n") : "(empty)"}</pre>
            <h3>Recent actions</h3>
            <TraceList trace={own.trace ?? []} limit={6} />
          </>
        )}
      </section>
    );
  }
  const b = state.buildings.get(sel.id);
  if (!b) return <section className="panel"><h2>Building #{sel.id}</h2><p className="muted">No longer visible.</p></section>;
  const def = findBuildingDef(b.type);
  const mine = b.owner === state.playerId;
  return (
    <section className="panel">
      <h2>
        {def?.name ?? b.type} <span className="muted">#{b.id}</span>
      </h2>
      <p className="muted small">{def?.description}</p>
      {buildingInKnownZone(state, b) && <p className="warn small">⚔ In a contested zone: any player can attack this building, opted in or not.</p>}
      <div className="kv">
        <span>Owner</span>
        <span>{mine ? "You" : state.ownerName(b.owner)}</span>
        <span>Footprint</span>
        <span>{b.w}×{b.h} at {b.x}, {b.y}</span>
        <span>Status</span>
        <span>{b.complete ? "Complete" : `Under construction (${Math.floor(b.progress * 100)}%)`}</span>
        <span>Health</span>
        <Bar value={b.hp} max={b.maxHp} color="#5cb85c" />
      </div>
      {!b.complete && mine && <p className="muted small">Select a unit and right-click this site to build it, or let the Builder's program find it.</p>}
      {b.complete && def?.storage && !b.own?.storage && <p className="muted small">Storage: units deposit cargo here.</p>}
      {b.own?.storage && (
        <>
          <h3>Stored here</h3>
          <div className="kv">
            <span>Contents</span>
            <Bar value={RESOURCE_TYPES.reduce((a, r) => a + (b.own?.storage?.stock[r] ?? 0), 0)} max={b.own.storage.capacity} color="#c8a040" />
            <span />
            <Inventory inv={b.own.storage.stock} />
          </div>
          <p className="muted small">
            Costs of work within {BALANCE.supplyRange} tiles are paid from this building's storage network (storage buildings within {BALANCE.storageLinkRange} tiles of each other share their contents). Haul resources here with withdraw() and deposit(storage).
          </p>
        </>
      )}
      {b.own?.productionBlocked && <div className="blocked" role="alert">⚠ No storage with room within {BALANCE.supplyRange} tiles: production is held until there is.</div>}
      {b.complete && def?.produces && b.own && (
        <p className="muted small">
          Produces {RESOURCE_TYPES.filter((r) => def.produces?.[r]).map((r) => `${((def.produces?.[r] ?? 0) * (1 + FERTILE_BONUS * b.own!.fertility) * Math.max(0.2, 1 + state.modifierPct("production")) * 60).toFixed(1)} ${r}/min`).join(", ")}
          {b.own.fertility > 0 ? ` (fertile soil bonus ${Math.round(b.own.fertility * 100)}%)` : ""}
        </p>
      )}
      {b.complete && def?.aura && (
        <p className="muted small">
          Your units gather {def.aura.resources.join(" and ")} {Math.round(def.aura.pct * 100)}% faster within {def.aura.radius} tiles.
        </p>
      )}
      {def && def.influence > 0 && <p className="muted small">Claims territory within {def.influence} tiles when complete.</p>}
      {mine && b.complete && def && def.trains.length > 0 && (
        <>
          <h3>Train</h3>
          <div className="buttons">
            {def.trains.map((t) => {
              const ud = findUnitDef(t);
              const cost = scaledCost(state, ud?.cost ?? {}, "trainCost");
              if (ud?.requiresCombat && !state.fightingEnabled) return null;
              return (
                <button key={t} onClick={() => actions.train(b.id, t)} disabled={!canAfford(state, cost)} title={ud?.description}>
                  {ud?.name ?? t} ({formatCostText(cost)}, {ud?.trainTime}s)
                </button>
              );
            })}
          </div>
        </>
      )}
      {mine && def && (
        <div className="buttons">
          <ConfirmButton
            label={b.complete ? "Demolish" : "Cancel construction"}
            confirmLabel="Click again to confirm"
            title={
              b.complete
                ? `Remove this building for good: no refund${def.influence > 0 ? ", its territory is released" : ""}${b.own?.storage ? ", and what it holds is lost" : ""}${def.pen ? "; its animals are let out" : ""}`
                : "Remove this construction site: half of its cost is refunded"
            }
            onConfirm={() => void actions.demolish(b.id)}
          />
        </div>
      )}
      {def?.pen && b.own?.paddock && <PaddockBlock buildingId={b.id} />}
      {def?.pen && !mine && <p className="muted small">{[...state.units.values()].filter((u) => u.owner === b.owner && u.x >= b.x && u.x < b.x + b.w && u.y >= b.y && u.y < b.y + b.h).length} animals inside.</p>}
      {mine && b.complete && (b.type === "town_hall" || b.type === "barracks") && <HeroRecruitBlock buildingId={b.id} type={b.type} />}
      {mine && b.complete && b.type === "barracks" && <BattleTraining buildingId={b.id} />}
      {mine && b.complete && def?.research && <ResearchList buildingId={b.id} />}
      {b.own && b.own.queue.length > 0 && (
        <>
          <h3>Queue</h3>
          <ol className="queue">
            {b.own.queue.map((q, i) => (
              <li key={i}>
                {q.kind === "unit"
                  ? (findUnitDef(q.id)?.name ?? q.id)
                  : q.kind === "tech"
                    ? `Research: ${TECH_DEFS[q.id]?.name ?? q.id}`
                    : q.kind === "hero"
                      ? `${q.id === "revive" ? "Reviving" : "Recruiting"} ${heroDefForRace(state.race)?.name ?? "hero"}`
                      : `Battle training: ${HERO_TRAINING[q.id.split(":")[0] as string]?.name ?? q.id} rank ${q.id.split(":")[1]}`}{" "}
                <Bar value={q.progress} max={Math.round(q.total)} color="#4f8fd6" />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
