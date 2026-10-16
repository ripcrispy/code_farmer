/**
 * Versioned schema migrations. Append new migrations; never edit one that has shipped.
 * Each migration runs in its own transaction and is recorded in schema_migrations.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      CREATE TABLE world_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE players (
        id INTEGER PRIMARY KEY REFERENCES accounts(id),
        race TEXT NOT NULL,
        wood INTEGER NOT NULL CHECK (wood >= 0),
        stone INTEGER NOT NULL CHECK (stone >= 0),
        gold INTEGER NOT NULL CHECK (gold >= 0),
        food INTEGER NOT NULL CHECK (food >= 0),
        spawn_x INTEGER NOT NULL,
        spawn_y INTEGER NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE units (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES players(id),
        type TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        facing INTEGER NOT NULL,
        hp INTEGER NOT NULL,
        inventory TEXT NOT NULL,
        program_source TEXT NOT NULL,
        program_version INTEGER NOT NULL,
        program_state TEXT NOT NULL,
        program_error TEXT,
        updated_at TEXT
      );
      CREATE INDEX units_owner ON units(owner_id);
      CREATE TABLE buildings (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES players(id),
        type TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        w INTEGER NOT NULL,
        h INTEGER NOT NULL,
        hp INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        progress REAL NOT NULL,
        queue TEXT NOT NULL,
        prod_acc REAL NOT NULL,
        fertility REAL NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX buildings_owner ON buildings(owner_id);
      CREATE TABLE chunk_mods (
        cx INTEGER NOT NULL,
        cy INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT,
        PRIMARY KEY (cx, cy)
      );
      CREATE TABLE program_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        source TEXT NOT NULL,
        language_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT,
        UNIQUE (unit_id, version)
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tick INTEGER,
        player_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX audit_player ON audit_log(player_id);
    `,
  },
  {
    version: 2,
    name: "code library",
    sql: `
      CREATE TABLE library_programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES players(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        unit_types TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 0,
        latest_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );
      CREATE INDEX library_shared ON library_programs(shared);
      CREATE TABLE library_versions (
        program_id INTEGER NOT NULL REFERENCES library_programs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        source TEXT NOT NULL,
        language_version INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (program_id, version)
      );
      ALTER TABLE units ADD COLUMN program_library TEXT;
    `,
  },
  {
    version: 3,
    name: "territory, research, exploration",
    sql: `
      ALTER TABLE players ADD COLUMN techs TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE buildings ADD COLUMN completed_tick INTEGER;
      CREATE TABLE explored_chunks (
        player_id INTEGER NOT NULL REFERENCES players(id),
        cx INTEGER NOT NULL,
        cy INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        PRIMARY KEY (player_id, cx, cy)
      );
      CREATE TABLE territory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id),
        building_id INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        tiles INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX territory_events_player ON territory_events(player_id, tick);
    `,
  },
  {
    version: 4,
    name: "progression",
    sql: `
      ALTER TABLE players ADD COLUMN xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0);
      ALTER TABLE players ADD COLUMN talents TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    version: 5,
    name: "wildlife and discovery",
    sql: `
      -- Wild creatures belong to the reserved "Wildlife" owner (id 0), which cannot log in.
      INSERT OR IGNORE INTO accounts (id, name, token_hash, created_at) VALUES (0, '~wildlife', 'no-login:wildlife', '1970-01-01T00:00:00.000Z');
      INSERT OR IGNORE INTO players (id, race, wood, stone, gold, food, spawn_x, spawn_y) VALUES (0, 'wild', 0, 0, 0, 0, 0, 0);
      ALTER TABLE players ADD COLUMN discoveries TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE players ADD COLUMN observed TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE units ADD COLUMN learned TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE units ADD COLUMN home_x INTEGER;
      ALTER TABLE units ADD COLUMN home_y INTEGER;
      CREATE TABLE populated_chunks (
        cx INTEGER NOT NULL,
        cy INTEGER NOT NULL,
        PRIMARY KEY (cx, cy)
      );
      CREATE TABLE ruins_looted (
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        player_id INTEGER NOT NULL REFERENCES players(id),
        tick INTEGER NOT NULL,
        PRIMARY KEY (x, y)
      );
    `,
  },
  {
    version: 6,
    name: "optional combat",
    sql: `
      ALTER TABLE players ADD COLUMN pvp INTEGER NOT NULL DEFAULT 0 CHECK (pvp IN (0, 1));
      ALTER TABLE players ADD COLUMN pvp_until INTEGER;
    `,
  },
  {
    version: 7,
    name: "storage networks",
    sql: `
      -- Resources held by each storage building (only used when economy.storage is "networks").
      ALTER TABLE buildings ADD COLUMN stock TEXT NOT NULL DEFAULT '{"wood":0,"stone":0,"gold":0,"food":0}';
    `,
  },
  {
    version: 8,
    name: "heroes",
    sql: `
      -- The player's hero: living unit id, whether ever recruited, battle training ranks, deaths.
      ALTER TABLE players ADD COLUMN hero TEXT NOT NULL DEFAULT '{"unitId":null,"recruited":false,"ranks":{},"deaths":0}';
    `,
  },
  {
    version: 9,
    name: "coding lessons",
    sql: `
      -- Ids of completed coding lessons (JSON list).
      ALTER TABLE players ADD COLUMN lessons TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 10,
    name: "lairs, trophies and paddocks",
    sql: `
      -- Boss trophies won (JSON list of ids).
      ALTER TABLE players ADD COLUMN trophies TEXT NOT NULL DEFAULT '[]';
      -- Paddock an animal lives in (building id), or NULL.
      ALTER TABLE units ADD COLUMN pen_id INTEGER;
      -- Paddock production and breeding progress (JSON), NULL for other buildings.
      ALTER TABLE buildings ADD COLUMN pen TEXT;
      -- PvE lairs that have been woken. Lair positions come from the seed; only their state is stored.
      CREATE TABLE lairs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('active', 'cleared')),
        cleared_by INTEGER,
        cleared_tick INTEGER,
        respawn_tick INTEGER,
        claim_until INTEGER,
        updated_at TEXT
      );
    `,
  },
];
