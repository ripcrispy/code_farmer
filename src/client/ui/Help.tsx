import type { JSX } from "react";

export function Help({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="editor-backdrop" role="dialog" aria-label="Help" onClick={onClose}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <h2>How to play</h2>
        <p>
          You start with a Town Hall and three units running default programs. Open a unit's code to change what it does, gather resources,
          build inside your territory, expand it with Outposts, research at a Library, and level up to earn talents. Investigate ruins and study
          wildlife to make discoveries that unlock new commands and buildings.
        </p>
        <h3>Controls</h3>
        <ul>
          <li><b>Left-click</b>: select a unit, creature or building · <b>left-drag</b>: pan · <b>Shift+click / Shift+drag</b>: select several units</li>
          <li><b>Right-click</b> with your unit selected: gather a resource, build your construction site, deposit at your storage, investigate a ruin, observe (or, once observed, tame) a wild animal, or move</li>
          <li><b>WASD / arrow keys</b>: pan · <b>mouse wheel / + -</b>: zoom</li>
          <li><b>Tab</b> / <b>Shift+Tab</b>: cycle your units · <b>Space</b>: center on selection · <b>H</b>: go home · <b>Y</b>: select your hero · <b>T</b>: territory overlay</li>
          <li><b>Hero:</b> recruit your race's hero once at your Town Hall (free). Select it to use its abilities (buttons, or <code>use_ability("name")</code> in its program); abilities aimed at a unit or a spot ask you to click the target. Improve it with battle training at a Barracks and hero research at a Library. A fallen hero is revived at a Town Hall or Barracks and keeps its training. Abilities marked ⚔ need combat on the server.</li>
          <li><b>Limits:</b> research Administration, Bureaucracy and Grand Council at a Library to raise your unit and building limits.</li>
          <li><b>Storage networks</b> (only if the server enables them): resources stay in the storage building that received them. Costs are paid from storage within 48 tiles of the work; storage buildings within 24 tiles of each other share their contents. Haul resources between bases with <code>withdraw(resource, amount, storage)</code> and <code>deposit(storage)</code>. Select a storage building to see what it holds.</li>
          <li><b>Minimap</b> (top left): click to move the camera; + / − zoom</li>
          <li><b>Combat</b> (only if the server enables it): opt in with the <b>⚔ PvP</b> button. Right-click an opted-in player's unit or building to attack it; <b>Ctrl+right-click</b> an animal to hunt it; right-click your own damaged building to repair it. Opting out takes effect after a delay. Inside the red <b>contested zones</b> PvP is always on (and gathering is faster). Scouts are hidden from other players unless they come close.</li>
          <li><b>Monster lairs</b> (☠, red-rimmed circles, at least 120 tiles from the world's centre): goblin camps, spider nests, bone crypts, ogre dens and drake roosts. Their monsters attack anyone who walks in but never chase far. Right-click a monster to attack it (PvE works even when PvP combat is off). Kills give resources and experience; a boss also gives its lair's loot, a <b>trophy</b> (permanent bonus) and a discovery. Clear every monster and for an hour only you may build there: an Outpost in it claims the lair, even far from your land. An unclaimed lair is reoccupied later. Bring Knights, Soldiers, Archers, a Cleric (heals) and your hero.</li>
          <li><b>Paddocks</b>: tame animals (observe first; Rangers tame for half the food) and they walk into your nearest Paddock with room, or select one and right-click the Paddock. Sheep, goats, aurochs and boars give food (sheep also gold); horses, aurochs, goats, bears and wolves give settlement-wide bonuses; pairs raise young while there is room. Select the Paddock to see and release its animals.</li>
          <li><b>F3</b>: performance overlay (frame rate, where frame time goes, slow frames).</li>
          <li><b>Esc</b>: cancel placement / deselect / close editor</li>
          <li>Editor: <b>Ctrl+S</b> save, <b>Ctrl+Enter</b> save &amp; run, <b>Ctrl+Space</b> suggestions, <b>Tab</b> accepts a suggestion or indents. Hover a command for help; problems have <b>Fix</b> buttons; the <b>Recipes</b> tab has ready-made code; the green line is what the unit is doing now.</li>
          <li><b>Lessons</b> (top bar): learn to code one idea at a time and earn experience.</li>
        </ul>
        <h3>Not yet implemented</h3>
        <p className="muted">Tree regrowth and more event handlers are planned (see docs/ROADMAP.md).</p>
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
