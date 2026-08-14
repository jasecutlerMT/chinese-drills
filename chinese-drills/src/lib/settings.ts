import { getDb } from "./db";
import type { AppSettings } from "./types";

const DEFAULTS: AppSettings = {
  default_lesson_start: 6,
  default_lesson_end: 10,
  daily_rep_target: 10,
  difficulty: 3,
  tts_voice: "xiaoxiao",
  srs_new_per_day: 20,
  srs_max_reviews: 200,
  srs_directions: "both",
  srs_include_characters: true,
};

export function getSettings(): AppSettings {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    default_lesson_start: intOr(stored.default_lesson_start, DEFAULTS.default_lesson_start),
    default_lesson_end: intOr(stored.default_lesson_end, DEFAULTS.default_lesson_end),
    daily_rep_target: intOr(stored.daily_rep_target, DEFAULTS.daily_rep_target),
    difficulty: intOr(stored.difficulty, DEFAULTS.difficulty),
    tts_voice: stored.tts_voice === "yunxi" ? "yunxi" : "xiaoxiao",
    srs_new_per_day: intOr(stored.srs_new_per_day, DEFAULTS.srs_new_per_day),
    srs_max_reviews: intOr(stored.srs_max_reviews, DEFAULTS.srs_max_reviews),
    srs_directions: stored.srs_directions === "recognize" ? "recognize" : "both",
    srs_include_characters: stored.srs_include_characters !== "0",
  };
}

export function setSetting(key: keyof AppSettings, value: number | string | boolean): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
}

function intOr(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
