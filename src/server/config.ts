import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATION_VERSION, validateGenParams, type WorldGenParams } from "../shared/worldgen.ts";
import { DEFAULT_SIM_CONFIG, validateSimConfig, type SimConfig, type StorageMode } from "../sim/world.ts";

export interface ServerConfig {
  server: {
    host: string;
    port: number;
    maxConnections: number;
    /** Allowed WebSocket Origin headers. ["*"] allows any origin (development default). */
    allowedOrigins: string[];
  };
  world: WorldGenParams;
  simulation: Omit<SimConfig, "combatEnabled" | "pvpOptOutSeconds" | "contestedZones" | "pveEnabled" | "storageMode" | "unitLimitCeiling" | "buildingLimitCeiling">;
  /** Economy rules. */
  economy: {
    /** "shared": one stock per player usable anywhere. "networks": storage buildings hold resources; costs are paid locally. */
    storage: StorageMode;
    /** Server-wide ceilings on the unit and building limits (research raises the limits up to these). */
    unitLimitCeiling: number;
    buildingLimitCeiling: number;
  };
  /** Optional combat. Off by default; when on, each player still opts in to PvP. */
  combat: {
    enabled: boolean;
    /** Seconds a player stays attackable after opting out (and after their last fight). */
    optOutDelaySeconds: number;
    /** Small areas (from the seed) where PvP is always on; only with combat enabled. */
    contestedZones: boolean;
    /** PvE: fighting lair monsters works even with combat (PvP) off. Default true. */
    pve: boolean;
  };
  persistence: {
    databasePath: string;
    flushIntervalMs: number;
  };
  network: {
    /** Chunks within this Chebyshev radius of a chunk containing one of your units/buildings may be subscribed. */
    visionChunkRadius: number;
    messagesPerSecond: number;
    messageBurst: number;
    maxMessageBytes: number;
  };
  admin: {
    /** Bearer token for /admin/status. Empty disables the endpoint. Prefer the CODEFARMER_ADMIN_TOKEN env var. */
    token: string;
  };
}

export const DEFAULT_CONFIG: ServerConfig = {
  server: { host: "127.0.0.1", port: 3001, maxConnections: 200, allowedOrigins: ["*"] },
  world: { seed: "codefarmer-world-001", generationVersion: GENERATION_VERSION, chunkSize: 64, resourceDensity: 1.0 },
  simulation: {
    tickRate: DEFAULT_SIM_CONFIG.tickRate,
    scriptOpsPerUnitTick: DEFAULT_SIM_CONFIG.scriptOpsPerUnitTick,
    scriptOpsPerTick: DEFAULT_SIM_CONFIG.scriptOpsPerTick,
    pathRadius: DEFAULT_SIM_CONFIG.pathRadius,
    maxCoordinate: DEFAULT_SIM_CONFIG.maxCoordinate,
    maxCachedChunks: DEFAULT_SIM_CONFIG.maxCachedChunks,
  },
  economy: { storage: DEFAULT_SIM_CONFIG.storageMode, unitLimitCeiling: DEFAULT_SIM_CONFIG.unitLimitCeiling, buildingLimitCeiling: DEFAULT_SIM_CONFIG.buildingLimitCeiling },
  combat: { enabled: DEFAULT_SIM_CONFIG.combatEnabled, optOutDelaySeconds: DEFAULT_SIM_CONFIG.pvpOptOutSeconds, contestedZones: DEFAULT_SIM_CONFIG.contestedZones, pve: DEFAULT_SIM_CONFIG.pveEnabled },
  persistence: { databasePath: "data/codefarmer.db", flushIntervalMs: 2000 },
  network: { visionChunkRadius: 2, messagesPerSecond: 20, messageBurst: 40, maxMessageBytes: 65_536 },
  admin: { token: "" },
};

type Section = keyof ServerConfig;

/** Deep-merge a parsed JSON object over the defaults, rejecting unknown keys and wrong types. */
function merge(base: Record<string, unknown>, over: unknown, path: string): Record<string, unknown> {
  if (over === undefined) return base;
  if (typeof over !== "object" || over === null || Array.isArray(over)) throw new Error(`Config error: '${path}' must be an object`);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (k.startsWith("$") || k.startsWith("_")) continue; // allow "$comment" style keys
    if (!(k in base)) throw new Error(`Config error: unknown setting '${path}.${k}'`);
    const bv = base[k];
    if (Array.isArray(bv)) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`Config error: '${path}.${k}' must be an array of strings`);
      out[k] = v;
    } else if (typeof bv === "object" && bv !== null) {
      out[k] = merge(bv as Record<string, unknown>, v, `${path}.${k}`);
    } else {
      if (typeof v !== typeof bv) throw new Error(`Config error: '${path}.${k}' must be a ${typeof bv} (got ${JSON.stringify(v)})`);
      out[k] = v;
    }
  }
  return out;
}

export function validateConfig(c: ServerConfig): void {
  if (!Number.isInteger(c.server.port) || c.server.port < 1 || c.server.port > 65535) throw new Error("Config error: server.port must be 1-65535");
  if (!Number.isInteger(c.server.maxConnections) || c.server.maxConnections < 1) throw new Error("Config error: server.maxConnections must be a positive integer");
  validateGenParams(c.world);
  validateSimConfig(simConfigOf(c));
  if (!(c.persistence.flushIntervalMs >= 200 && c.persistence.flushIntervalMs <= 60_000)) throw new Error("Config error: persistence.flushIntervalMs must be 200-60000");
  if (!c.persistence.databasePath) throw new Error("Config error: persistence.databasePath is required");
  const n = c.network;
  if (!Number.isInteger(n.visionChunkRadius) || n.visionChunkRadius < 1 || n.visionChunkRadius > 4) throw new Error("Config error: network.visionChunkRadius must be 1-4");
  if (!(n.messagesPerSecond >= 1 && n.messagesPerSecond <= 1000)) throw new Error("Config error: network.messagesPerSecond must be 1-1000");
  if (!(n.messageBurst >= n.messagesPerSecond)) throw new Error("Config error: network.messageBurst must be >= messagesPerSecond");
  if (!(n.maxMessageBytes >= 1024 && n.maxMessageBytes <= 1_048_576)) throw new Error("Config error: network.maxMessageBytes must be 1024-1048576");
}

/**
 * Load configuration: defaults <- JSON file <- environment variables.
 * File: $CODEFARMER_CONFIG or config/server.json (optional; defaults are used if absent).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): { config: ServerConfig; source: string } {
  const file = resolve(cwd, env.CODEFARMER_CONFIG ?? "config/server.json");
  let parsed: unknown = {};
  let source = "built-in defaults";
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Config error: ${file} is not valid JSON (${(e as Error).message})`);
    }
    source = file;
  } else if (env.CODEFARMER_CONFIG) {
    throw new Error(`Config error: CODEFARMER_CONFIG points to ${file}, which does not exist`);
  }
  const config = merge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed, "config") as unknown as ServerConfig;
  const sections: Section[] = ["server", "world", "simulation", "economy", "combat", "persistence", "network", "admin"];
  for (const s of sections) if (!config[s]) throw new Error(`Config error: missing section ${s}`);
  if (env.CODEFARMER_PORT) config.server.port = Number(env.CODEFARMER_PORT);
  if (env.CODEFARMER_HOST) config.server.host = env.CODEFARMER_HOST;
  if (env.CODEFARMER_DB) config.persistence.databasePath = env.CODEFARMER_DB;
  if (env.CODEFARMER_ADMIN_TOKEN) config.admin.token = env.CODEFARMER_ADMIN_TOKEN;
  validateConfig(config);
  return { config, source };
}

/** The simulation's settings: `simulation` plus the combat switch. */
export function simConfigOf(c: ServerConfig): SimConfig {
  return { ...c.simulation, combatEnabled: c.combat.enabled, pvpOptOutSeconds: c.combat.optOutDelaySeconds, contestedZones: c.combat.contestedZones, pveEnabled: c.combat.pve,
    storageMode: c.economy.storage, unitLimitCeiling: c.economy.unitLimitCeiling, buildingLimitCeiling: c.economy.buildingLimitCeiling };
}
