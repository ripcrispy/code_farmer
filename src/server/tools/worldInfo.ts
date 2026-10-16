/** Print the persistent world's metadata and entity counts: npm run world:info */
import { existsSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../persistence/sqliteStore.ts";

const { config, source } = loadConfig();
const path = config.persistence.databasePath;
console.log(`Config: ${source}`);
if (!existsSync(path)) {
  console.log(`No database at ${path}. A new world will be created with seed "${config.world.seed}" on first server start.`);
  process.exit(0);
}
const store = new SqliteStore(path);
store.migrate();
const meta = store.getWorldMeta();
if (!meta) {
  console.log(`Database ${path} has no world yet.`);
} else {
  const data = store.loadWorld();
  console.log(JSON.stringify({ database: path, schemaVersion: store.schemaVersion(), world: meta, accounts: data.accounts.length, players: data.players.length, units: data.units.length, buildings: data.buildings.length, modifiedChunks: data.chunkMods.length }, null, 2));
  const mismatch = meta.seed !== config.world.seed || meta.generationVersion !== config.world.generationVersion || meta.chunkSize !== config.world.chunkSize || meta.resourceDensity !== config.world.resourceDensity;
  if (mismatch) console.log("WARNING: config world settings differ from the stored world; the server will refuse to start until they match.");
}
store.close();
