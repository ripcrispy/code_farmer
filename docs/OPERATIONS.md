# Operations

## Running

- Development: `npm run server` (game server) and `npm run dev` (Vite client).
- Production: `npm run build`, serve `dist/` statically (any web server or CDN), run `npm start` under a process manager (systemd, pm2, NSSM on Windows). Ctrl+C / SIGTERM triggers a final save before exit.

## Health and diagnostics

- `GET /health`: `{ ok, tick, persistenceError }`. Public; use it for liveness checks.
- `GET /admin/status` with `Authorization: Bearer $CODEFARMER_ADMIN_TOKEN`: world settings, simulation config, entity counts (including wildlife), connections, chunk cache, last/max tick time, script ops and deferred units, path searches and failures, long-range searches, contained internal errors, network counters, and flush latency/failures. Returns 404 when no token is configured.
- **Internal errors:** if a bug throws while updating one unit or building, the server logs `ERROR Internal error updating unit #… ; task cancelled` with the stack trace, cancels that unit's task (the player sees "Internal server error" in the unit log) and keeps running. `internalErrors` in `/admin/status` counts them. Please report these log lines; they are bugs.
- `npm run world:info`: stored world metadata and counts (works while the server is stopped).

Persistence failures are logged at ERROR, appear in `/health`, and are retried each flush interval without losing in-memory state. Investigate disk space and permissions immediately; while the server stays up nothing is lost, but a crash would lose everything since the last good flush.

## Backups

The database is a single SQLite file in WAL mode plus `-wal`/`-shm` side files.

- **Cold backup (simplest):** stop the server, copy `data/codefarmer.db*`.
- **Hot backup:** `sqlite3 data/codefarmer.db ".backup data/backup-$(date +%F).db"` (requires the sqlite3 CLI). The online backup API produces a consistent copy while the server runs.

## Restore

1. Stop the server.
2. Move the current `data/codefarmer.db*` aside.
3. Copy the backup to `data/codefarmer.db` (no `-wal`/`-shm` files).
4. Start the server. Migrations newer than the backup are applied automatically; the world settings check still applies.

## Resetting a world

`npm run world:reset -- --confirm` archives the database to a timestamped `.bak` file. Nothing is deleted.

## Upgrading

- Schema changes ship as new migrations (`src/server/persistence/migrations.ts`) and run on start or via `npm run db:migrate`. Back up first.
- Changes to world generation must bump `GENERATION_VERSION`. A world only loads with a config whose `generationVersion` matches it, and only if the build still supports that version (currently 1 and 2).
- **v1 -> v2** (ruins and wildlife): stop the server, then `npm run world:upgrade -- --confirm`, then set `"generationVersion": 2` in the config if it is not already. The tool backs the database up to `<db>.<timestamp>.pre-v2.bak` first. Terrain and resources do not change. Existing players keep everything; they start at level 1 because experience did not exist before.
- Restore a pre-upgrade backup like any other backup (stop the server, copy it over `data/codefarmer.db`, remove the `-wal`/`-shm` files) and set `"generationVersion": 1`.
