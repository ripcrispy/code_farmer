# Configuration

The server reads, in order of precedence:

1. Environment variables (also loaded from `.env` if present; see `.env.example`).
2. The JSON file at `$CODEFARMER_CONFIG`, or `config/server.json` if that variable is unset. All keys are optional; unknown keys are an error (to catch typos); keys starting with `$` or `_` are ignored (comments).
3. Built-in defaults (`DEFAULT_CONFIG` in `src/server/config.ts`).

Invalid values stop the server with a message naming the setting.

## Settings

| Key | Default | Limits | Notes |
| --- | --- | --- | --- |
| `server.host` | `127.0.0.1` | | Use `0.0.0.0` to accept LAN connections. Env: `CODEFARMER_HOST` |
| `server.port` | `3001` | 1-65535 | Env: `CODEFARMER_PORT` |
| `server.maxConnections` | `200` | >= 1 | |
| `server.allowedOrigins` | `["*"]` | | WebSocket `Origin` allow-list; set to your client URL in production |
| `world.seed` | `codefarmer-world-001` | 1-128 chars | **Fixed once the world exists** |
| `world.generationVersion` | `2` | 1 or 2 (versions this build supports) | **Fixed once the world exists**, except for the explicit v1 -> v2 upgrade (`npm run world:upgrade`). v2 adds ruins and wildlife; v1 has neither. |
| `world.chunkSize` | `64` | 16-128 | **Fixed once the world exists** |
| `world.resourceDensity` | `1.0` | 0.25-4 | **Fixed once the world exists** |
| `simulation.tickRate` | `10` | 1-60 | Ticks per second |
| `simulation.scriptOpsPerUnitTick` | `400` | 10-100,000 | VM instructions per unit per tick |
| `simulation.scriptOpsPerTick` | `200000` | 100-10,000,000 | Total VM instructions per tick |
| `simulation.pathRadius` | `48` | 8-256 | Max pathfinding search radius (tiles) |
| `simulation.maxCoordinate` | `1000000` | | Largest accepted absolute tile coordinate |
| `simulation.maxCachedChunks` | `512` | 16-100,000 | Server chunk cache (LRU) |
| `combat.enabled` | `false` | true/false | Optional combat. Off: nothing can be attacked and military units/buildings are unavailable. On: players may hunt animals, and fight each other only if both opt in to PvP in the game. Takes effect on restart. |
| `combat.optOutDelaySeconds` | `120` | 10-3600 | How long a player stays attackable after opting out of PvP; every fight restarts it |
| `combat.contestedZones` | `true` | true/false | Small areas (from the seed) where PvP is always on and gathering is 50% faster. Only with `combat.enabled`. Zones never move; turning this off removes their rules but not the land around them. |
| `combat.pve` | `true` | true/false | PvE: units can fight lair monsters (generation v3) even when `combat.enabled` is false; Soldiers, Archers and Knights can then be trained. PvP and hunting still need `combat.enabled`. |
| `economy.storage` | `"shared"` | `"shared"` or `"networks"` | `"shared"`: one stock per player usable anywhere. `"networks"`: resources sit in storage buildings with capacities; costs are paid from storage near the work, so resources must be hauled (GAME_DESIGN.md, Storage modes). Can be changed on an existing world: on the next start, stock is converted without loss and the server logs what it moved. |
| `economy.unitLimitCeiling` | `300` | 10-5000 | Highest unit limit research can give a player (base 60) |
| `economy.buildingLimitCeiling` | `400` | 10-5000 | Highest building limit research can give a player (base 80) |
| `persistence.databasePath` | `data/codefarmer.db` | | Env: `CODEFARMER_DB` |
| `persistence.flushIntervalMs` | `2000` | 200-60,000 | Max progress lost in a hard crash |
| `network.visionChunkRadius` | `2` | 1-4 | Chunks visible around your presence |
| `network.messagesPerSecond` | `20` | 1-1000 | Token-bucket refill rate per connection |
| `network.messageBurst` | `40` | >= messagesPerSecond | Bucket size |
| `network.maxMessageBytes` | `32768` | 1 KiB-1 MiB | Larger frames are rejected |
| `admin.token` | `""` | | Enables `GET /admin/status` (Bearer). Prefer env `CODEFARMER_ADMIN_TOKEN` |

## World settings are immutable

On first start the world settings are written to the database (`world_meta`). On every later start the server compares them with the config and **refuses to start** if any differ, rather than silently regenerating terrain under existing players. To create a new world:

1. Change `world.*` in the config.
2. `npm run world:reset -- --confirm` (moves the database to `data/codefarmer.db.<timestamp>.bak`).
3. Start the server.

Alternatively, point `persistence.databasePath` at a new file to keep several worlds side by side.

### Upgrading to generation v3 (monster lairs and new wildlife)

Generation v3 keeps every v2 tile, resource, ruin and creature identical and adds more wildlife species (in chunks nobody has visited yet) and PvE monster lairs. To upgrade an existing v2 world: stop the server, run `npm run world:upgrade -- --confirm` (it backs the database up to `<db>.<timestamp>.pre-v3.bak` first), then set `"generationVersion": 3` in the config. A v1 world needs the tool twice (v1 -> v2 -> v3). If the config asks for a newer version than the world, the server refuses to start and explains this. New worlds should use 3.

`combat.pve` (default `true`): units can fight lair monsters even when `combat.enabled` is false. Set it to `false` for a server where nothing can be fought.

### Upgrading a v1 world to v2

Generation v2 keeps every v1 tile and resource identical and adds ruins and wildlife, so a v1 world can be upgraded in place instead of reset. If the config says v2 and the world is v1, the server refuses to start and says so. Then either:

- `npm run world:upgrade -- --confirm` (copies the database to `<db>.<timestamp>.pre-v2.bak` first, then marks the world as v2), or
- keep the world as it is by setting `"generationVersion": 1`.

Running the tool without `--confirm` only explains what it would do; running it on a v2 world does nothing.

## Client

- `VITE_SERVER_URL` (build-time) sets the default server URL shown on the login screen. Otherwise it is `ws://<page host>:3001/ws`.
- The login screen's Server field overrides it and is remembered per browser profile.
- `?profile=<name>` in the page URL keeps a separate saved login (for multiple players on one machine).

## Templates

- `config/server.json`: development defaults.
- `config/server.production.example.json`: production template (listen on all interfaces, explicit origin, new seed, absolute DB path).
