import { createContext, useContext, useSyncExternalStore } from "react";
import type { Actions } from "../actions.ts";
import type { GameState } from "../state/gameState.ts";

export interface GameContextValue {
  state: GameState;
  actions: Actions;
  hover: HoverStore;
  logout: () => void;
}

export const GameContext = createContext<GameContextValue | null>(null);

export function useGame(): GameContextValue {
  const g = useContext(GameContext);
  if (!g) throw new Error("useGame must be used inside GameContext");
  return g;
}

/** Re-render when UI-relevant state changes (not on every unit movement). */
export function useUiVersion(): number {
  const { state } = useGame();
  return useSyncExternalStore(state.subscribe, state.getVersion);
}

/** Tiny store for the hovered tile so mouse movement only re-renders the hover readout. */
export class HoverStore {
  x = 0;
  y = 0;
  version = 0;
  private listeners = new Set<() => void>();
  set(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.version++;
    for (const l of this.listeners) l();
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;
}

export function useHover(): HoverStore {
  const { hover } = useGame();
  useSyncExternalStore(hover.subscribe, hover.getVersion);
  return hover;
}
