import type Database from "better-sqlite3";
import path from "path";
import fs from "fs";

/** The open connection. The driver itself is loaded lazily — see open(). */
type Db = Database.Database;

/**
 * What a learner sees when the compiled SQLite binary won't load. The real
 * message is a dyld trace naming mach-o architectures and absolute paths,
 * which tells them nothing they can act on — and it used to reach the screen
 * verbatim, because importing the driver at module scope threw while the route
 * was still being loaded, too early for anything to catch it.
 */
const DRIVER_UNUSABLE =
  "The app's database component doesn't match the version of Node.js running it. " +
  "Quit Chinese Drills and open it again — it repairs this automatically. " +
  "If it keeps happening, send me launch-log.txt from the app's folder.";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  local_date     TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','micro','dictation')),
  parent_attempt_id INTEGER REFERENCES attempts(id),
  lesson_start   INTEGER NOT NULL,
  lesson_end     INTEGER NOT NULL,
  task_size      TEXT NOT NULL CHECK (task_size IN ('sentence','three_sentences','paragraph')),
  task_prompt    TEXT NOT NULL,
  target_vocab   TEXT NOT NULL,
  target_grammar TEXT NOT NULL,
  targeted       INTEGER NOT NULL DEFAULT 0,
  targeted_weaknesses TEXT,
  my_text        TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  what_worked    TEXT NOT NULL,
  overall_score  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id         INTEGER NOT NULL REFERENCES attempts(id),
  created_at         TEXT NOT NULL,
  module             TEXT NOT NULL DEFAULT 'composition',
  error_category     TEXT NOT NULL CHECK (error_category IN
    ('word_choice','word_order','grammar_pattern','measure_word',
     'particle','collocation','register','missing_structure','other')),
  target_item        TEXT,
  my_fragment        TEXT NOT NULL,
  corrected_fragment TEXT NOT NULL,
  explanation_short  TEXT NOT NULL,
  severity           TEXT NOT NULL CHECK (severity IN ('critical','major','minor')),
  resolved_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_errors_category ON errors(error_category, created_at);
CREATE INDEX IF NOT EXISTS idx_errors_item ON errors(target_item, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_date ON attempts(local_date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Tells a broken compiled driver apart from a broken database. They need
 * opposite answers — reopening the app repairs the first and does nothing for
 * the second — so a damaged drills.db must not be met with advice about Node
 * versions.
 */
function isDriverLoadFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /dlopen|mach-o|incompatible architecture|NODE_MODULE_VERSION|invalid ELF|file too short|bindings file|not a valid Win32|\.node\b/i.test(
    message
  );
}

function open(): Db {
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // Loaded here rather than imported at the top so a failure lands inside a
  // try/catch we control. better-sqlite3 is in serverExternalPackages, so this
  // stays a real runtime require.
  //
  // Both steps are inside the try because the package opens its compiled
  // binary lazily: requiring it succeeds even when the binary cannot run here,
  // and it is the constructor that actually fails.
  let db: Db;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Driver = require("better-sqlite3") as new (filename: string) => Db;
    db = new Driver(path.join(dataDir, "drills.db"));
  } catch (err) {
    if (!isDriverLoadFailure(err)) throw err;
    console.error("[db] the SQLite driver failed to load:", err);
    throw new Error(DRIVER_UNUSABLE);
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrateAttemptsKind(db);
  return db;
}

/**
 * Databases created before dictation mode have a CHECK constraint that only
 * allows kind IN ('task','micro'). SQLite can't alter constraints, so rebuild
 * the table once (SQLite's documented 12-step migration, FKs off during).
 */
function migrateAttemptsKind(db: Db): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("dictation")) return;

  console.log("[db] migrating attempts table to allow dictation reps…");
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE attempts_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at     TEXT NOT NULL,
        local_date     TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','micro','dictation')),
        parent_attempt_id INTEGER REFERENCES attempts(id),
        lesson_start   INTEGER NOT NULL,
        lesson_end     INTEGER NOT NULL,
        task_size      TEXT NOT NULL CHECK (task_size IN ('sentence','three_sentences','paragraph')),
        task_prompt    TEXT NOT NULL,
        target_vocab   TEXT NOT NULL,
        target_grammar TEXT NOT NULL,
        targeted       INTEGER NOT NULL DEFAULT 0,
        targeted_weaknesses TEXT,
        my_text        TEXT NOT NULL,
        corrected_text TEXT NOT NULL,
        what_worked    TEXT NOT NULL,
        overall_score  INTEGER NOT NULL
      );
    `);
    db.exec("INSERT INTO attempts_new SELECT * FROM attempts");
    db.exec("DROP TABLE attempts");
    db.exec("ALTER TABLE attempts_new RENAME TO attempts");
    db.exec("CREATE INDEX IF NOT EXISTS idx_attempts_date ON attempts(local_date)");
  })();
  db.pragma("foreign_keys = ON");
  console.log("[db] migration done");
}

// Singleton survives Next.js dev-mode hot reloads.
const globalForDb = globalThis as unknown as { __drillsDb?: Db };

export function getDb(): Db {
  if (!globalForDb.__drillsDb) {
    globalForDb.__drillsDb = open();
  }
  return globalForDb.__drillsDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Server-local calendar date, drives streak and daily rep count. */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
