import { getDb, nowIso } from "./db";
import type { TranslateDirection } from "./prompts";

export interface TranslationRow {
  id: number;
  created_at: string;
  input: string;
  translation: string;
  pinyin: string | null;
  direction: TranslateDirection;
  source: "claude" | "dictionary";
}

function ensure(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS translations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL,
      input       TEXT NOT NULL,
      translation TEXT NOT NULL,
      pinyin      TEXT,
      direction   TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'claude'
    );
  `);
}

export function recordTranslation(
  row: Omit<TranslationRow, "id" | "created_at">
): void {
  ensure();
  const db = getDb();
  // Collapse repeats of the same input in the same direction — the same
  // sentence translated to Mandarin and to Cantonese are two useful rows, not
  // one replacing the other.
  db.prepare("DELETE FROM translations WHERE input = ? AND direction = ?").run(
    row.input,
    row.direction
  );
  db.prepare(
    `INSERT INTO translations (created_at, input, translation, pinyin, direction, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(nowIso(), row.input, row.translation, row.pinyin, row.direction, row.source);
  db.prepare(
    "DELETE FROM translations WHERE id NOT IN (SELECT id FROM translations ORDER BY id DESC LIMIT 30)"
  ).run();
}

export function recentTranslations(limit = 8): TranslationRow[] {
  ensure();
  return getDb()
    .prepare("SELECT * FROM translations ORDER BY id DESC LIMIT ?")
    .all(limit) as TranslationRow[];
}
