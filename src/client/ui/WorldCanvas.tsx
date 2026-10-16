import { Application, useApplication } from "@pixi/react";
import { memo, useEffect, useRef } from "react";
import { WorldRenderer } from "../render/worldRenderer.ts";
import { useGame } from "./context.ts";

/** Mounts the imperative WorldRenderer once the Pixi application exists. */
function RendererHost(): null {
  const { app } = useApplication();
  const { state, actions, hover } = useGame();
  useEffect(() => {
    if (!app) return;
    let renderer: WorldRenderer | null = null;
    let raf = 0;
    const attach = (): void => {
      // Wait until the application has finished initialising (renderer + canvas exist).
      if (!(app as { renderer?: unknown }).renderer) {
        raf = requestAnimationFrame(attach);
        return;
      }
      renderer = new WorldRenderer(app, state, {
        onClick: (x, y, shift) => (shift ? actions.toggleUnit(x, y) : actions.clickTile(x, y)),
        onSelectUnits: (ids) => state.selectUnits(ids),
        onAbilityTarget: (target) => {
          const aim = state.targeting;
          if (aim) actions.useAbility(aim.unitId, aim.ability, target);
        },
        onCommand: (x, y, force) => actions.commandTile(x, y, force),
        onPlace: (type, x, y) => void actions.place(type, x, y),
        onVisibleChunks: (chunks) => actions.subscribe(chunks),
        onHover: (x, y) => hover.set(x, y),
      });
      rendererRef.current = renderer;
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      renderer?.destroy();
      rendererRef.current = null;
    };
  }, [app, state, actions, hover]);
  return null;
}

/** Shared handle so other components (e.g. "center on unit") can reach the renderer. */
export const rendererRef: { current: WorldRenderer | null } = { current: null };

export const WorldCanvas = memo(function WorldCanvas() {
  const parent = useRef<HTMLDivElement>(null);
  return (
    <div className="world" ref={parent}>
      <Application resizeTo={parent} background="#0b0d10" antialias={false} autoDensity resolution={Math.min(2, window.devicePixelRatio || 1)}>
        <RendererHost />
      </Application>
    </div>
  );
});
