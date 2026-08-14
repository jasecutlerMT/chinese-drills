import { localDate } from "./db";
import { bestEntryFor, type SearchResult } from "./dict";
import { getLessonRange, getLessons } from "./lessons";
import { getSettings } from "./settings";
import type { VocabItem } from "./types";

function dayHash(salt: string): number {
  const s = localDate() + salt;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Deterministic "word of the day": same word all day, new word tomorrow.
 * Drawn from every lesson in the data — the pool follows the textbooks rather
 * than a hardcoded range, so the 693 Level 2 words are eligible too — and
 * joined to its dictionary entry for the full set of senses.
 */
export function wordOfTheDay(): SearchResult | null {
  const pool = getLessons().flatMap((l) => l.vocab);
  if (pool.length === 0) return null;
  // Walk from the day's pick until a vocab item has a dictionary entry.
  const start = dayHash("wotd") % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const entry = bestEntryFor(pool[(start + i) % pool.length].hanzi);
    if (entry) return entry;
  }
  return null;
}

/** A daily rotating handful of vocabulary from the user's lesson range. */
export function lessonPicks(count = 6): VocabItem[] {
  const settings = getSettings();
  const pool = getLessonRange(settings.default_lesson_start, settings.default_lesson_end).flatMap(
    (l) => l.vocab
  );
  if (pool.length === 0) return [];
  const picks: VocabItem[] = [];
  const seen = new Set<number>();
  let h = dayHash("lessons");
  for (let i = 0; i < count && seen.size < pool.length; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    let idx = h % pool.length;
    while (seen.has(idx)) idx = (idx + 1) % pool.length;
    seen.add(idx);
    picks.push(pool[idx]);
  }
  return picks;
}
