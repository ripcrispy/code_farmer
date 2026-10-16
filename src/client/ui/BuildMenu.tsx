import type { JSX } from "react";
import { BALANCE } from "../../shared/defs/balance.ts";
import { BUILDING_DEFS, findBuildingDef, type BuildingDef } from "../../shared/defs/buildings.ts";
import { TECH_DEFS } from "../../shared/defs/techs.ts";
import { DISCOVERY_DEFS } from "../../shared/defs/discoveries.ts";
import type { GameState } from "../state/gameState.ts";
import { canAfford, formatCostText, scaledCost } from "./format.ts";
import { useGame, useUiVersion } from "./context.ts";

/** Client-side mirror of the server's prerequisite check, for display only (the server decides). */
export function missingRequirement(state: GameState, def: BuildingDef): string | null {
  const req = def.requires;
  if (!req) return null;
  for (const t of req.buildings ?? []) {
    const has = [...state.buildings.values()].some((b) => b.owner === state.playerId && b.type === t && b.complete);
    if (!has) return `Needs a completed ${findBuildingDef(t)?.name ?? t}`;
  }
  for (const t of req.techs ?? []) if (!state.player?.techs.includes(t)) return `Needs research: ${TECH_DEFS[t]?.name ?? t}`;
  if (req.unlock && !state.player?.unlocks.includes(req.unlock)) {
    const tech = Object.values(TECH_DEFS).find((t) => t.effects.some((e) => "unlock" in e && e.unlock === req.unlock));
    if (tech) return `Needs research: ${tech.name}`;
    const disc = Object.values(DISCOVERY_DEFS).find((d) => d.effects.some((e) => "unlock" in e && e.unlock === req.unlock));
    return disc ? `Discover the ${disc.name} (${disc.source.toLowerCase()})` : "Locked";
  }
  return null;
}

export function BuildMenu(): JSX.Element {
  useUiVersion();
  const { state } = useGame();
  // Military buildings only exist on servers with combat enabled.
  const defs = Object.values(BUILDING_DEFS).filter((d) => d.placeable && (!d.requires?.combat || state.combatEnabled));
  return (
    <section className="panel">
      <h2>Construction</h2>
      {state.storageMode === "networks" && <p className="muted small">Paid from storage within {BALANCE.supplyRange} tiles of the site.</p>}
      <div className="buttons column">
        {defs.map((d) => {
          const cost = scaledCost(state, d.cost, "buildingCost");
          const missing = missingRequirement(state, d);
          const affordable = canAfford(state, cost);
          const active = state.placing === d.type;
          return (
            <button
              key={d.type}
              className={`build-btn ${active ? "primary" : ""}`}
              disabled={(!affordable || !!missing) && !active}
              title={`${d.description} ${d.width}×${d.height}, ${d.buildTime} build-seconds.${d.expansion ? " Can be placed up to " + BALANCE.expansionRange + " tiles outside your territory." : ""}`}
              onClick={() => {
                if (active) state.setPlacing(null);
                else {
                  state.setPlacing(d.type);
                  state.notify("info", `Placing ${d.name}: left-click the map to place, right-click or Esc to cancel.`);
                }
              }}
            >
              <span>{d.name} — {formatCostText(cost)}</span>
              {missing && <span className="muted small block">{missing}</span>}
            </button>
          );
        })}
      </div>
      <p className="muted small">
        Most buildings must be placed inside your territory (shaded; T toggles the overlay). Outposts and Town Halls can be placed on unclaimed land within{" "}
        {BALANCE.expansionRange} tiles of it and claim new territory when finished. The cost is paid when the site is placed; a unit must then build it.
      </p>
    </section>
  );
}
