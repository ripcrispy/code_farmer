/**
 * Explicitly create a new world: npm run world:reset -- --confirm
 * The current database is moved to a timestamped backup first; nothing is deleted.
 */
import { existsSync, renameSync } from "node:fs";
import { loadConfig } from "../config.ts";

const { config } = loadConfig();
const path = config.persistence.databasePath;
if (!process.argv.includes("--confirm")) {
  console.log(`This will archive ${path} and start a NEW world with seed "${config.world.seed}" on the next server start.`);
  console.log("All accounts, units, buildings and programs in the current world will no longer be loaded.");
  console.log("Re-run with --confirm to proceed:  npm run world:reset -- --confirm");
  process.exit(1);
}
if (!existsSync(path)) {
  console.log(`No database at ${path}; nothing to reset.`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${path}.${stamp}.bak`;
renameSync(path, backup);
for (const ext of ["-wal", "-shm"]) if (existsSync(path + ext)) renameSync(path + ext, backup + ext);
console.log(`Archived the old world to ${backup}. Start the server to create a new world with seed "${config.world.seed}".`);
