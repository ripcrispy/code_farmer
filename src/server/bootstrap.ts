import { findTrophyDef } from "../shared/defs/lairs.ts";
import { HERO_TRAINING, heroDefForRace } from "../shared/defs/heroes.ts";
import { findLesson } from "../shared/defs/lessons.ts";
import { isResourceType } from "../shared/defs/resources.ts";
import { findBuildingDef } from "../shared/defs/buildings.ts";
import { findUnitDef } from "../shared/defs/units.ts";
import { findTechDef } from "../shared/defs/techs.ts";
import { findTalentDef } from "../shared/defs/talents.ts";
import { MAX_XP } from "../shared/defs/progression.ts";
import { NEUTRAL, type TrainOrder } from "../sim/types.ts";
import { findDiscoveryDef } from "../shared/defs/discoveries.ts";
import { SUPPORTED_GENERATION_VERSIONS, type WorldGenParams } from "../shared/worldgen.ts";
import { World } from "../sim/world.ts";
import { simConfigOf, type ServerConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { GameStore, WorldMetaRecord } from "./persistence/store.ts";

export class WorldConfigMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldConfigMismatchError";
  }
}

/**
 * Open (or create) the persistent world.
 *
 * - A new database gets world metadata from the config (seed, generation version, ...).
 * - An existing world keeps its stored seed and generation parameters. If the config
 *   disagrees, startup fails with an explanation instead of silently regenerating terrain.
 */
export function openWorld(cfg: ServerConfig, store: GameStore, log: Logger): { world: World; meta: WorldMetaRecord; created: boolean } {
  const applied = store.migrate();
  if (applied.length) log.info(`Applied database migrations: ${applied.join(", ")}`);
  let meta = store.getWorldMeta();
  let created = false;
  if (!meta) {
    meta = {
      seed: cfg.world.seed,
      generationVersion: cfg.world.generationVersion,
      chunkSize: cfg.world.chunkSize,
      resourceDensity: cfg.world.resourceDensity,
      createdAt: new Date().toISOString(),
      nextId: 1,
      tick: 0,
    };
    store.createWorldMeta(meta);
    created = true;
    log.info(`Created a new world with seed "${meta.seed}" (generation v${meta.generationVersion})`);
  } else {
    const diffs: string[] = [];
    if (meta.seed !== cfg.world.seed) diffs.push(`seed: world="${meta.seed}" config="${cfg.world.seed}"`);
    if (meta.generationVersion !== cfg.world.generationVersion) diffs.push(`generationVersion: world=${meta.generationVersion} config=${cfg.world.generationVersion}`);
    if (meta.chunkSize !== cfg.world.chunkSize) diffs.push(`chunkSize: world=${meta.chunkSize} config=${cfg.world.chunkSize}`);
    if (meta.resourceDensity !== cfg.world.resourceDensity) diffs.push(`resourceDensity: world=${meta.resourceDensity} config=${cfg.world.resourceDensity}`);
    if (diffs.length === 1 && cfg.world.generationVersion > meta.generationVersion && cfg.world.generationVersion <= 3) {
      const what = cfg.world.generationVersion === 2 ? "ruins and wildlife" : "more wildlife species and monster lairs";
      const steps = cfg.world.generationVersion - meta.generationVersion;
      throw new WorldConfigMismatchError(
        `The world at ${cfg.persistence.databasePath} uses generation v${meta.generationVersion} but the config asks for v${cfg.world.generationVersion} (${what}).\n` +
          `Newer versions keep every existing tile and resource unchanged and only add new features, so the world can be upgraded${steps > 1 ? ` (run it ${steps} times, one version at a time)` : ""}:\n` +
          "  npm run world:upgrade -- --confirm\n" +
          `Or keep the world as it is by setting "generationVersion": ${meta.generationVersion} in the config.`,
      );
    }
    if (diffs.length) {
      throw new WorldConfigMismatchError(
        `The database at ${cfg.persistence.databasePath} contains an existing world whose generation settings differ from the config:\n  ${diffs.join("\n  ")}\n` +
          "An existing world is never regenerated with different settings. Either restore the original values in the config, " +
          "point persistence.databasePath at a new database, or explicitly reset the world with: npm run world:reset -- --confirm",
      );
    }
    if (!SUPPORTED_GENERATION_VERSIONS.includes(meta.generationVersion)) {
      throw new WorldConfigMismatchError(
        `This world was generated with generation v${meta.generationVersion}, but this server build supports v${SUPPORTED_GENERATION_VERSIONS.join(", ")}. ` +
          "Refusing to reinterpret the world under different generation rules.",
      );
    }
  }
  const params: WorldGenParams = {
    seed: meta.seed,
    generationVersion: meta.generationVersion,
    chunkSize: meta.chunkSize,
    resourceDensity: meta.resourceDensity,
  };
  const world = new World(params, simConfigOf(cfg));
  world.onInternalError = (msg, err) => log.error(msg, err);
  world.tick = meta.tick;
  world.nextId = meta.nextId;

  const data = store.loadWorld();
  for (const c of data.chunkMods) world.chunks.loadMods(c.cx, c.cy, c.data);
  const names = new Map(data.accounts.map((a) => [a.id, a.name]));
  for (const p of data.players) {
    for (const [k, v] of Object.entries(p.resources)) {
      if (!isResourceType(k) || !Number.isInteger(v) || v < 0) throw new Error(`Corrupt player ${p.id}: invalid resource ${k}=${String(v)}`);
    }
    world.restorePlayer({
      id: p.id,
      name: names.get(p.id) ?? `player${p.id}`,
      race: p.race,
      resources: { ...p.resources },
      spawnX: p.spawnX,
      spawnY: p.spawnY,
      techs: p.techs.filter((t) => findTechDef(t)),
      explored: new Set(),
      xp: Math.max(0, Math.min(MAX_XP, Math.floor(p.xp))),
      // Drop unknown or invalid talents rather than trusting stored data blindly.
      talents: Object.fromEntries(
        Object.entries(p.talents).filter(([id, rank]) => {
          const t = findTalentDef(id);
          return t && (!t.race || t.race === p.race) && Number.isInteger(rank) && rank >= 1 && rank <= t.maxRank;
        }),
      ),
      discoveries: p.discoveries.filter((d) => findDiscoveryDef(d)),
      observed: p.observed.filter((t) => findUnitDef(t)?.creature),
      pvp: p.pvp,
      pvpUntil: p.pvpUntil,
      hero: {
        unitId: typeof p.hero?.unitId === "number" ? p.hero.unitId : null,
        recruited: p.hero?.recruited === true,
        // Keep only known training tracks with valid ranks.
        ranks: Object.fromEntries(
          Object.entries(p.hero?.ranks ?? {}).filter(([id, rank]) => Object.hasOwn(HERO_TRAINING, id) && Number.isInteger(rank) && rank >= 1 && rank <= (HERO_TRAINING[id]?.maxRank ?? 0)),
        ),
        deaths: Number.isInteger(p.hero?.deaths) && p.hero.deaths >= 0 ? p.hero.deaths : 0,
      },
      lessons: [...new Set((Array.isArray(p.lessons) ? p.lessons : []).filter((id) => typeof id === "string" && findLesson(id)))],
      trophies: [...new Set((Array.isArray(p.trophies) ? p.trophies : []).filter((id) => typeof id === "string" && findTrophyDef(id)))],
    });
  }
  for (const b of data.buildings) {
    if (!findBuildingDef(b.type)) throw new Error(`Corrupt building ${b.id}: unknown type '${b.type}'`);
    if (!world.players.has(b.ownerId)) throw new Error(`Corrupt building ${b.id}: owner ${b.ownerId} missing`);
    world.restoreBuilding({
      id: b.id,
      owner: b.ownerId,
      type: b.type,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      hp: b.hp,
      complete: b.complete,
      progress: b.progress,
      // Queues saved before research existed have no `kind`.
      queue: (b.queue as unknown as Record<string, unknown>[]).map((q) =>
        ("kind" in q ? q : { kind: "unit", unitType: q.unitType as string, progress: q.progress as number }) as TrainOrder,
      ),
      prodAcc: b.prodAcc,
      fertility: b.fertility,
      completedTick: b.completedTick,
      stock: { ...b.stock },
      prodBlocked: false,
      buffs: [],
      pen: findBuildingDef(b.type)?.pen ? { acc: { ...(b.pen?.acc ?? {}) }, breed: { ...(b.pen?.breed ?? {}) } } : null,
      rev: 0,
    });
  }
  for (const u of data.units) {
    if (!findUnitDef(u.type)) throw new Error(`Corrupt unit ${u.id}: unknown type '${u.type}'`);
    if (u.ownerId !== NEUTRAL && !world.players.has(u.ownerId)) throw new Error(`Corrupt unit ${u.id}: owner ${u.ownerId} missing`);
    world.restoreUnit({
      id: u.id,
      owner: u.ownerId,
      type: u.type,
      x: u.x,
      y: u.y,
      facing: u.facing,
      hp: u.hp,
      inventory: u.inventory,
      learned: u.learned,
      home: u.home,
      // An animal's paddock must still exist and be its owner's paddock.
      pen: u.pen !== null && world.buildings.get(u.pen)?.owner === u.ownerId && findBuildingDef(world.buildings.get(u.pen)?.type ?? "")?.pen ? u.pen : null,
      task: { kind: "idle" },
      taskSource: "script",
      program: { source: u.programSource, version: u.programVersion, state: u.programState, error: u.programError, note: "", library: u.programLibrary },
      blocked: "",
    });
  }
  // A hero record must point at that player's living hero unit of their race.
  for (const p of world.players.values()) {
    const id = p.hero.unitId;
    if (id === null) continue;
    const u = world.units.get(id);
    if (!u || u.owner !== p.id || heroDefForRace(p.race)?.type !== u.type) {
      log.warn(`Player ${p.id}: hero unit ${id} missing or invalid; the hero can be revived`);
      p.hero.unitId = null;
    } else {
      p.hero.recruited = true;
    }
  }
  for (const e of data.explored) world.players.get(e.playerId)?.explored.add(`${e.cx},${e.cy}`);
  for (const c of data.populated) world.populated.add(`${c.cx},${c.cy}`);
  for (const r of data.looted) world.lootedRuins.add(`${r.x},${r.y}`);
  for (const l of data.lairs) world.restoreLair({ ...l });
  world.rebuildTerritory();
  // Storage mode can be switched in the config: convert stock losslessly (saved at the next flush).
  const converted = world.applyStorageMode();
  if (converted > 0) {
    log.info(
      world.networksMode
        ? `Storage networks enabled: moved ${converted} player(s)' stock into their Town Hall (or first storage building)`
        : `Shared storage enabled: moved ${converted} player(s)' building stock back into their shared stock`,
    );
  }
  world.nextId = Math.max(world.nextId, meta.nextId);
  world.net.clear();
  world.chunks.nodeChanges = [];
  log.info(`Loaded world: ${data.players.length} players, ${data.units.length} units, ${data.buildings.length} buildings, ${data.chunkMods.length} modified chunks, tick ${world.tick}`);
  return { world, meta, created };
}
