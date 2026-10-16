/**
 * Upgrade a world's generation version: npm run world:upgrade -- --confirm
 *
 * Only upgrades that leave existing terrain and resources bit-identical are allowed
 * (v1 -> v2 adds ruins and wildlife; v2 -> v3 adds more wildlife species and PvE lairs).
 * The database is copied to a timestamped backup first.
 */
import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../persistence/sqliteStore.ts";

const UPGRADES: Record<number, number> = { 1: 2, 2: 3 };

const { config } = loadConfig();
const path = config.persistence.databasePath;
if (!existsSync(path)) {
  console.log(`No database at ${path}; nothing to upgrade.`);
  process.exit(0);
}
const store = new SqliteStore(path);
store.migrate();
const meta = store.getWorldMeta();
store.close();
if (!meta) {
  console.log("Database has no world yet; nothing to upgrade.");
  process.exit(0);
}
const target = UPGRADES[meta.generationVersion];
if (!target) {
  console.log(`World is at generation v${meta.generationVersion}; there is no newer compatible version, nothing to do.`);
  process.exit(0);
}
if (!process.argv.includes("--confirm")) {
  console.log(`This upgrades ${path} from generation v${meta.generationVersion} to v${target}.`);
  console.log("Terrain and resources stay exactly as they are.");
  if (target === 2) console.log("Ruins (which never block movement or building) appear across the map, and wildlife spawns in each chunk the first time a player is nearby.");
  if (target === 3) {
    console.log("New wildlife (sheep, goats, horses, aurochs, bears) appears in chunks that players have not visited yet, and PvE monster lairs");
    console.log("appear across the map (none within 120 tiles of the world centre). Existing buildings inside a lair's area are kept;");
    console.log("a lair whose centre is inside someone's territory starts out cleared.");
  }
  console.log("Re-run with --confirm to proceed:  npm run world:upgrade -- --confirm");
  process.exit(1);
}
const backup = `${path}.${new Date().toISOString().replace(/[:.]/g, "-")}.pre-v${target}.bak`;
copyFileSync(path, backup);
const db = new DatabaseSync(path);
db.prepare("UPDATE world_meta SET value = ? WHERE key = 'generation_version'").run(String(target));
db.close();
console.log(`Upgraded to generation v${target}. Backup: ${backup}`);
if (config.world.generationVersion !== target) console.log(`Set "generationVersion": ${target} in your config before starting the server.`);
