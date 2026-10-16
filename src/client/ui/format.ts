import { RESOURCE_TYPES, type ResourceBag } from "../../shared/defs/resources.ts";
import type { GameState } from "../state/gameState.ts";

export function formatCostText(cost: Partial<ResourceBag>): string {
  const parts = RESOURCE_TYPES.filter((r) => (cost[r] ?? 0) > 0).map((r) => `${cost[r]} ${r}`);
  return parts.length ? parts.join(", ") : "free";
}

/** Cost after the player's modifiers, computed exactly as the server does (rounded up, min 20%). */
export function scaledCost(state: GameState, cost: Partial<ResourceBag>, stat: "buildingCost" | "trainCost"): Partial<ResourceBag> {
  const f = Math.max(0.2, 1 + state.modifierPct(stat));
  const out: Partial<ResourceBag> = {};
  for (const r of RESOURCE_TYPES) if (cost[r]) out[r] = Math.ceil((cost[r] ?? 0) * f);
  return out;
}

export function canAfford(state: GameState, cost: Partial<ResourceBag>): boolean {
  const p = state.player;
  return !!p && RESOURCE_TYPES.every((r) => p.resources[r] >= (cost[r] ?? 0));
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
