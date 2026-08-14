import fs from "fs";
import path from "path";
import { getDb, nowIso } from "./db";

export interface DictEntry {
  id: number;
  simplified: string;
  traditional: string;
  pinyin_marks: string;
  pinyin_plain: string;
  definitions: string[]; // stored as JSON
}

interface CedictRaw {
  traditional: string;
  simplified: string;
  pinyin: string; // numbered tones: "shou3 ji1"
  english: string[];
}

const DICT_SCHEMA = `
CREATE TABLE IF NOT EXISTS dict (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  simplified   TEXT NOT NULL,
  traditional  TEXT NOT NULL,
  pinyin_nums  TEXT NOT NULL,
  pinyin_marks TEXT NOT NULL,
  pinyin_plain TEXT NOT NULL,
  definitions  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dict_simplified ON dict(simplified);
CREATE INDEX IF NOT EXISTS idx_dict_traditional ON dict(traditional);
CREATE INDEX IF NOT EXISTS idx_dict_pinyin ON dict(pinyin_plain);

CREATE TABLE IF NOT EXISTS dict_examples (
  dict_id       INTEGER PRIMARY KEY REFERENCES dict(id),
  examples_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lookups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_id    INTEGER NOT NULL REFERENCES dict(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookups_time ON lookups(id DESC);
`;

// ---------- pinyin conversion ----------

const TONE_MARKS: Record<string, string[]> = {
  a: ["ā", "á", "ǎ", "à", "a"],
  e: ["ē", "é", "ě", "è", "e"],
  i: ["ī", "í", "ǐ", "ì", "i"],
  o: ["ō", "ó", "ǒ", "ò", "o"],
  u: ["ū", "ú", "ǔ", "ù", "u"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ", "ü"],
};

/** "shou3" -> "shǒu"; "nu:3" -> "nǚ"; "r5" -> "r" */
function syllableToMarks(syl: string): string {
  const m = syl.match(/^([a-zA-Z:]+)([1-5])$/);
  if (!m) return syl;
  let base = m[1].replace(/u:/g, "ü").replace(/U:/g, "Ü");
  const tone = parseInt(m[2], 10) - 1;
  if (tone === 4) return base; // neutral tone: no mark
  const lower = base.toLowerCase();
  // Mark placement: a/e first, then ou takes o, else the last vowel.
  let idx = -1;
  if (lower.includes("a")) idx = lower.indexOf("a");
  else if (lower.includes("e")) idx = lower.indexOf("e");
  else if (lower.includes("ou")) idx = lower.indexOf("o");
  else {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ("iouü".includes(lower[i])) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) return base;
  const ch = lower[idx] as keyof typeof TONE_MARKS;
  let marked = TONE_MARKS[ch]?.[tone] ?? base[idx];
  // Preserve capitalization of proper nouns ("An1 hui1" -> "Ān huī").
  if (base[idx] !== lower[idx]) marked = marked.toUpperCase();
  return base.slice(0, idx) + marked + base.slice(idx + 1);
}

export function pinyinNumsToMarks(nums: string): string {
  return nums.split(/\s+/).map(syllableToMarks).join(" ");
}

/** "shou3 ji1" -> "shouji"; "nu:3" -> "nv" (how people actually type ü) */
export function pinyinNumsToPlain(nums: string): string {
  return nums
    .toLowerCase()
    .replace(/u:/g, "v")
    .replace(/[1-5]/g, "")
    .replace(/[\s'-]/g, "");
}

// ---------- import ----------

// Bump when the import pipeline changes (e.g. pinyin rendering fixes) so
// existing databases re-import instead of serving stale derived columns.
const DICT_DATA_VERSION = 2;

function importIfNeeded(): void {
  const db = getDb();
  db.exec(DICT_SCHEMA);
  // FTS index over definitions so English searches rank across the whole
  // dictionary instead of an arbitrary LIKE-scan slice.
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS dict_fts USING fts5(definitions, content='')"
  );

  const dataVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM dict").get() as { n: number }).n;
  if (count <= 100_000 || dataVersion < DICT_DATA_VERSION) {
    const file = path.join(process.cwd(), "node_modules", "cedict-json", "cedict.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as CedictRaw[];

    console.log(`[dict] importing CC-CEDICT (${raw.length} entries)…`);
    const insert = db.prepare(
      `INSERT INTO dict (simplified, traditional, pinyin_nums, pinyin_marks, pinyin_plain, definitions)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      // Entry ids change across reimports, so caches keyed on them must go
      // (also required: they hold foreign keys into dict), and id numbering
      // must restart so the FTS index rowids line up.
      db.prepare("DELETE FROM lookups").run();
      db.prepare("DELETE FROM dict_examples").run();
      db.prepare("DELETE FROM dict").run();
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'dict'").run();
      for (const e of raw) {
        insert.run(
          e.simplified,
          e.traditional,
          e.pinyin,
          pinyinNumsToMarks(e.pinyin),
          pinyinNumsToPlain(e.pinyin),
          JSON.stringify(e.english)
        );
      }
    })();
    db.pragma(`user_version = ${DICT_DATA_VERSION}`);
    console.log(`[dict] import done`);
  }

  // (Re)build the FTS index whenever it's out of sync with the dict table —
  // fresh import above, an install predating the index, or a reimport that
  // renumbered ids. Compare both row count and the id range.
  const dictStats = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM dict")
    .get() as { n: number; m: number };
  const ftsStats = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM dict_fts")
    .get() as { n: number; m: number };
  if (ftsStats.n !== dictStats.n || ftsStats.m !== dictStats.m) {
    console.log(`[dict] building search index…`);
    db.transaction(() => {
      // Contentless FTS5 tables only support the special delete-all command.
      db.exec("INSERT INTO dict_fts (dict_fts) VALUES ('delete-all')");
      db.exec("INSERT INTO dict_fts (rowid, definitions) SELECT id, definitions FROM dict");
    })();
  }
}

let ensured = false;
export function ensureDict(): void {
  if (ensured) return;
  importIfNeeded();
  ensured = true;
}

// ---------- search ----------

export interface SearchResult {
  id: number;
  simplified: string;
  traditional: string;
  pinyin_marks: string;
  definitions: string[];
}

interface DictRow {
  id: number;
  simplified: string;
  traditional: string;
  pinyin_marks: string;
  pinyin_plain: string;
  definitions: string;
}

export function toResult(r: {
  id: number;
  simplified: string;
  traditional: string;
  pinyin_marks: string;
  definitions: string;
}): SearchResult {
  return {
    id: r.id,
    simplified: r.simplified,
    traditional: r.traditional,
    pinyin_marks: r.pinyin_marks,
    definitions: JSON.parse(r.definitions) as string[],
  };
}

// Word lookups run in tight loops (pinyin for whole pages of text), so the
// statement is compiled once and misses are remembered.
/**
 * What counts as a Chinese character. Wider than the common block on purpose:
 * the compatibility ideographs (U+F900–U+FAFF) are real characters that turn
 * up in names, and treating them as punctuation sent them through the pinyin
 * line untranslated. Matches the range the dictionary search itself uses.
 */
const CJK_CHAR = /[㐀-鿿豈-﫿]/u;

/**
 * What counts as part of a Latin "word" inside otherwise-Chinese text.
 * Includes the tone-marked vowels pinyin is written with, because a
 * romanization the model returned glued to its characters gets fed back
 * through here and must come out whole rather than as "m á f á n".
 */
const LATIN_WORD_CHAR = /[A-Za-z0-9\u00C0-\u024F\u0300-\u036F\u1E00-\u1EFF'\u2019-]/;

const globalForLookup = globalThis as unknown as {
  __dictLookupStmt?: import("better-sqlite3").Statement;
  __dictLookupMiss?: Set<string>;
  __dictReadingCache?: Map<string, string | null>;
};

/**
 * Which reading a character actually takes, for the characters where guessing
 * wrong is worst. Frequency alone cannot settle these: 了 heads more dictionary
 * words as liǎo than as le, but a learner meets it as the particle le in
 * lesson 1 and will meet it that way for years.
 */
const PREFERRED_READING: Record<string, string> = {
  了: "le", 的: "de", 地: "de", 得: "de", 着: "zhe", 过: "guo",
  吗: "ma", 呢: "ne", 吧: "ba", 么: "me", 们: "men",
  什: "shén", 六: "liù", 还: "hái", 空: "kōng", 差: "chà",
  重: "zhòng", 长: "cháng", 教: "jiāo", 觉: "jué", 行: "xíng",
  为: "wèi", 少: "shǎo", 只: "zhǐ", 会: "huì", 好: "hǎo",
  相: "xiāng", 数: "shù", 种: "zhǒng", 干: "gàn", 累: "lèi",
};

/**
 * How often a character is read each way across the whole dictionary, judged
 * by the words that contain it. 六 appears in 六月, 十六, 六十 — all liù — so
 * liù wins over the lù of 六安. This is a far better signal than the length of
 * a gloss, which is what this used to sort by and is uncorrelated with
 * anything. Computed once per process, then cached.
 */
function commonestReading(simplified: string): string | null {
  if (simplified.length !== 1) return null;
  if (PREFERRED_READING[simplified]) return PREFERRED_READING[simplified];

  if (!globalForLookup.__dictReadingCache) globalForLookup.__dictReadingCache = new Map();
  const cache = globalForLookup.__dictReadingCache as Map<string, string | null>;
  const hit = cache.get(simplified);
  if (hit !== undefined) return hit;

  const rows = getDb()
    .prepare("SELECT simplified, pinyin_marks FROM dict WHERE simplified LIKE ? LIMIT 400")
    .all(`%${simplified}%`) as { simplified: string; pinyin_marks: string }[];

  const votes = new Map<string, number>();
  for (const row of rows) {
    const at = [...row.simplified].indexOf(simplified);
    const syllables = row.pinyin_marks.split(/\s+/);
    // Only count words whose syllable count lines up with their characters,
    // so the nth character really does correspond to the nth syllable.
    if (at < 0 || syllables.length !== [...row.simplified].length) continue;
    const syllable = syllables[at].toLowerCase().replace(/[^a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹ]/g, "");
    if (!syllable) continue;
    votes.set(syllable, (votes.get(syllable) ?? 0) + 1);
  }
  let best: string | null = null;
  let top = 0;
  for (const [syllable, n] of votes) {
    if (n > top) {
      top = n;
      best = syllable;
    }
  }
  cache.set(simplified, best);
  return best;
}

/** The dictionary entry that best represents an exact simplified form. */
export function bestEntryFor(simplified: string): SearchResult | null {
  ensureDict();
  if (!globalForLookup.__dictLookupMiss) globalForLookup.__dictLookupMiss = new Set();
  if (globalForLookup.__dictLookupMiss.has(simplified)) return null;
  if (!globalForLookup.__dictLookupStmt) {
    globalForLookup.__dictLookupStmt = getDb().prepare(
      "SELECT * FROM dict WHERE simplified = ?"
    );
  }
  const rows = globalForLookup.__dictLookupStmt.all(simplified) as DictRow[];
  if (rows.length === 0) {
    globalForLookup.__dictLookupMiss.add(simplified);
    return null;
  }
  if (rows.length === 1) return toResult(rows[0]);

  // Among several readings, take the one the language actually uses; among
  // several entries sharing that reading, take the least archaic.
  const want = commonestReading(simplified);
  const sameReading = want
    ? rows.filter((r) => r.pinyin_marks.toLowerCase().replace(/\s+/g, "") === want)
    : [];
  const pool = sameReading.length > 0 ? sameReading : rows;
  const best = pool.reduce((a, b) =>
    junkPenalty(a) !== junkPenalty(b)
      ? junkPenalty(a) < junkPenalty(b)
        ? a
        : b
      : a.definitions.length >= b.definitions.length
        ? a
        : b
  );
  return toResult(best);
}

/** Lower score sorts first. Prefers common words over archaic/variant entries. */
function junkPenalty(r: DictRow): number {
  const defs = r.definitions.toLowerCase();
  let p = 0;
  if (/variant of|archaic|old variant|used in|(^|\[|")surname /.test(defs)) p += 4;
  p += Math.min(r.simplified.length, 4); // shorter words first
  return p;
}

export function searchDict(q: string, limit = 50): SearchResult[] {
  ensureDict();
  const db = getDb();
  const query = q.trim();
  if (!query) return [];

  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(query);
  let rows: DictRow[];

  if (hasCjk) {
    rows = db
      .prepare(
        `SELECT *, CASE
           WHEN simplified = ? OR traditional = ? THEN 0
           WHEN simplified LIKE ? OR traditional LIKE ? THEN 1
           ELSE 2 END AS rank
         FROM dict
         WHERE simplified = ? OR traditional = ?
            OR simplified LIKE ? OR traditional LIKE ?
            OR simplified LIKE ? OR traditional LIKE ?
         ORDER BY rank, LENGTH(simplified)
         LIMIT ?`
      )
      .all(
        query, query,
        `${query}%`, `${query}%`,
        query, query,
        `${query}%`, `${query}%`,
        `%${query}%`, `%${query}%`,
        limit * 2
      ) as DictRow[];
  } else {
    const plain = query.toLowerCase().replace(/[1-5]/g, "").replace(/[\s'-]/g, "").replace(/ü/g, "v");
    const english = query.toLowerCase();
    const pinyinRows = db
      .prepare(
        `SELECT *, CASE WHEN pinyin_plain = ? THEN 0 ELSE 1 END AS rank
         FROM dict
         WHERE pinyin_plain = ? OR pinyin_plain LIKE ?
         ORDER BY rank, LENGTH(simplified)
         LIMIT ?`
      )
      .all(plain, plain, `${plain}%`, limit * 2) as DictRow[];

    // English fallback / supplement: FTS phrase match over all definitions,
    // best bm25 matches first (a LIKE scan with a LIMIT would silently drop
    // canonical entries for common words).
    let englishRows: DictRow[] = [];
    if (english.length >= 2) {
      const phrase = `"${english.replace(/"/g, "")}"`;
      try {
        // Wide net: bm25 favors short single-gloss entries, so a tight limit
        // here would drop common words (吃 for "eat"); real ranking happens
        // below in JS over the full candidate set.
        englishRows = db
          .prepare(
            `SELECT d.* FROM dict_fts f JOIN dict d ON d.id = f.rowid
             WHERE dict_fts MATCH ? LIMIT 6000`
          )
          .all(phrase) as DictRow[];
      } catch {
        englishRows = []; // unparseable FTS query — pinyin results still apply
      }
    }
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRe = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i");
    // How well the query matches a definition: exact > leading word > anywhere.
    // "to eat" counts as an exact match for "eat" (verbs are all glossed that way).
    const englishRank = (r: DictRow): { rank: number; senses: number } => {
      // CEDICT packs several glosses into one string ("to eat; to consume") —
      // split them so each gloss can match exactly.
      const glosses = (JSON.parse(r.definitions) as string[]).flatMap((d) =>
        d.split(/;\s*/)
      );
      let best = 99;
      for (const g of glosses) {
        const gl = g.toLowerCase().trim().replace(/^to /, "");
        if (gl === english) best = Math.min(best, 0);
        else if (gl.startsWith(english + " ")) best = Math.min(best, 1);
        else if (wordRe.test(g)) best = Math.min(best, 3);
      }
      return { rank: best, senses: glosses.length };
    };
    // English matches: match quality dominates, junk penalty next, and among
    // equals, entries with more senses (a proxy for frequency) come first.
    const englishScored = englishRows
      .map((r) => {
        const { rank, senses } = englishRank(r);
        return { r, key: rank * 100 + junkPenalty(r) * 10 - Math.min(senses, 8) };
      })
      .filter((x) => x.key < 9000)
      .sort((a, b) => a.key - b.key)
      .map((x) => x.r);
    // Pinyin matches: SQL already ranked exact-then-prefix by length; junk
    // penalty only breaks ties within that order.
    const pinyinScored = pinyinRows
      .map((r, i) => ({ r, key: i + junkPenalty(r) * 3 }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.r);

    // When a query reads as both pinyin and English ("go", "man"), don't let
    // pinyin matches crowd the English ones out of the result list entirely.
    const pinyinCap = englishScored.length > 0 ? Math.floor(limit * 0.6) : limit;
    const seen = new Set<number>();
    return [...pinyinScored.slice(0, pinyinCap), ...englishScored]
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .slice(0, limit)
      .map(toResult);
  }

  return rows
    .map((r) => ({ row: r, penalty: junkPenalty(r) }))
    .sort((a, b) => a.penalty - b.penalty)
    .slice(0, limit)
    .map((x) => toResult(x.row));
}

// ---------- entries, examples, history ----------

export interface UsageExample {
  hanzi: string;
  pinyin: string;
  english: string;
  difficulty: number;
}

export function getEntry(id: number): (SearchResult & { examples: UsageExample[] | null }) | null {
  ensureDict();
  const db = getDb();
  const row = db.prepare("SELECT * FROM dict WHERE id = ?").get(id) as DictRow | undefined;
  if (!row) return null;
  const cached = db
    .prepare("SELECT examples_json FROM dict_examples WHERE dict_id = ?")
    .get(id) as { examples_json: string } | undefined;
  let examples: UsageExample[] | null = null;
  if (cached) {
    examples = JSON.parse(cached.examples_json) as UsageExample[];
    // Old-format cache (no difficulty grading): drop it so the entry
    // regenerates with the easy-to-hard progression.
    if (examples.some((e) => typeof e.difficulty !== "number")) {
      db.prepare("DELETE FROM dict_examples WHERE dict_id = ?").run(id);
      examples = null;
    }
  }
  return { ...toResult(row), examples };
}

export function cacheExamples(id: number, examples: UsageExample[]): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO dict_examples (dict_id, examples_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(dict_id) DO UPDATE SET examples_json = excluded.examples_json`
  ).run(id, JSON.stringify(examples), nowIso());
}

export function recordLookup(id: number): void {
  const db = getDb();
  // Collapse consecutive duplicate lookups of the same entry.
  const last = db.prepare("SELECT dict_id FROM lookups ORDER BY id DESC LIMIT 1").get() as
    | { dict_id: number }
    | undefined;
  if (last?.dict_id === id) return;
  db.prepare("INSERT INTO lookups (dict_id, created_at) VALUES (?, ?)").run(id, nowIso());
}

/**
 * Pinyin for arbitrary Chinese text, using greedy longest-match word
 * segmentation against the dictionary (up to 6 characters). Word-level
 * matching gives the right reading for words whose characters have several
 * pronunciations — 银行 is "yín háng", not "yín xíng".
 */
export function pinyinFor(text: string): string {
  // Nothing Chinese in it, nothing to read out. Placeholders like "(missing)"
  // and plain English fragments come back untouched rather than as a reading
  // of themselves.
  if (!CJK_CHAR.test(text)) return "";
  ensureDict();
  const chars = [...text];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (!CJK_CHAR.test(ch)) {
      // A Latin word stays one word: "Netflix", not "N e t f l i x", and
      // "máfan" is one word, not six.
      if (LATIN_WORD_CHAR.test(ch)) {
        let word = "";
        while (i < chars.length && LATIN_WORD_CHAR.test(chars[i])) word += chars[i++];
        out.push(word);
        continue;
      }
      // Keep punctuation attached to the token it follows.
      if (out.length > 0 && /[，。？！、；：""''）)]/u.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
      i++;
      continue;
    }
    let matched = false;
    for (let len = Math.min(6, chars.length - i); len >= 2; len--) {
      const candidate = chars.slice(i, i + len).join("");
      const entry = bestEntryFor(candidate);
      if (entry) {
        out.push(entry.pinyin_marks);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const entry = bestEntryFor(ch);
      // A character the dictionary does not know must not be echoed into the
      // pinyin line as itself: that reads as though the character were its own
      // reading, which is exactly what the learner cannot check.
      out.push(entry ? entry.pinyin_marks : "?");
      i++;
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

export function recentLookups(limit = 12): SearchResult[] {
  ensureDict();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.* FROM lookups l JOIN dict d ON d.id = l.dict_id
       GROUP BY l.dict_id
       ORDER BY MAX(l.id) DESC
       LIMIT ?`
    )
    .all(limit) as DictRow[];
  return rows.map(toResult);
}

// ---------- trusting the model's pinyin ----------

const globalForReadings = globalThis as unknown as {
  __dictReadingsStmt?: import("better-sqlite3").Statement;
  __dictReadings?: Map<string, string[]>;
};

/**
 * Every reading CC-CEDICT knows for a single character, toneless and
 * lowercased, longest first so greedy matching prefers "dou" over "du".
 */
function readingsFor(ch: string): string[] {
  if (!globalForReadings.__dictReadings) globalForReadings.__dictReadings = new Map();
  const cached = globalForReadings.__dictReadings.get(ch);
  if (cached) return cached;
  if (!globalForReadings.__dictReadingsStmt) {
    globalForReadings.__dictReadingsStmt = getDb().prepare(
      "SELECT pinyin_plain FROM dict WHERE simplified = ? OR traditional = ?"
    );
  }
  const rows = globalForReadings.__dictReadingsStmt.all(ch, ch) as { pinyin_plain: string }[];
  const set = new Set<string>();
  for (const r of rows) for (const s of r.pinyin_plain.split(/\s+/)) if (s) set.add(normalizeSyllable(s));
  // 儿 is written as a bare "r" when it is the erhua suffix (玩儿 → wánr).
  if (ch === "儿") set.add("r");
  const list = [...set].sort((a, b) => b.length - a.length);
  globalForReadings.__dictReadings.set(ch, list);
  return list;
}

/** Tone marks off, ü/v/u: folded together, letters only. */
function normalizeSyllable(s: string): string {
  return s
    .toLowerCase()
    .replace(/u:/g, "u")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "")
    .replace(/v/g, "u");
}

/**
 * Does this pinyin actually read these characters?
 *
 * The model writes better pinyin than a per-character dictionary lookup can —
 * it knows 都 is "dōu" in 都很聪明 and "dū" in 首都 — but it also occasionally
 * invents a reading outright ("不容易" came back as "búyòng yì"). So we walk
 * the two in step: each character in turn must account for the next syllable
 * of the romanization, using the readings the dictionary actually lists for
 * it. Context-aware readings pass; invented ones cannot.
 *
 * Deliberately lenient — it returns true whenever it cannot judge (a
 * character the dictionary doesn't know, a Latin word in the sentence), so it
 * only ever rejects pinyin it has positively disproved.
 */
export function pinyinLooksRight(hanzi: string, pinyin: string): boolean {
  if (!pinyin.trim()) return false;
  ensureDict();
  // A Latin word inside the sentence would leave letters this walk cannot
  // attribute to any character; don't guess.
  if (/[A-Za-z]/.test(hanzi)) return true;
  let rest = normalizeSyllable(pinyin);
  for (const ch of hanzi) {
    if (!CJK_CHAR.test(ch)) continue;
    const options = readingsFor(ch);
    if (options.length === 0) return true; // unknown character — cannot judge
    const hit = options.find((r) => rest.startsWith(r));
    if (!hit) return false;
    rest = rest.slice(hit.length);
  }
  // Leftover syllables mean the romanization says more than the characters do.
  return rest.length === 0;
}

/**
 * The pinyin to actually show for a piece of Chinese: the model's when it
 * checks out, the dictionary's when it doesn't. Callers pass whatever the
 * model gave them, including nothing at all.
 */
export function bestPinyin(hanzi: string, candidate?: string | null): string {
  const c = (candidate ?? "").trim();
  if (c && pinyinLooksRight(hanzi, c)) return c;
  return pinyinFor(hanzi);
}
