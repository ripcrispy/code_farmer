import { chebyshev, distToRect } from "../shared/coords.ts";
import { RESOURCE_TYPES, bagTotal, isResourceType } from "../shared/defs/resources.ts";
import { FIND_KINDS } from "../shared/defs/units.ts";
import { findAbility, heroDefForType } from "../shared/defs/heroes.ts";
import { ScriptRuntimeError, type ScriptHost } from "../script/vm.ts";
import { DictValue, ListValue, ObjectRef, repr, typeName, type Value } from "../script/values.ts";
import type { UnitState } from "./types.ts";
import type { World } from "./world.ts";


/**
 * The bridge between one unit's VM and the world. Queries return read-only
 * snapshots (ObjectRef) or primitives; nothing here mutates authoritative state
 * except appending to the unit's own log via print().
 */
export class UnitScriptHost implements ScriptHost {
  private readonly world: World;
  private readonly unit: UnitState;
  constructor(world: World, unit: UnitState) {
    this.world = world;
    this.unit = unit;
  }

  query(name: string, args: Value[]): Value {
    const u = this.unit;
    switch (name) {
      case "find_nearest": {
        const kind = args[0];
        if (typeof kind !== "string" || !FIND_KINDS.includes(kind)) {
          throw new ScriptRuntimeError(`find_nearest() kind must be one of ${FIND_KINDS.map((k) => `"${k}"`).join(", ")}; got ${repr(kind ?? null, 1)}`);
        }
        return this.world.findNearest(u, kind);
      }
      case "scan": {
        if (!this.world.mods(u.owner).has("command:scan")) throw new ScriptRuntimeError("scan() is locked. Discover the Surveyor's Lens by investigating ruins");
        const kind = args[0];
        if (typeof kind !== "string" || !FIND_KINDS.includes(kind)) {
          throw new ScriptRuntimeError(`scan() kind must be one of ${FIND_KINDS.map((k) => `"${k}"`).join(", ")}`);
        }
        return new ListValue(this.world.scan(u, kind, 10));
      }
      case "distance_to": {
        if (args.length === 2) {
          const [x, y] = args;
          if (typeof x !== "number" || typeof y !== "number") throw new ScriptRuntimeError("distance_to(x, y) needs two numbers");
          return chebyshev(u.x, u.y, x, y);
        }
        const ref = args[0];
        if (!(ref instanceof ObjectRef)) throw new ScriptRuntimeError(`distance_to() needs an object, got '${typeName(ref ?? null)}'`);
        const b = this.world.buildingFromRef(ref);
        if (b) return distToRect(u.x, u.y, b.x, b.y, b.w, b.h);
        return chebyshev(u.x, u.y, ref.x, ref.y);
      }
      case "exists": {
        const ref = args[0];
        if (ref === null) return false;
        if (!(ref instanceof ObjectRef)) throw new ScriptRuntimeError("exists() needs an object");
        return this.world.refExists(ref);
      }
      case "stock": {
        const r = args[0];
        if (!isResourceType(r)) throw new ScriptRuntimeError(`stock() resource must be "wood", "stone", "gold" or "food"`);
        return this.world.players.get(u.owner)?.resources[r] ?? 0;
      }
      case "stock_all": {
        const d = new DictValue();
        const p = this.world.players.get(u.owner);
        for (const r of RESOURCE_TYPES) d.set(r, p?.resources[r] ?? 0);
        return d;
      }
      case "find_build_spot": {
        const t = args[0];
        if (typeof t !== "string") throw new ScriptRuntimeError("find_build_spot() needs a building type such as \"stockpile\"");
        const spot = this.world.findBuildSpot(u, t);
        return spot ? new ListValue([spot.x, spot.y]) : null;
      }
      case "count_units": {
        const t = args[0];
        if (t !== undefined && typeof t !== "string") throw new ScriptRuntimeError("count_units() type must be a string");
        let n = 0;
        for (const id of this.world.unitsOf(u.owner)) {
          const other = this.world.units.get(id);
          if (other && (t === undefined || other.type === t)) n++;
        }
        for (const id of this.world.buildingsOf(u.owner)) {
          for (const q of this.world.buildings.get(id)?.queue ?? []) if (q.kind === "unit" && (t === undefined || q.unitType === t)) n++;
        }
        return n;
      }
      case "ability_ready": {
        const name = args[0];
        if (typeof name !== "string") throw new ScriptRuntimeError('ability_ready() needs an ability name such as "rally"');
        const hd = heroDefForType(u.type);
        const ab = hd ? findAbility(hd, name) : undefined;
        if (!ab || (ab.combat && !this.world.fightingEnabled)) return false;
        return this.world.abilityReadyIn(u, name) === 0;
      }
      case "hero": {
        const h = this.world.heroOf(u.owner);
        return h ? this.world.unitRef(h) : null;
      }
      case "last_attacker": {
        const a = this.world.lastAttacker(u);
        return a ? this.world.unitRef(a) : null;
      }
      case "can_attack": {
        const ref = args[0];
        if (ref === null || ref === undefined) return false;
        if (!(ref instanceof ObjectRef)) throw new ScriptRuntimeError("can_attack() needs an object");
        const b = this.world.buildingFromRef(ref);
        if (b) return this.world.buildingAttackBlocker(u, b) === null;
        const t = this.world.unitFromRef(ref);
        return t ? this.world.attackBlocker(u, t) === null : false;
      }
      case "in_contested_zone": {
        if (args.length === 2) {
          const [x, y] = args;
          if (typeof x !== "number" || typeof y !== "number") throw new ScriptRuntimeError("in_contested_zone(x, y) needs two numbers");
          return this.world.contestedZoneAt(Math.round(x), Math.round(y)) !== null;
        }
        const ref = args[0];
        if (ref === undefined) return this.world.contestedZoneAt(u.x, u.y) !== null;
        if (!(ref instanceof ObjectRef)) throw new ScriptRuntimeError("in_contested_zone() needs an object or x, y");
        const b = this.world.buildingFromRef(ref);
        if (b) return this.world.buildingZone(b) !== null;
        return this.world.contestedZoneAt(ref.x, ref.y) !== null;
      }
      case "storage_contents": {
        const ref = args[0];
        const b = ref instanceof ObjectRef ? this.world.buildingFromRef(ref) : undefined;
        if (!b || b.owner !== u.owner) throw new ScriptRuntimeError("storage_contents() needs one of your storage buildings");
        const d = new DictValue();
        for (const r of RESOURCE_TYPES) d.set(r, b.stock[r]);
        const cap = this.world.storageCapacityOf(b);
        d.set("capacity", Number.isFinite(cap) ? cap : -1);
        d.set("free", Number.isFinite(cap) ? this.world.storageFree(b) : -1);
        return d;
      }
      case "storage_mode":
        return this.world.cfg.storageMode;
      case "distance_to_home":
        return u.home ? Math.max(Math.abs(u.home.x - u.x), Math.abs(u.home.y - u.y)) : 0;
      case "time":
        return Math.round((this.world.tick / this.world.cfg.tickRate) * 10) / 10;
      case "print":
        this.world.appendLog(u, args.map((a) => repr(a)).join(" "));
        this.world.lessonEvent(u, { kind: "print" });
        return null;
      case "inventory.is_full":
        return bagTotal(u.inventory) >= this.world.capacity(u);
      case "inventory.is_empty":
        return bagTotal(u.inventory) === 0;
      case "inventory.total":
        return bagTotal(u.inventory);
      case "inventory.capacity":
        return this.world.capacity(u);
      case "inventory.free":
        return this.world.capacity(u) - bagTotal(u.inventory);
      case "inventory.count": {
        const r = args[0];
        if (!isResourceType(r)) throw new ScriptRuntimeError(`inventory.count() resource must be "wood", "stone", "gold" or "food"`);
        return u.inventory[r];
      }
      default:
        throw new ScriptRuntimeError(`Unknown command ${name}`);
    }
  }

  namespaceValue(ns: string, attr: string): Value | undefined {
    if (ns !== "me") return undefined;
    const u = this.unit;
    switch (attr) {
      case "x":
        return u.x;
      case "y":
        return u.y;
      case "id":
        return u.id;
      case "type":
        return u.type;
      case "hp":
        return u.hp;
      case "max_hp":
        return this.world.unitMaxHp(u);
      default:
        return undefined;
    }
  }

  validateAction(name: string, args: Value[]): void {
    const isRef = (v: Value | undefined): boolean => v instanceof ObjectRef;
    switch (name) {
      case "move_to":
        if (args.length === 2) {
          if (typeof args[0] !== "number" || typeof args[1] !== "number") throw new ScriptRuntimeError("move_to(x, y) needs two numbers");
        } else if (!isRef(args[0])) {
          throw new ScriptRuntimeError(args[0] === null ? "move_to() got None - the target was not found" : "move_to() needs an object or x, y");
        }
        return;
      case "harvest":
      case "build":
        if (!isRef(args[0])) throw new ScriptRuntimeError(args[0] === null ? `${name}() got None - check the result of find_nearest() first` : `${name}() needs an object from find_nearest()`);
        return;
      case "deposit":
        if (args.length === 1 && !isRef(args[0])) throw new ScriptRuntimeError("deposit() target must be a storage building");
        return;
      case "wait":
        if (args.length === 1 && typeof args[0] !== "number") throw new ScriptRuntimeError("wait() needs a number of seconds");
        return;
      case "place":
        if (typeof args[0] !== "string") throw new ScriptRuntimeError('place() needs a building type such as "stockpile" first');
        if (args.length === 2 && !(args[1] instanceof ListValue)) {
          throw new ScriptRuntimeError(args[1] === null ? "place() got None - find_build_spot() found no spot" : "place(type, spot) needs a [x, y] list");
        }
        return;
      case "train_unit":
        if (typeof args[0] !== "string") throw new ScriptRuntimeError('train_unit() needs a unit type such as "worker"');
        return;
      case "attack":
      case "repair":
      case "flee":
      case "observe":
      case "tame":
      case "investigate":
      case "follow":
      case "pen":
        if (!(args[0] instanceof ObjectRef)) throw new ScriptRuntimeError(args[0] === null ? `${name}() got None - check the result of find_nearest() first` : `${name}() needs an object from find_nearest()`);
        if (name === "follow" && args.length > 1 && typeof args[1] !== "number") throw new ScriptRuntimeError("follow() seconds must be a number");
        return;
      case "train_creature":
        if (!(args[0] instanceof ObjectRef)) throw new ScriptRuntimeError("train_creature() needs one of your creatures");
        if (typeof args[1] !== "string") throw new ScriptRuntimeError('train_creature() needs an ability name such as "guard"');
        return;
      case "guard":
        if (typeof args[0] !== "number" || typeof args[1] !== "number") throw new ScriptRuntimeError("guard(x, y) needs two numbers");
        if (args.length > 2 && typeof args[2] !== "number") throw new ScriptRuntimeError("guard() seconds must be a number");
        return;
      case "wander":
        if (args.length > 0 && typeof args[0] !== "number") throw new ScriptRuntimeError("wander() radius must be a number");
        return;
      case "use_ability":
        if (typeof args[0] !== "string") throw new ScriptRuntimeError('use_ability() needs an ability name such as "rally"');
        if (args.length === 2 && !(args[1] instanceof ObjectRef)) throw new ScriptRuntimeError(args[1] === null ? "use_ability() target is None - check it first" : "use_ability(name, target) needs a unit object");
        if (args.length === 3 && (typeof args[1] !== "number" || typeof args[2] !== "number")) throw new ScriptRuntimeError("use_ability(name, x, y) needs two numbers");
        return;
      case "withdraw":
        if (!isResourceType(args[0])) throw new ScriptRuntimeError('withdraw() resource must be "wood", "stone", "gold" or "food"');
        if (args.length >= 2 && (typeof args[1] !== "number" || args[1] < 1)) throw new ScriptRuntimeError("withdraw() amount must be a positive number");
        if (args.length === 3 && !(args[2] instanceof ObjectRef)) throw new ScriptRuntimeError("withdraw() storage must be a storage building object");
        return;
      default:
        return;
    }
  }
}
