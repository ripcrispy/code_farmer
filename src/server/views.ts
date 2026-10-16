import { chunkKey, floorDiv } from "../shared/coords.ts";
import { buildingDef } from "../shared/defs/buildings.ts";
import { NODE_DEFS, bagTotal } from "../shared/defs/resources.ts";
import { unitDef } from "../shared/defs/units.ts";
import { LEVEL_THRESHOLDS, MAX_LEVEL } from "../shared/defs/progression.ts";
import { heroDefForRace, heroDefForType } from "../shared/defs/heroes.ts";
import type { Lair } from "../shared/lairs.ts";
import type { ResourceBag } from "../shared/defs/resources.ts";
import { encodeTiles, type LairView, type BuffView, type RuinTuple, type BuildingView, type NodeTuple, type PlayerView, type ServerMessage, type UnitView } from "../shared/protocol.ts";
import type { Buff, BuildingState, PlayerState, UnitState } from "../sim/types.ts";
import type { World } from "../sim/world.ts";

/**
 * Server-side view filtering. Other players only ever receive the public fields of
 * a unit or building; inventories, programs, logs and queues are sent to the owner only.
 */

function buffViews(world: World, buffs: Buff[]): BuffView[] {
  return buffs.filter((b) => b.until > world.tick).map((b) => ({ stat: b.stat, pct: b.pct, seconds: Math.ceil((b.until - world.tick) / world.cfg.tickRate), source: b.source }));
}

export function describeTask(world: World, u: UnitState): { task: string; target: string } {
  const t = u.task;
  if (u.pen !== null) return { task: "In the paddock", target: `Paddock #${u.pen}` };
  switch (t.kind) {
    case "idle":
      return { task: "Idle", target: "" };
    case "move":
      return { task: t.label === "explore" ? "Exploring" : "Moving", target: `${t.goal.x},${t.goal.y}` };
    case "gather": {
      const n = world.chunks.nodeAt(t.nodeX, t.nodeY);
      return { task: `Gathering ${t.resource}`, target: `${n ? NODE_DEFS[n.kind].label : "Resource"} at ${t.nodeX},${t.nodeY}` };
    }
    case "deposit": {
      const b = t.buildingId !== null ? world.buildings.get(t.buildingId) : undefined;
      return { task: "Depositing cargo", target: b ? `${buildingDef(b.type).name} #${b.id}` : "nearest storage" };
    }
    case "build": {
      const b = world.buildings.get(t.buildingId);
      return { task: "Building", target: b ? `${buildingDef(b.type).name} #${b.id} (${Math.floor((b.progress / buildingDef(b.type).buildTime) * 100)}%)` : "" };
    }
    case "wait":
      return { task: "Waiting", target: `${Math.max(0, (t.until - world.tick) / world.cfg.tickRate).toFixed(1)}s` };
    case "withdraw": {
      const b = t.buildingId !== null ? world.buildings.get(t.buildingId) : undefined;
      return { task: `Withdrawing ${t.amount} ${t.resource}`, target: b ? `${buildingDef(b.type).name} #${b.id}` : "nearest storage" };
    }
    case "observe":
    case "tame":
    case "train_creature":
    case "follow": {
      const c = world.units.get(t.targetId);
      const label = { observe: "Observing", tame: "Taming", train_creature: "Training", follow: "Following" }[t.kind];
      return { task: t.kind === "observe" ? `${label} (${t.progress.toFixed(0)}s)` : label, target: c ? `${unitDef(c.type).name} #${c.id} at ${c.x},${c.y}` : "" };
    }
    case "investigate":
      return { task: `Investigating ruins (${t.progress.toFixed(0)}s)`, target: `${t.x},${t.y}` };
    case "guard":
      return { task: "Guarding", target: `${t.x},${t.y}` };
    case "attack": {
      if (t.building) {
        const b = world.buildings.get(t.targetId);
        return { task: "Attacking", target: b ? `${buildingDef(b.type).name} #${b.id}` : "" };
      }
      const c = world.units.get(t.targetId);
      return { task: "Attacking", target: c ? `${unitDef(c.type).name} #${c.id} at ${c.x},${c.y}` : "" };
    }
    case "repair": {
      const b = world.buildings.get(t.buildingId);
      return { task: "Repairing", target: b ? `${buildingDef(b.type).name} #${b.id} (${b.hp} HP)` : "" };
    }
    case "pen":
      return { task: "Going to the paddock", target: `Paddock #${t.buildingId}` };
  }
}

export function unitView(world: World, u: UnitState, own: boolean, details = true): UnitView {
  const v: UnitView = {
    id: u.id,
    owner: u.owner,
    type: u.type,
    x: u.x,
    y: u.y,
    facing: u.facing,
    activity: u.activity,
    carrying: bagTotal(u.inventory) > 0,
    hpPct: Math.max(0, Math.min(100, Math.round((u.hp / world.unitMaxHp(u)) * 100))),
  };
  if (own) {
    const d = unitDef(u.type);
    const td = describeTask(world, u);
    v.own = {
      hp: u.hp,
      maxHp: world.unitMaxHp(u),
      inventory: { ...u.inventory },
      capacity: world.capacity(u),
      task: td.task,
      target: td.target,
      program: { state: u.program.state, version: u.program.version, error: u.program.error, note: u.program.note, library: u.program.library },
      blocked: u.blocked,
      learned: [...u.learned],
      hidden: world.isStealthy(u),
      buffs: buffViews(world, u.buffs),
    };
    if (d.attack) {
      v.own.damage = world.unitDamage(u);
      v.own.armor = Math.round(world.unitArmor(u) * 100) / 100;
    }
    if (u.pen !== null) v.own.pen = u.pen;
    const hd = heroDefForType(u.type);
    if (hd) v.own.abilities = hd.abilities.map((a) => ({ id: a.id, readyIn: world.abilityReadyIn(u, a.id) }));
    if (details) {
      v.own.log = u.log.slice(-15);
      v.own.trace = u.trace.map((e) => ({ t: Math.round((e.tick / world.cfg.tickRate) * 10) / 10, line: e.line, call: e.call, result: e.result, ok: e.ok }));
    }
  }
  return v;
}

export function buildingView(world: World, b: BuildingState, own: boolean): BuildingView {
  const def = buildingDef(b.type);
  const v: BuildingView = {
    id: b.id,
    owner: b.owner,
    type: b.type,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    complete: b.complete,
    progress: def.buildTime > 0 ? b.progress / def.buildTime : 1,
    hp: b.hp,
    maxHp: world.buildingMaxHp(b),
  };
  if (own) {
    v.own = {
      queue: b.queue.map((q) => ({
        kind: q.kind,
        id: q.kind === "unit" ? q.unitType : q.kind === "tech" ? q.techId : q.kind === "hero" ? (q.revive ? "revive" : "recruit") : `${q.track}:${q.rank}`,
        progress: q.progress,
        total: world.orderTime(b.owner, q),
      })),
      fertility: b.fertility,
      buffs: buffViews(world, b.buffs),
    };
    if (world.networksMode && def.storage && b.complete) v.own.storage = { stock: { ...b.stock }, capacity: world.storageCapacityOf(b) };
    if (b.prodBlocked) v.own.productionBlocked = true;
    if (def.pen && b.pen) {
      const animals = world.pennedIn(b);
      const perMinute: Partial<ResourceBag> = {};
      const f = world.mods(b.owner).factor("production");
      for (const a of animals) {
        for (const [r, n] of Object.entries(unitDef(a.type).creature?.paddock?.produces ?? {}) as [keyof ResourceBag, number][]) perMinute[r] = Math.round(((perMinute[r] ?? 0) + n * f) * 10) / 10;
      }
      v.own.paddock = {
        animals: animals.map((a) => ({ id: a.id, type: a.type })),
        capacity: def.pen,
        perMinute,
        breeding: Object.entries(b.pen.breed).map(([type, progress]) => ({ type, progress: Math.round(progress * 100) / 100 })),
      };
    }
  }
  return v;
}

/** A lair as `viewer` sees it. */
export function lairView(world: World, l: Lair, viewer: number): LairView {
  const st = world.lairState.get(l.id);
  const v: LairView = { id: l.id, kind: l.kind, x: l.x, y: l.y, r: l.r, status: st?.status ?? "dormant" };
  if (st?.status === "cleared") {
    const rate = world.cfg.tickRate;
    if (st.clearedBy !== null) v.clearedBy = world.players.get(st.clearedBy)?.name ?? `player ${st.clearedBy}`;
    v.respawnIn = world.territory.ownerAt(l.x, l.y) !== 0 || st.respawnTick === null ? null : Math.max(0, Math.ceil((st.respawnTick - world.tick) / rate));
    if (st.claimUntil !== null && world.tick < st.claimUntil) {
      v.claimIn = Math.ceil((st.claimUntil - world.tick) / rate);
      v.yourClaim = st.clearedBy === viewer;
    }
  }
  return v;
}

export function playerView(world: World, p: PlayerState): PlayerView {
  const level = world.level(p);
  return {
    id: p.id,
    name: p.name,
    race: p.race,
    resources: { ...p.resources },
    unitCount: world.limitedUnits(p.id),
    buildingCount: world.buildingsOf(p.id).size,
    territory: world.territory.countOf(p.id),
    explored: p.explored.size,
    techs: [...p.techs],
    unlocks: [...world.mods(p.id).unlocks],
    modifiers: world.mods(p.id).summary(),
    level,
    xp: p.xp,
    xpLevelStart: LEVEL_THRESHOLDS[level] as number,
    xpNextLevel: (LEVEL_THRESHOLDS[Math.min(level + 1, MAX_LEVEL)] as number),
    talentPoints: world.talentPoints(p),
    talentPointsSpent: world.spentTalentPoints(p),
    talents: { ...p.talents },
    discoveries: [...p.discoveries],
    observed: [...p.observed],
    combat: {
      optedIn: p.pvp,
      active: world.pvpActive(p.id),
      leavingInSeconds: !p.pvp && p.pvpUntil !== null && world.cfg.combatEnabled ? Math.max(0, Math.ceil((p.pvpUntil - world.tick) / world.cfg.tickRate)) : null,
    },
    spawn: { x: p.spawnX, y: p.spawnY },
    limits: { units: world.unitCap(p.id), buildings: world.buildingCap(p.id) },
    hero: heroView(world, p),
    lessons: [...p.lessons],
    trophies: [...p.trophies],
  };
}

function heroView(world: World, p: PlayerState): PlayerView["hero"] {
  const hd = heroDefForRace(p.race);
  if (!hd) return null;
  const o = world.heroOrderCost(p.id);
  return { type: hd.type, unitId: p.hero.unitId, recruited: p.hero.recruited, ranks: { ...p.hero.ranks }, deaths: p.hero.deaths, cost: o.cost, time: o.time, revive: o.revive };
}

export function chunkMessage(world: World, cx: number, cy: number, viewer: number): ServerMessage {
  const c = world.chunks.getChunk(cx, cy);
  const size = world.chunks.size;
  const nodes: NodeTuple[] = [];
  for (const [li, n] of c.nodes) nodes.push([n.kind, cx * size + (li % size), cy * size + Math.floor(li / size), world.chunks.amountOf(n)]);
  const ruins: RuinTuple[] = c.ruins.map((r) => [r.x, r.y, r.tier, world.lootedRuins.has(`${r.x},${r.y}`) ? 1 : 0]);
  const lairs = world.lairs.centredIn(cx * size, cy * size, cx * size + size - 1, cy * size + size - 1).map((l) => lairView(world, l, viewer));
  const zones = world.zonesActive ? world.zones.inRect(cx * size, cy * size, cx * size + size - 1, cy * size + size - 1).map((z) => ({ id: z.id, x: z.x, y: z.y, r: z.r })) : [];
  return { t: "chunk", cx, cy, tiles: encodeTiles(c.tiles), nodes, territory: world.territory.encodeChunk(chunkKey(cx, cy)), ruins, zones, ...(lairs.length ? { lairs } : {}) };
}

export function unitChunk(world: World, u: UnitState): string {
  const s = world.chunks.size;
  return chunkKey(floorDiv(u.x, s), floorDiv(u.y, s));
}

/** All chunk keys a building's footprint touches. */
export function buildingChunks(world: World, b: BuildingState): string[] {
  const s = world.chunks.size;
  const out = new Set<string>();
  for (const [x, y] of [[b.x, b.y], [b.x + b.w - 1, b.y], [b.x, b.y + b.h - 1], [b.x + b.w - 1, b.y + b.h - 1]] as const) {
    out.add(chunkKey(floorDiv(x, s), floorDiv(y, s)));
  }
  return [...out];
}
