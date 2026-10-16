import { useState, type JSX } from "react";
import { BuildMenu } from "./BuildMenu.tsx";
import { CodeEditor } from "./CodeEditor.tsx";
import { Help } from "./Help.tsx";
import { HoverInfo } from "./HoverInfo.tsx";
import { Minimap } from "./Minimap.tsx";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { StatsPanel } from "./StatsPanel.tsx";
import { LessonsPanel } from "./LessonsPanel.tsx";
import { TalentsPanel } from "./TalentsPanel.tsx";
import { Notifications } from "./Notifications.tsx";
import { PerfOverlay } from "./PerfOverlay.tsx";
import { SelectionPanel } from "./SelectionPanel.tsx";
import { TopBar } from "./TopBar.tsx";
import { WorldCanvas } from "./WorldCanvas.tsx";
import { useGame, useUiVersion } from "./context.ts";

export function GameView(): JSX.Element {
  useUiVersion();
  const { state } = useGame();
  const [help, setHelp] = useState(false);
  return (
    <div className="game">
      <TopBar onHelp={() => setHelp(true)} />
      <div className="main">
        <WorldCanvas />
        <aside className="sidebar">
          <SelectionPanel />
          <BuildMenu />
        </aside>
        <HoverInfo />
        <Minimap />
        <Notifications />
        <PerfOverlay />
        {state.placing && (
          <div className="placing-hint">
            Placing {state.placing}: left-click to place · right-click / Esc to cancel
            {state.contestedZones ? " · a red outline means a contested zone: any player may attack it there" : ""}
          </div>
        )}
      </div>
      {state.editorUnitId !== null && <CodeEditor key={state.editorUnitId} unitId={state.editorUnitId} />}
      {state.libraryOpen && <LibraryPanel />}
      {state.statsOpen && <StatsPanel />}
      {state.lessonsOpen && <LessonsPanel />}
      {state.talentsOpen && <TalentsPanel />}
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
