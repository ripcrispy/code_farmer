import { useMemo } from "react";
import { BUILDING_DEFS } from "../../shared/defs/buildings.ts";
import { heroDefForRace } from "../../shared/defs/heroes.ts";
import type { AssistContext } from "../../script/assist.ts";
import type { GameState } from "../state/gameState.ts";
import { missingRequirement } from "./BuildMenu.tsx";

/** What the editor's assistant knows: the unit, the player's unlocks, combat, hero abilities, buildable types. */
export function assistContextFor(state: GameState, unitType: string | null): AssistContext {
  const buildable = new Set(Object.values(BUILDING_DEFS).filter((d) => d.placeable && (!d.requires?.combat || state.combatEnabled) && missingRequirement(state, d) === null).map((d) => d.type));
  return {
    unitType,
    unlocks: new Set(state.player?.unlocks ?? []),
    combatEnabled: state.combatEnabled,
    pveEnabled: state.pveEnabled,
    heroAbilities: heroDefForRace(state.race)?.abilities ?? [],
    buildable,
  };
}

/** Memoised on the inputs that change suggestions, so the editor is not re-linted on every tick. */
export function useAssistContext(state: GameState, unitType: string | null): AssistContext {
  const unlockKey = (state.player?.unlocks ?? []).join(",");
  const techKey = (state.player?.techs ?? []).join(",");
  const buildingKey = [...state.buildings.values()].filter((b) => b.owner === state.playerId && b.complete).map((b) => b.type).sort().join(",");
  return useMemo(
    () => assistContextFor(state, unitType),
    [state, unitType, unlockKey, techKey, buildingKey, state.combatEnabled, state.pveEnabled, state.race],
  );
}
