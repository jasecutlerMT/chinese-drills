import { getDb, nowIso, localDate } from "./db";
import { getSettings } from "./settings";

export type Rating = "again" | "hard" | "good" | "easy";
export type CardState = "new" | "learning" | "review" | "relearning" | "suspended";
export type Direction = "recognize" | "produce";

export interface SrsCard {
  id: number;
  vocab_key: string;
  direction: Direction;
  book: string;
  lesson: number;
  hanzi: string;
  pinyin: string;
  english: string;
  pos: string | null;
  state: CardState;
  step: number;
  due_at: string | null;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_rating: string | null;
  last_reviewed_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS srs_cards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vocab_key     TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('recognize','produce')),
  book          TEXT NOT NULL,
  lesson        INTEGER NOT NULL,
  hanzi         TEXT NOT NULL,
  pinyin        TEXT NOT NULL,
  english       TEXT NOT NULL,
  pos           TEXT,
  state         TEXT NOT NULL DEFAULT 'new'
                  CHECK (state IN ('new','learning','review','relearning','suspended')),
  step          INTEGER NOT NULL DEFAULT 0,
  due_at        TEXT,
  interval_days REAL NOT NULL DEFAULT 0,
  ease          REAL NOT NULL DEFAULT 2.5,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  last_rating   TEXT,
  last_reviewed_at TEXT,
  UNIQUE (vocab_key, direction)
);
CREATE INDEX IF NOT EXISTS idx_srs_queue ON srs_cards(state, due_at);
CREATE INDEX IF NOT EXISTS idx_srs_lesson ON srs_cards(lesson, id);

CREATE TABLE IF NOT EXISTS srs_reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES srs_cards(id),
  reviewed_at     TEXT NOT NULL,
  local_date      TEXT NOT NULL,
  rating          TEXT NOT NULL,
  state_before    TEXT NOT NULL,
  interval_before REAL NOT NULL,
  interval_after  REAL NOT NULL,
  ms              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_srs_reviews_date ON srs_reviews(local_date);
`;

let ensured = false;
export function ensureSrs(): void {
  if (ensured) return;
  getDb().exec(SCHEMA);
  migrateVocabKeys();
  ensured = true;
}

/**
 * Cards used to be identified by "characters|pinyin", which meant fixing a
 * typo in the textbook data orphaned the card and silently started the word
 * over. Identity is now the characters alone. Runs once per database.
 */
function migrateVocabKeys(): void {
  const db = getDb();
  const stale = db
    .prepare("SELECT COUNT(*) AS n FROM srs_cards WHERE vocab_key LIKE '%|%'")
    .get() as { n: number };
  if (!stale.n) return;

  const rows = db
    .prepare(
      `SELECT id, hanzi, direction FROM srs_cards
       ORDER BY CASE state
                  WHEN 'review' THEN 0 WHEN 'relearning' THEN 1
                  WHEN 'learning' THEN 2 WHEN 'new' THEN 3 ELSE 4 END,
                reps DESC, id ASC`
    )
    .all() as { id: number; hanzi: string; direction: string }[];

  const rekey = db.prepare("UPDATE srs_cards SET vocab_key = ? WHERE id = ?");
  const dropCard = db.prepare("DELETE FROM srs_cards WHERE id = ?");
  const dropReviews = db.prepare("DELETE FROM srs_reviews WHERE card_id = ?");

  db.transaction(() => {
    const kept = new Set<string>();
    for (const row of rows) {
      const slot = `${row.hanzi}::${row.direction}`;
      // Two readings of one character used to be two cards; keep the one
      // that's furthest along and retire its twin.
      if (kept.has(slot)) {
        dropReviews.run(row.id);
        dropCard.run(row.id);
        continue;
      }
      kept.add(slot);
      rekey.run(row.hanzi, row.id);
    }
  })();
}

// ---------- scheduler (SM-2, Anki defaults) ----------

const LEARNING_STEPS_MIN = [1, 10];
const RELEARN_STEPS_MIN = [10];
const GRADUATING_INTERVAL = 1;
const EASY_INTERVAL = 4;
const MIN_EASE = 1.3;
const MAX_INTERVAL = 1095; // three years
const HARD_MULTIPLIER = 1.2;
const EASY_BONUS = 1.3;
const LAPSE_MULTIPLIER = 0; // Anki's default "new interval" after a lapse

export interface Scheduled {
  state: CardState;
  step: number;
  interval_days: number;
  ease: number;
  dueInMinutes: number;
}

function clampInterval(days: number): number {
  return Math.min(MAX_INTERVAL, Math.max(1, days));
}

/** ±5% jitter so cards learned together don't clump forever. */
function fuzz(days: number): number {
  if (days < 2.5) return days;
  const spread = days * 0.05;
  return clampInterval(Math.round(days + (Math.random() * 2 - 1) * spread));
}

/**
 * Pure SM-2 step: what happens to this card at this rating. Used both to
 * apply a review and to preview the four intervals on the buttons.
 */
export function schedule(
  card: Pick<SrsCard, "state" | "step" | "interval_days" | "ease" | "lapses">,
  rating: Rating,
  withFuzz = true
): Scheduled {
  const jitter = withFuzz ? fuzz : (d: number) => clampInterval(d);
  let ease = card.ease;

  // New and learning cards walk the learning steps.
  if (card.state === "new" || card.state === "learning") {
    const steps = LEARNING_STEPS_MIN;
    if (rating === "again") {
      return { state: "learning", step: 0, interval_days: 0, ease, dueInMinutes: steps[0] };
    }
    if (rating === "hard") {
      const step = Math.min(card.step, steps.length - 1);
      // On the first step, Hard has to mean something other than Again, or two
      // of the four buttons do the same thing. Anki's answer: halfway between
      // this step and the next — 1m and 10m give ~6m.
      const delay =
        step === 0 && steps.length > 1 ? Math.round((steps[0] + steps[1]) / 2) : steps[step];
      return { state: "learning", step, interval_days: 0, ease, dueInMinutes: delay };
    }
    if (rating === "easy") {
      return {
        state: "review",
        step: 0,
        interval_days: EASY_INTERVAL,
        ease,
        dueInMinutes: EASY_INTERVAL * 1440,
      };
    }
    // good
    const next = card.step + 1;
    if (next >= steps.length) {
      return {
        state: "review",
        step: 0,
        interval_days: GRADUATING_INTERVAL,
        ease,
        dueInMinutes: GRADUATING_INTERVAL * 1440,
      };
    }
    return { state: "learning", step: next, interval_days: 0, ease, dueInMinutes: steps[next] };
  }

  // Relearning after a lapse.
  if (card.state === "relearning") {
    if (rating === "again") {
      return {
        state: "relearning",
        step: 0,
        interval_days: card.interval_days,
        ease,
        dueInMinutes: RELEARN_STEPS_MIN[0],
      };
    }
    if (rating === "hard") {
      return {
        state: "relearning",
        step: card.step,
        interval_days: card.interval_days,
        ease,
        dueInMinutes: RELEARN_STEPS_MIN[Math.min(card.step, RELEARN_STEPS_MIN.length - 1)],
      };
    }
    const days = jitter(clampInterval(card.interval_days || GRADUATING_INTERVAL));
    return { state: "review", step: 0, interval_days: days, ease, dueInMinutes: days * 1440 };
  }

  // Review cards.
  if (rating === "again") {
    ease = Math.max(MIN_EASE, ease - 0.2);
    return {
      state: "relearning",
      step: 0,
      interval_days: clampInterval(card.interval_days * LAPSE_MULTIPLIER),
      ease,
      dueInMinutes: RELEARN_STEPS_MIN[0],
    };
  }
  if (rating === "hard") {
    ease = Math.max(MIN_EASE, ease - 0.15);
    const days = jitter(clampInterval(card.interval_days * HARD_MULTIPLIER));
    return { state: "review", step: 0, interval_days: days, ease, dueInMinutes: days * 1440 };
  }
  if (rating === "easy") {
    ease = ease + 0.15;
    const days = jitter(clampInterval(card.interval_days * ease * EASY_BONUS));
    return { state: "review", step: 0, interval_days: days, ease, dueInMinutes: days * 1440 };
  }
  // good
  const days = jitter(clampInterval(card.interval_days * ease));
  return { state: "review", step: 0, interval_days: days, ease, dueInMinutes: days * 1440 };
}

/** "10m", "1d", "3.5mo" — the interval labels on the rating buttons. */
export function formatInterval(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  const days = minutes / 1440;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30.4).toFixed(days < 90 ? 1 : 0)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function previewIntervals(card: SrsCard): Record<Rating, string> {
  const ratings: Rating[] = ["again", "hard", "good", "easy"];
  const out = {} as Record<Rating, string>;
  for (const r of ratings) {
    out[r] = formatInterval(schedule(card, r, false).dueInMinutes);
  }
  return out;
}

// ---------- deck scope ----------

export interface Scope {
  books: string[]; // empty = all
  lessonStart?: number;
  lessonEnd?: number;
}

function scopeClause(scope: Scope): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (scope.books.length > 0) {
    parts.push(`book IN (${scope.books.map(() => "?").join(",")})`);
    params.push(...scope.books);
  }
  if (typeof scope.lessonStart === "number") {
    parts.push("lesson >= ?");
    params.push(scope.lessonStart);
  }
  if (typeof scope.lessonEnd === "number") {
    parts.push("lesson <= ?");
    params.push(scope.lessonEnd);
  }
  return { sql: parts.length ? `AND ${parts.join(" AND ")}` : "", params };
}

// ---------- daily counts ----------

export interface DeckCounts {
  newCards: number;
  learning: number;
  due: number;
  /** Every card in scope, including ones still locked behind a sibling. */
  total: number;
  locked: number;
  studied: number;
  mature: number;
  young: number;
  /** Counted across the whole deck, not the current scope — see idleReason(). */
  newRemainingToday: number;
  reviewRemainingToday: number;
  reviewCapPerDay: number;
  newCapPerDay: number;
}

export function deckCounts(scope: Scope): DeckCounts {
  ensureSrs();
  const db = getDb();
  const settings = getSettings();
  const { sql, params } = scopeClause(scope);
  const now = nowIso();
  const today = localDate();

  // Totals count every card in scope — including ones still locked — so the
  // progress denominator doesn't creep upward as cards unlock.
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END) AS newCards,
         SUM(CASE WHEN state IN ('learning','relearning') THEN 1 ELSE 0 END) AS learning,
         SUM(CASE WHEN state = 'review' AND due_at <= ? THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN state = 'review' AND interval_days >= 21 THEN 1 ELSE 0 END) AS mature,
         SUM(CASE WHEN state = 'review' AND interval_days < 21 THEN 1 ELSE 0 END) AS young,
         SUM(CASE WHEN state NOT IN ('new','suspended') THEN 1 ELSE 0 END) AS studied,
         SUM(CASE WHEN state = 'suspended' THEN 1 ELSE 0 END) AS locked,
         COUNT(*) AS total
       FROM srs_cards WHERE 1 = 1 ${sql}`
    )
    .get(now, ...params) as Record<string, number | null>;

  const introducedToday = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT card_id) AS n FROM srs_reviews
         WHERE local_date = ? AND state_before = 'new'`
      )
      .get(today) as { n: number }
  ).n;
  const reviewsToday = (
    db
      .prepare(
        // Per card, not per press: a card you lapse and redo several times
        // is one review's worth of the daily allowance, not four.
        `SELECT COUNT(DISTINCT card_id) AS n FROM srs_reviews
         WHERE local_date = ? AND state_before IN ('review','relearning')`
      )
      .get(today) as { n: number }
  ).n;

  return {
    newCards: row.newCards ?? 0,
    learning: row.learning ?? 0,
    due: row.due ?? 0,
    total: row.total ?? 0,
    locked: row.locked ?? 0,
    studied: row.studied ?? 0,
    mature: row.mature ?? 0,
    young: row.young ?? 0,
    newRemainingToday: Math.max(0, settings.srs_new_per_day - introducedToday),
    reviewRemainingToday: Math.max(0, settings.srs_max_reviews - reviewsToday),
    reviewCapPerDay: settings.srs_max_reviews,
    newCapPerDay: settings.srs_new_per_day,
  };
}

// ---------- the queue ----------

/**
 * The next card to show, Anki-style: learning cards that have come due,
 * then due reviews and new cards mixed together, all inside the daily caps.
 */
export function nextCard(scope: Scope): SrsCard | null {
  ensureSrs();
  const db = getDb();
  const { sql, params } = scopeClause(scope);
  const now = nowIso();
  const counts = deckCounts(scope);

  // 1. Learning/relearning cards that are due right now.
  const learning = db
    .prepare(
      `SELECT * FROM srs_cards
       WHERE state IN ('learning','relearning') AND due_at <= ? ${sql}
       ORDER BY due_at LIMIT 1`
    )
    .get(now, ...params) as SrsCard | undefined;
  if (learning) return learning;

  const reviewAvailable = counts.due > 0 && counts.reviewRemainingToday > 0;
  const newAvailable = counts.newCards > 0 && counts.newRemainingToday > 0;

  // 2. Mix new cards into reviews rather than front-loading either.
  const preferNew =
    newAvailable && (!reviewAvailable || Math.random() < 1 / 4);

  if (preferNew) {
    const card = db
      .prepare(
        `SELECT * FROM srs_cards WHERE state = 'new' ${sql}
         ORDER BY lesson, id LIMIT 1`
      )
      .get(...params) as SrsCard | undefined;
    if (card) return card;
  }
  if (reviewAvailable) {
    const card = db
      .prepare(
        `SELECT * FROM srs_cards WHERE state = 'review' AND due_at <= ? ${sql}
         ORDER BY due_at LIMIT 1`
      )
      .get(now, ...params) as SrsCard | undefined;
    if (card) return card;
  }
  if (newAvailable) {
    const card = db
      .prepare(
        `SELECT * FROM srs_cards WHERE state = 'new' ${sql}
         ORDER BY lesson, id LIMIT 1`
      )
      .get(...params) as SrsCard | undefined;
    if (card) return card;
  }

  // 3. Nothing due now — report the soonest upcoming learning card so the UI
  //    can offer a short wait instead of claiming the deck is finished.
  return null;
}

/**
 * Why there is no card to show. The daily allowances are deliberately counted
 * across the whole deck rather than per book — otherwise switching to another
 * book would hand out a fresh 20 new cards and the limit would mean nothing —
 * so a book can show cards waiting and still serve none. The UI has to be able
 * to say which of those two things happened.
 */
export function idleReason(scope: Scope): "capped" | "waiting" | "empty" | "done" {
  ensureSrs();
  const counts = deckCounts(scope);
  if (counts.total === 0) return "empty";
  if (
    (counts.due > 0 && counts.reviewRemainingToday === 0) ||
    (counts.newCards > 0 && counts.newRemainingToday === 0)
  ) {
    return "capped";
  }
  if (secondsUntilNextLearning(scope) !== null) return "waiting";
  return "done";
}

/** Seconds until the next learning card comes due (null if none pending). */
export function secondsUntilNextLearning(scope: Scope): number | null {
  ensureSrs();
  const db = getDb();
  const { sql, params } = scopeClause(scope);
  const row = db
    .prepare(
      `SELECT due_at FROM srs_cards
       WHERE state IN ('learning','relearning') ${sql}
       ORDER BY due_at LIMIT 1`
    )
    .get(...params) as { due_at: string } | undefined;
  if (!row?.due_at) return null;
  return Math.max(0, Math.round((new Date(row.due_at).getTime() - Date.now()) / 1000));
}

// ---------- applying a review ----------

export function rateCard(cardId: number, rating: Rating, ms?: number): SrsCard | null {
  ensureSrs();
  const db = getDb();
  const card = db.prepare("SELECT * FROM srs_cards WHERE id = ?").get(cardId) as
    | SrsCard
    | undefined;
  if (!card) return null;

  const next = schedule(card, rating);
  const dueAt = new Date(Date.now() + next.dueInMinutes * 60_000).toISOString();
  const lapses = card.lapses + (card.state === "review" && rating === "again" ? 1 : 0);

  db.transaction(() => {
    db.prepare(
      `UPDATE srs_cards SET state = ?, step = ?, due_at = ?, interval_days = ?, ease = ?,
         reps = reps + 1, lapses = ?, last_rating = ?, last_reviewed_at = ?
       WHERE id = ?`
    ).run(
      next.state,
      next.step,
      dueAt,
      next.interval_days,
      next.ease,
      lapses,
      rating,
      nowIso(),
      cardId
    );
    db.prepare(
      `INSERT INTO srs_reviews
         (card_id, reviewed_at, local_date, rating, state_before, interval_before, interval_after, ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      cardId,
      nowIso(),
      localDate(),
      rating,
      card.state,
      card.interval_days,
      next.interval_days,
      ms ?? null
    );

    // Once a word is recognised reliably, unlock writing it from the English —
    // unless the user asked for recognition cards only, in which case those
    // production cards are suspended on purpose and must stay that way.
    if (
      next.state === "review" &&
      card.direction === "recognize" &&
      getSettings().srs_directions === "both"
    ) {
      db.prepare(
        `UPDATE srs_cards SET state = 'new'
         WHERE vocab_key = ? AND direction = 'produce' AND state = 'suspended'`
      ).run(card.vocab_key);
    }
  })();

  return db.prepare("SELECT * FROM srs_cards WHERE id = ?").get(cardId) as SrsCard;
}

// ---------- deck building ----------

export interface VocabSeed {
  hanzi: string;
  pinyin: string;
  english: string;
  pos?: string;
  book: string;
  lesson: number;
  /** Single characters are only ever tested by sight, never English → character. */
  recognizeOnly?: boolean;
}

/**
 * Creates one recognition card and one production card per word. Production
 * cards start suspended and unlock when the recognition card graduates.
 * Idempotent: re-running adds only what's new and refreshes the wording of
 * what's already there — cards are keyed by characters alone, so correcting a
 * word's pinyin, meaning or lesson updates the card and keeps its schedule.
 */
/**
 * A card's identity. Characters alone, so correcting a reading or a meaning
 * updates the card in place — except where the same characters are taught
 * twice with different readings, which Integrated Chinese does for 得 de and
 * děi, 长 cháng and zhǎng, 教 jiāo and jiào. Those need to stay two cards, and
 * the lesson separates them: a correction changes a reading, it does not move
 * the word to another lesson.
 */
function vocabKeys(items: VocabSeed[]): Map<VocabSeed, string> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.hanzi, (counts.get(item.hanzi) ?? 0) + 1);
  const keys = new Map<VocabSeed, string>();
  for (const item of items) {
    keys.set(item, counts.get(item.hanzi)! > 1 ? `${item.hanzi}#${item.lesson}` : item.hanzi);
  }
  return keys;
}

export function buildDeck(items: VocabSeed[]): {
  created: number;
  updated: number;
  retired: number;
  revived: number;
} {
  ensureSrs();
  const db = getDb();
  const both = getSettings().srs_directions === "both";
  const keys = vocabKeys(items);
  const liveKeys = new Set(keys.values());
  let created = 0;
  let updated = 0;
  let revived = 0;

  const find = db.prepare(
    "SELECT id, state FROM srs_cards WHERE vocab_key = ? AND direction = ?"
  );
  // Adding or removing a second reading changes a word's key shape — 得 becomes
  // 得#6 the moment 得 děi is also taught in lesson 12. The card underneath is
  // the same card, so it is adopted by its characters and lesson rather than
  // orphaned and rebuilt from zero.
  const findByPlace = db.prepare(
    "SELECT id, state, vocab_key FROM srs_cards WHERE hanzi = ? AND lesson = ? AND direction = ?"
  );
  const rekey = db.prepare("UPDATE srs_cards SET vocab_key = ? WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO srs_cards (vocab_key, direction, book, lesson, hanzi, pinyin, english, pos, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const refresh = db.prepare(
    `UPDATE srs_cards SET book = ?, lesson = ?, hanzi = ?, pinyin = ?, english = ?, pos = ?
     WHERE id = ?`
  );
  // A card coming back out of retirement resumes where it left off. Its stats
  // survived suspension, so a word that was on a 30-day interval returns to
  // review on that interval rather than restarting as if never seen.
  const revive = db.prepare(
    `UPDATE srs_cards
        SET state = CASE
              WHEN reps > 0 AND interval_days > 0 AND due_at IS NOT NULL THEN 'review'
              WHEN reps > 0 THEN 'learning'
              ELSE 'new'
            END
      WHERE id = ?`
  );

  let retired = 0;
  db.transaction(() => {
    // Turning "write it" cards off puts untouched ones back in the box;
    // anything already being learned keeps its schedule.
    if (!both) {
      db.prepare(
        "UPDATE srs_cards SET state = 'suspended' WHERE direction = 'produce' AND state = 'new'"
      ).run();
    }

    db.exec("CREATE TEMP TABLE IF NOT EXISTS live_keys (vocab_key TEXT PRIMARY KEY)");
    db.exec("DELETE FROM live_keys");
    const remember = db.prepare("INSERT OR IGNORE INTO live_keys (vocab_key) VALUES (?)");

    for (const item of items) {
      const key = keys.get(item)!;
      remember.run(key);
      const directions: Direction[] =
        both && !item.recognizeOnly ? ["recognize", "produce"] : ["recognize"];
      for (const direction of directions) {
        let existing = find.get(key, direction) as { id: number; state: CardState } | undefined;
        if (!existing) {
          const stray = findByPlace.get(item.hanzi, item.lesson, direction) as
            | { id: number; state: CardState; vocab_key: string }
            | undefined;
          // Only adopt a card no other word in this build lays claim to.
          if (stray && !liveKeys.has(stray.vocab_key)) {
            rekey.run(key, stray.id);
            existing = { id: stray.id, state: stray.state };
          }
        }
        if (existing) {
          refresh.run(
            item.book,
            item.lesson,
            item.hanzi,
            item.pinyin,
            item.english,
            item.pos ?? null,
            existing.id
          );
          updated++;
          // A word that was retired and has come back is teachable again.
          // Only recognition cards: a suspended production card may be the
          // user's "Recognise only" setting, which is not ours to undo.
          if (existing.state === "suspended" && direction === "recognize") {
            revive.run(existing.id);
            revived++;
          }
        } else {
          insert.run(
            key,
            direction,
            item.book,
            item.lesson,
            item.hanzi,
            item.pinyin,
            item.english,
            item.pos ?? null,
            direction === "produce" ? "suspended" : "new"
          );
          created++;
        }
      }
    }

    // Words that have left the textbook data stop being taught. They are
    // suspended rather than deleted: someone trimming lessons.json to focus on
    // one book must not lose months of scheduling, and a card that comes back
    // is revived above with its history intact.
    retired = db
      .prepare(
        `UPDATE srs_cards SET state = 'suspended'
         WHERE state != 'suspended'
           AND vocab_key NOT IN (SELECT vocab_key FROM live_keys)`
      )
      .run().changes;
    db.exec("DROP TABLE IF EXISTS live_keys");
  })();

  return { created, updated, retired, revived };
}

/**
 * Words the learner is currently wrestling with in the flashcard deck:
 * lapsed or still-learning cards inside a lesson range. Writing practice
 * pulls from these so the two halves of the app reinforce each other.
 */
export function strugglingWords(
  lessonStart: number,
  lessonEnd: number,
  limit = 6
): { hanzi: string; pinyin: string; english: string }[] {
  ensureSrs();
  return getDb()
    .prepare(
      `SELECT DISTINCT hanzi, pinyin, english FROM srs_cards
       WHERE lesson BETWEEN ? AND ?
         AND (lapses >= 2 OR state IN ('learning','relearning'))
         AND state != 'suspended'
       ORDER BY lapses DESC, last_reviewed_at DESC
       LIMIT ?`
    )
    .all(lessonStart, lessonEnd, limit) as {
    hanzi: string;
    pinyin: string;
    english: string;
  }[];
}

// ---------- stats ----------

export interface SrsStats {
  reviewsToday: number;
  correctToday: number;
  streakDays: number;
  forecast: { date: string; count: number }[];
  perBook: { book: string; total: number; studied: number; mature: number }[];
  leeches: { hanzi: string; pinyin: string; english: string; lapses: number }[];
}

export function srsStats(): SrsStats {
  ensureSrs();
  const db = getDb();
  const today = localDate();

  const todayRow = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN rating != 'again' THEN 1 ELSE 0 END) AS ok
       FROM srs_reviews WHERE local_date = ?`
    )
    .get(today) as { n: number; ok: number | null };

  const days = db
    .prepare("SELECT DISTINCT local_date FROM srs_reviews ORDER BY local_date DESC LIMIT 400")
    .all() as { local_date: string }[];
  const daySet = new Set(days.map((d) => d.local_date));
  let streakDays = 0;
  const cursor = new Date();
  if (!daySet.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (daySet.has(localDate(cursor))) {
    streakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // How many cards fall due on each of the next 14 days. Everything already
  // overdue is folded into today, which is where you'd actually see it.
  const dueByDay = new Map<string, number>();
  (
    db
      .prepare(
        // Bucket by the LOCAL calendar day: due_at is stored in UTC but the
        // bars below are labelled with local dates, and studying in the evening
        // west of Greenwich would otherwise plot tomorrow's cards a day late.
        `SELECT date(due_at, 'localtime') AS day, COUNT(*) AS n FROM srs_cards
         WHERE state IN ('review','relearning') AND due_at IS NOT NULL
         GROUP BY day`
      )
      .all() as { day: string; n: number }[]
  ).forEach((r) => dueByDay.set(r.day, r.n));

  const forecast: { date: string; count: number }[] = [];
  const base = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const key = localDate(d);
    let count = dueByDay.get(key) ?? 0;
    if (i === 0) {
      for (const [day, n] of dueByDay) if (day < key) count += n;
    }
    forecast.push({ date: key, count });
  }

  const perBook = db
    .prepare(
      `SELECT book,
              COUNT(*) AS total,
              SUM(CASE WHEN state NOT IN ('new','suspended') THEN 1 ELSE 0 END) AS studied,
              SUM(CASE WHEN state = 'review' AND interval_days >= 21 THEN 1 ELSE 0 END) AS mature
       FROM srs_cards GROUP BY book ORDER BY book`
    )
    .all() as { book: string; total: number; studied: number; mature: number }[];

  const leeches = db
    .prepare(
      `SELECT hanzi, pinyin, english, lapses FROM srs_cards
       WHERE lapses >= 4 ORDER BY lapses DESC, id LIMIT 10`
    )
    .all() as { hanzi: string; pinyin: string; english: string; lapses: number }[];

  return {
    reviewsToday: todayRow.n ?? 0,
    correctToday: todayRow.ok ?? 0,
    streakDays,
    forecast,
    perBook,
    leeches,
  };
}
