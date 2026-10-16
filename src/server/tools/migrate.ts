/** Apply pending database migrations: npm run db:migrate */
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../persistence/sqliteStore.ts";

const { config } = loadConfig();
const store = new SqliteStore(config.persistence.databasePath);
const applied = store.migrate();
console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is up to date");
console.log(`Schema version: ${store.schemaVersion()} (${config.persistence.databasePath})`);
store.close();
