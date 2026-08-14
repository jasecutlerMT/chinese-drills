import { getDb } from "./db";
import type { ErrorRow, TargetedWeakness } from "./types";

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 3,
  major: 2,
  minor: 1,
};

export const TARGETING_MIN_ERRORS = 10;
export const TARGETING_PROBABILITY = 0.4; // within the required 30–50% band

interface ScoredWeakness extends TargetedWeakness {
  score: number;
}

/**
 * Scores weaknesses over the last 50 errors:
 *   severity weight x recency decay / (1 + resolved_count)
 * summed per category and per specific target_item. Returns the top
 * candidates, strongest first. Recency decay halves every 15 errors of age.
 */
export function rankWeaknesses(limit = 3): ScoredWeakness[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM errors ORDER BY id DESC LIMIT 50")
    .all() as ErrorRow[];

  const byKey = new Map<string, ScoredWeakness>();
  rows.forEach((row, age) => {
    const weight =
      (SEVERITY_WEIGHT[row.severity] ?? 1) *
      Math.pow(0.5, age / 15) /
      (1 + row.resolved_count);

    const keys: { kind: "category" | "item"; value: string }[] = [];
    // 'other' is a catch-all (e.g. dictation mishearings) — as a category it
    // is not an actionable weakness, but its specific target_items are.
    if (row.error_category !== "other") {
      keys.push({ kind: "category", value: row.error_category });
    }
    if (row.target_item) {
      keys.push({ kind: "item", value: row.target_item });
    }
    for (const k of keys) {
      const mapKey = `${k.kind}:${k.value}`;
      const existing = byKey.get(mapKey);
      if (existing) {
        existing.score += weight;
        existing.error_ids.push(row.id);
      } else {
        byKey.set(mapKey, { ...k, score: weight, error_ids: [row.id] });
      }
    }
  });

  return [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function errorLogSize(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM errors").get() as { n: number };
  return row.n;
}

/** Decide whether the next task should target weaknesses, and which ones. */
export function pickTargeting(): TargetedWeakness[] {
  if (errorLogSize() < TARGETING_MIN_ERRORS) return [];
  if (Math.random() > TARGETING_PROBABILITY) return [];
  const top = rankWeaknesses(2).map(({ kind, value, error_ids }) => ({
    kind,
    value,
    error_ids,
  }));
  return top;
}

/**
 * Close the loop: after grading a targeted attempt, any targeted weakness
 * that produced NO matching new error gets its motivating log entries'
 * resolved_count incremented, so fixed weaknesses fade from the ranking.
 */
export function creditResolvedWeaknesses(
  targeted: TargetedWeakness[],
  newErrors: { error_category: string; target_item: string | null }[]
): void {
  const db = getDb();
  const bump = db.prepare("UPDATE errors SET resolved_count = resolved_count + 1 WHERE id = ?");
  for (const w of targeted) {
    const reoccurred = newErrors.some((e) =>
      w.kind === "category" ? e.error_category === w.value : e.target_item === w.value
    );
    if (!reoccurred) {
      for (const id of w.error_ids) bump.run(id);
    }
  }
}
