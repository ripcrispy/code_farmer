import type { JSX } from "react";
import { NODE_DEFS, isNodeKind } from "../../shared/defs/resources.ts";
import { terrainDef } from "../../shared/defs/terrain.ts";
import { findBuildingDef } from "../../shared/defs/buildings.ts";
import { useGame, useHover } from "./context.ts";
import { findLairDef } from "../../shared/defs/lairs.ts";
import type { LairView } from "../../shared/protocol.ts";

/** "occupied", "cleared by X (yours for 12 min; reoccupied in 40 min)", ... */
export function lairStatusText(l: LairView & { at: number }): string {
  const ago = (performance.now() - l.at) / 1000;
  const mins = (s: number): string => `${Math.max(1, Math.ceil((s - ago) / 60))} min`;
  if (l.status === "dormant") return "monsters lurk here";
  if (l.status === "active") return "occupied by monsters";
  const parts = [`cleared by ${l.clearedBy ?? "someone"}`];
  if (l.claimIn !== undefined && l.claimIn - ago > 0) parts.push(l.yourClaim ? `yours to claim for ${mins(l.claimIn)} (build an Outpost in it)` : `reserved for ${mins(l.claimIn)}`);
  if (l.respawnIn === null) parts.push("claimed land: it stays clear");
  else if (l.respawnIn !== undefined) parts.push(l.respawnIn - ago > 0 ? `reoccupied in ${mins(l.respawnIn)}` : "monsters returning");
  return parts.join("; ");
}

export function HoverInfo(): JSX.Element | null {
  const hover = useHover();
  const { state } = useGame();
  const t = state.terrainAt(hover.x, hover.y);
  if (t === undefined) return <div className="hoverinfo">{hover.x}, {hover.y} · unexplored</div>;
  const node = state.nodeAt(hover.x, hover.y);
  const b = state.buildingAt(hover.x, hover.y);
  const u = state.unitAt(hover.x, hover.y);
  const ruin = state.ruinAt(hover.x, hover.y);
  const zone = state.zoneAt(hover.x, hover.y);
  const lair = state.lairAt(hover.x, hover.y);
  const ld = lair ? findLairDef(lair.kind) : undefined;
  return (
    <div className="hoverinfo">
      {hover.x}, {hover.y} · {terrainDef(t).name}
      {node && isNodeKind(node.kind) ? ` · ${NODE_DEFS[node.kind].label} (${node.amount} ${NODE_DEFS[node.kind].yields})` : ""}
      {b ? ` · ${findBuildingDef(b.type)?.name ?? b.type} (${b.owner === state.playerId ? "yours" : state.ownerName(b.owner)}${b.owner !== state.playerId && state.ownerPvp(b.owner) ? ", PvP" : ""})${b.complete && b.hp < b.maxHp ? ` ${b.hp}/${b.maxHp} HP` : ""}` : ""}
      {zone ? " · ⚔ Contested zone: PvP for everyone, +50% gathering" : ""}
      {lair && ld ? ` · ☠ ${ld.name} (tier ${ld.tier}): ${lairStatusText(lair)}` : ""}
      {ruin ? ` · ${ruin.tier === "ancient" ? "Ancient ruins" : "Ruins"}${ruin.looted ? " (salvaged)" : ""}` : ""}
      {u ? ` · ${u.type} #${u.id} (${u.owner === state.playerId ? "yours" : state.ownerName(u.owner)}${u.owner !== state.playerId && state.ownerPvp(u.owner) ? ", PvP" : ""})${u.hpPct < 100 ? ` ${u.hpPct}%` : ""}` : ""}
    </div>
  );
}
