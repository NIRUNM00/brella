import Database from "better-sqlite3";

let db: Database.Database | null = null;
let currentPath: string | null = null;
let lastExplicitPath: string | null = null;

export function getDb(dbPath?: string): Database.Database {
  const resolved = dbPath ?? lastExplicitPath ?? process.cwd() + "/brella.db";

  // If path differs from current, close and reopen
  if (db && currentPath !== null && resolved !== currentPath) {
    db.close();
    db = null;
    currentPath = null;
  }

  if (db) return db;

  // Track the last explicitly requested path so internal callers (no arg)
  // stay within the same DB session
  if (dbPath) lastExplicitPath = resolved;

  currentPath = resolved;
  db = new Database(resolved);

  // Enable WAL for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run migrations (inline SQL)
  db.exec(`-- Brella 跨批次记忆
-- SQLite schema v1

CREATE TABLE IF NOT EXISTS seed_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL CHECK(action IN ('accept', 'reject', 'skip')),
    note TEXT DEFAULT '',
    batch_tag TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seed_pref_seed ON seed_preferences(seed);
CREATE INDEX IF NOT EXISTS idx_seed_pref_prompt ON seed_preferences(prompt);
CREATE INDEX IF NOT EXISTS idx_seed_pref_batch ON seed_preferences(batch_tag);

CREATE TABLE IF NOT EXISTS prompt_archetypes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_hash TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    archetype TEXT NOT NULL DEFAULT '',
    preferred_seeds TEXT DEFAULT '[]',  -- JSON array of seeds
    rejected_seeds TEXT DEFAULT '[]',
    total_judgments INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_archetype_type ON prompt_archetypes(archetype);

CREATE TABLE IF NOT EXISTS image_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    cfg REAL NOT NULL DEFAULT 7.0,
    model TEXT NOT NULL DEFAULT '',
    batch_tag TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(seed, prompt, batch_tag)
);

CREATE INDEX IF NOT EXISTS idx_meta_seed ON image_metadata(seed);
CREATE INDEX IF NOT EXISTS idx_meta_batch ON image_metadata(batch_tag);

CREATE TABLE IF NOT EXISTS wilson_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    ups INTEGER NOT NULL DEFAULT 0,      -- accept count
    downs INTEGER NOT NULL DEFAULT 0,    -- reject count
    score REAL NOT NULL DEFAULT 0.5,     -- Wilson lower bound
    confidence REAL NOT NULL DEFAULT 0,  -- total judgments
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(seed, prompt, model)
);

CREATE INDEX IF NOT EXISTS idx_wilson_score ON wilson_scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_wilson_seed ON wilson_scores(seed);
`);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentPath = null;
    lastExplicitPath = null;
  }
}
