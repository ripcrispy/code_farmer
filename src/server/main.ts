import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { openWorld, WorldConfigMismatchError } from "./bootstrap.ts";
import { GameServer } from "./gameServer.ts";
import { consoleLogger as log } from "./logger.ts";
import { SqliteStore } from "./persistence/sqliteStore.ts";
import { startTransport } from "./transport.ts";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { config, source } = loadConfig();
  log.info(`Configuration loaded from ${source}`);
  const store = new SqliteStore(config.persistence.databasePath);
  const { world } = openWorld(config, store, log);
  const game = new GameServer(world, store, config, log);
  const transport = await startTransport(game, config, log);
  game.start();
  log.info(`Code Farmer server listening on ws://${config.server.host}:${transport.port}/ws (tick rate ${world.cfg.tickRate}/s, seed "${world.gen.params.seed}")`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received: saving and shutting down`);
    try {
      game.stop();
      await transport.close();
      store.close();
      log.info("Shutdown complete");
      process.exit(0);
    } catch (e) {
      log.error("Error during shutdown", e);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e: unknown) => {
  if (e instanceof WorldConfigMismatchError) {
    log.error(e.message);
  } else {
    log.error("Server failed to start", e);
  }
  process.exit(1);
});
