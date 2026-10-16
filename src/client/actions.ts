import { findBuildingDef } from "../shared/defs/buildings.ts";
import { NODE_DEFS, isNodeKind } from "../shared/defs/resources.ts";
import { NEUTRAL_OWNER, type ServerMessage } from "../shared/protocol.ts";
import { findUnitDef } from "../shared/defs/units.ts";
import type { GameConnection } from "./net/connection.ts";
import type { GameState } from "./state/gameState.ts";

/**
 * Player intents -> server requests. Every result shown to the player comes from
 * the server's reply (ack or error); nothing is applied optimistically.
 */
export class Actions {
  private readonly conn: GameConnection;
  private readonly state: GameState;
  constructor(conn: GameConnection, state: GameState) {
    this.conn = conn;
    this.state = state;
  }

  private async req(msg: Record<string, unknown> & { t: string }, success?: string): Promise<ServerMessage> {
    const r = await this.conn.request(msg);
    if (r.t === "error") this.state.notify("error", r.message);
    else if (success !== undefined || (r.t === "ack" && r.message)) this.state.notify("success", success ?? (r.t === "ack" ? (r.message ?? "") : ""));
    return r;
  }

  penAnimal(unitId: number, buildingId: number): void {
    void this.req({ t: "unit_cmd", unitId, cmd: { kind: "pen", buildingId } }, "Heading for the paddock");
  }

  releaseAnimal(buildingId: number, unitId: number): void {
    void this.req({ t: "paddock_release", buildingId, unitId });
  }

  subscribe(chunks: [number, number][]): void {
    this.conn.send({ t: "subscribe", chunks });
  }

  /** Left click: select a unit or building at the tile, or clear the selection. */
  clickTile(x: number, y: number): void {
    const s = this.state;
    const u = s.unitAt(x, y);
    if (u) return s.select({ kind: "unit", id: u.id });
    const b = s.buildingAt(x, y);
    if (b) return s.select({ kind: "building", id: b.id });
    s.select(null);
  }

  /**
   * Right click with an own unit selected: context command (gather / build / deposit / move,
   * investigate, observe/tame, attack enemies, repair). `force` (Ctrl) attacks whatever is there,
   * which is how you hunt animals instead of observing them.
   */
  commandTile(x: number, y: number, force = false): void {
    const s = this.state;
    const sel = s.selection;
    if (sel?.kind !== "unit") return;
    const u = s.units.get(sel.id);
    if (!u || u.owner !== s.playerId) {
      s.notify("error", "Select one of your own units to give orders");
      return;
    }
    const target = s.unitAt(x, y);
    const combat = s.combatEnabled;
    // Lair monsters: a right-click attacks (PvE works even with combat off).
    if (target && target.owner === NEUTRAL_OWNER && findUnitDef(target.type)?.monster && s.fightingEnabled) {
      void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "attack", targetId: target.id } }, `Attacking the ${findUnitDef(target.type)?.name ?? target.type}`);
      return;
    }
    const myPvp = s.player?.combat.active ?? false;
    if (combat && target && target.owner !== s.playerId) {
      const hunt = force && target.owner === NEUTRAL_OWNER;
      const pvp = target.owner !== NEUTRAL_OWNER && (force || (myPvp && s.ownerPvp(target.owner)));
      if (hunt || pvp) {
        void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "attack", targetId: target.id } }, `Attacking ${s.ownerName(target.owner)}'s ${target.type}`);
        return;
      }
    }
    const tb = s.buildingAt(x, y);
    if (combat && tb && tb.owner !== s.playerId && (force || (myPvp && s.ownerPvp(tb.owner)))) {
      void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "attack_building", buildingId: tb.id } }, `Attacking ${s.ownerName(tb.owner)}'s ${findBuildingDef(tb.type)?.name ?? tb.type}`);
      return;
    }
    // A tamed animal sent to one of your paddocks.
    if (tb && tb.owner === s.playerId && findBuildingDef(tb.type)?.pen && findUnitDef(u.type)?.creature?.paddock) {
      void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "pen", buildingId: tb.id } }, "Heading for the paddock");
      return;
    }
    if (tb && tb.owner === s.playerId && tb.complete && tb.hp < tb.maxHp && !(u.carrying && findBuildingDef(tb.type)?.storage)) {
      void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "repair", buildingId: tb.id } }, `Repairing ${findBuildingDef(tb.type)?.name ?? tb.type}`);
      return;
    }
    if (target && target.owner === NEUTRAL_OWNER && findUnitDef(target.type)?.creature) {
      // Observe first; once the species is known, a right-click tames (the server checks food and skills).
      const known = s.player?.observed.includes(target.type) ?? false;
      const kind = known ? "tame" : "observe";
      void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind, targetId: target.id } }, known ? `Taming the ${target.type}` : `Observing the ${target.type}`);
      return;
    }
    const ruin = s.ruinAt(x, y);
    if (ruin) {
      void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "investigate", x, y } }, ruin.looted ? "Investigating (already salvaged; inscriptions may remain)" : "Investigating the ruins");
      return;
    }
    const node = s.nodeAt(x, y);
    if (node && isNodeKind(node.kind)) {
      void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "gather", x, y } }, `Gathering ${NODE_DEFS[node.kind].yields}`);
      return;
    }
    const b = s.buildingAt(x, y);
    if (b && b.owner === s.playerId) {
      if (!b.complete) {
        void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "build", buildingId: b.id } }, "Building");
        return;
      }
      if (findBuildingDef(b.type)?.storage && u.carrying) {
        void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "deposit" } }, "Depositing cargo");
        return;
      }
    }
    void this.req({ t: "unit_cmd", unitId: u.id, cmd: { kind: "move", x, y } });
  }

  stopUnit(unitId: number): void {
    void this.req({ t: "unit_cmd", unitId, cmd: { kind: "stop" } }, "Stopped");
  }

  async dismissUnits(unitIds: number[]): Promise<void> {
    const r = await this.req({ t: "unit_dismiss", unitIds });
    if (r.t === "ack") this.state.select(null);
  }

  async demolish(buildingId: number): Promise<void> {
    const r = await this.req({ t: "building_demolish", buildingId });
    if (r.t === "ack") this.state.select(null);
  }

  depositUnit(unitId: number): void {
    void this.req({ t: "unit_cmd", unitId, cmd: { kind: "deposit" } });
  }

  async place(type: string, x: number, y: number): Promise<void> {
    const r = await this.req({ t: "place_building", type, x, y });
    if (r.t === "ack") {
      this.state.setPlacing(null);
      if (r.id) this.state.select({ kind: "building", id: r.id });
    }
  }

  train(buildingId: number, unitType: string): void {
    void this.req({ t: "train", buildingId, unitType });
  }

  research(buildingId: number, techId: string): void {
    void this.req({ t: "research", buildingId, techId });
  }

  recruitHero(buildingId: number): void {
    void this.req({ t: "hero_recruit", buildingId });
  }

  trainHero(buildingId: number, track: string): void {
    void this.req({ t: "hero_train", buildingId, track });
  }

  useAbility(unitId: number, ability: string, target: { unitId: number } | { x: number; y: number } | null = null): void {
    void this.req({ t: "ability", unitId, ability, target });
  }

  allocateTalent(talentId: string): Promise<ServerMessage> {
    return this.req({ t: "talent_allocate", talentId });
  }

  resetTalents(): Promise<ServerMessage> {
    return this.req({ t: "talent_reset" });
  }

  inspectSpecies(type: string): Promise<ServerMessage> {
    return this.conn.request({ t: "inspect_species", type });
  }

  overview(cx: number, cy: number, radius: number): Promise<ServerMessage> {
    return this.conn.request({ t: "overview_get", cx, cy, radius });
  }

  setPvp(enabled: boolean): Promise<ServerMessage> {
    return this.req({ t: "combat_optin", enabled });
  }

  stats(): Promise<ServerMessage> {
    return this.conn.request({ t: "stats_get" });
  }

  getProgram(unitId: number): Promise<ServerMessage> {
    return this.conn.request({ t: "program_get", unitId });
  }

  saveProgram(unitId: number, source: string, run: boolean): Promise<ServerMessage> {
    return this.req({ t: "program_save", unitId, source, run });
  }

  controlProgram(unitId: number, action: "run" | "pause" | "resume" | "stop"): Promise<ServerMessage> {
    return this.req({ t: "program_control", unitId, action });
  }

  restoreProgram(unitId: number, version: number): Promise<ServerMessage> {
    return this.req({ t: "program_restore", unitId, version });
  }

  unitsControl(unitIds: number[], action: "run" | "pause" | "resume" | "stop"): Promise<ServerMessage> {
    return this.req({ t: "units_control", unitIds, action });
  }

  // ---- code library (list/get are quiet; changes report through notifications) ----
  libList(): Promise<ServerMessage> {
    return this.conn.request({ t: "lib_list" });
  }
  libGet(programId: number, version?: number): Promise<ServerMessage> {
    return this.conn.request(version === undefined ? { t: "lib_get", programId } : { t: "lib_get", programId, version });
  }
  libSave(p: { programId?: number; name: string; description: string; unitTypes: string[]; shared: boolean; source: string }): Promise<ServerMessage> {
    return this.req({ t: "lib_save", ...p });
  }
  libDelete(programId: number): Promise<ServerMessage> {
    return this.req({ t: "lib_delete", programId });
  }
  libCopy(programId: number): Promise<ServerMessage> {
    return this.req({ t: "lib_copy", programId });
  }
  libAssign(p: { programId: number; version?: number; unitIds?: number[]; unitType?: string; run: boolean }): Promise<ServerMessage> {
    return this.req({ t: "lib_assign", ...p });
  }
  libExport(programId: number, version?: number): Promise<ServerMessage> {
    return this.req(version === undefined ? { t: "lib_export", programId } : { t: "lib_export", programId, version }, "Exported");
  }
  libImport(text: string): Promise<ServerMessage> {
    return this.req({ t: "lib_import", text });
  }

  /** Shift+click: add or remove one of your units from a multi-selection. */
  toggleUnit(x: number, y: number): void {
    const s = this.state;
    const u = s.unitAt(x, y);
    if (!u || u.owner !== s.playerId) return;
    const ids = s.selectedUnitIds();
    const next = ids.includes(u.id) ? ids.filter((i) => i !== u.id) : [...ids, u.id];
    s.selectUnits(next);
  }
}
