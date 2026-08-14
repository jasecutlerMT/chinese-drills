#!/usr/bin/env node
/**
 * Check data/lessons.json against CC-CEDICT.
 *
 *   npm run check-lessons
 *
 * The lesson data is reconstructed from knowledge of the textbooks rather than
 * scanned from them, so it can be wrong in ways nobody notices mid-drill. This
 * checks it against an independent source and prints what disagrees. Run it
 * after you correct something, to see whether the dictionary agrees with you.
 *
 * Nothing here is automatically an error. The textbook writes the tone changes
 * on 一 and 不 (一下 yíxià, 不错 búcuò) and CC-CEDICT deliberately doesn't, so
 * those are listed separately and are expected. Words CC-CEDICT has never heard
 * of are usually the textbook's own character names, or ordinary compounds the
 * dictionary just doesn't list.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const TONE_MAP = new Map();
for (const [base, marks] of Object.entries({
  a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò",
  u: "ūúǔù", v: "ǖǘǚǜ", n: "ńňǹ",
})) {
  [...marks].forEach((ch, i) => TONE_MAP.set(ch, [base, String(i + 1)]));
}

/** Tone-marked pinyin → [letters, tones]. "nǐ hǎo" → ["nihao", "33"]. */
function keyMarked(p) {
  const letters = [];
  const tones = [];
  for (const ch of p.normalize("NFC").replace(/ü/g, "v").replace(/u:/g, "v")) {
    const hit = TONE_MAP.get(ch);
    if (hit) {
      letters.push(hit[0]);
      tones.push(hit[1]);
    } else if (/[a-zA-Z]/.test(ch)) {
      letters.push(ch.toLowerCase());
    }
  }
  return [letters.join(""), tones.join("")];
}

/** CC-CEDICT pinyin → [letters, tones]. "ni3 hao3" → ["nihao", "33"]. */
function keyCedict(p) {
  const letters = [];
  const tones = [];
  for (const syl of p.replace(/u:/g, "v").replace(/ü/g, "v").split(/\s+/)) {
    const m = /^([a-zA-Z]+)([1-5])$/.exec(syl);
    if (m) {
      letters.push(m[1].toLowerCase());
      if (m[2] !== "5") tones.push(m[2]);
    } else {
      letters.push(syl.toLowerCase().replace(/[^a-z]/g, ""));
    }
  }
  return [letters.join(""), tones.join("")];
}

const cedict = JSON.parse(
  fs.readFileSync(path.join(APP, "node_modules/cedict-json/cedict.json"), "utf8")
);
const bySimplified = new Map();
for (const e of cedict) {
  if (!bySimplified.has(e.simplified)) bySimplified.set(e.simplified, []);
  bySimplified.get(e.simplified).push(e);
}

/**
 * Is the only difference between two readings the tone on a 一 or a 不?
 *
 * It is not enough to ask whether the word contains one of those characters:
 * that would wave through a genuine typo in any word that happens to have a 一
 * in it, which is a lot of them, and this tool exists precisely to catch typos.
 * So the syllables must match exactly, and every tone that differs must sit on
 * a 一 or a 不.
 */
function onlySandhiApart(hanzi, mine, theirs) {
  if (mine[0] !== theirs[0]) return false;
  if (mine[1].length !== theirs[1].length) return false;
  const chars = [...hanzi];
  // Tones are recorded per toned syllable, so line them up with the characters
  // only when the counts agree; otherwise this cannot be judged safely.
  if (chars.length !== mine[1].length) return false;
  for (let i = 0; i < mine[1].length; i++) {
    if (mine[1][i] !== theirs[1][i] && chars[i] !== "一" && chars[i] !== "不") return false;
  }
  return mine[1] !== theirs[1];
}

const data = JSON.parse(fs.readFileSync(path.join(APP, "data/lessons.json"), "utf8"));

const sandhi = [];
const disagree = [];
const unknown = [];
const malformed = [];
let confirmed = 0;
let total = 0;

for (const lesson of data.lessons) {
  for (const v of lesson.vocab) {
    total++;
    const { hanzi, pinyin, english } = v;

    // A card has to have something to show and something to answer with.
    if (!hanzi || !pinyin || !english) {
      malformed.push([lesson.lesson, hanzi, "missing characters, pinyin or meaning"]);
      continue;
    }
    if (/[(（…]/.test(hanzi)) {
      malformed.push([lesson.lesson, hanzi, "brackets or an ellipsis — not a single word"]);
      continue;
    }

    const entries = bySimplified.get(hanzi);
    if (!entries) {
      unknown.push([lesson.lesson, hanzi, pinyin, english]);
      continue;
    }
    const mine = keyMarked(pinyin);
    const theirs = entries.map((e) => keyCedict(e.pinyin));
    if (theirs.some((t) => t[0] === mine[0] && t[1] === mine[1])) {
      confirmed++;
    } else if (theirs.some((t) => onlySandhiApart(hanzi, mine, t))) {
      // 一 and 不 change tone in context; the textbook writes the change.
      sandhi.push([lesson.lesson, hanzi, pinyin, theirs.map((t) => t[1]).join("/")]);
    } else {
      disagree.push([lesson.lesson, hanzi, pinyin, theirs, english]);
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `${total} words: ${confirmed} readings confirmed by CC-CEDICT, ` +
    `${disagree.length} disagree, ${sandhi.length} are 一/不 tone changes, ` +
    `${unknown.length} unlisted, ${malformed.length} malformed\n`
);

if (malformed.length) {
  console.log("MALFORMED — these cannot become usable flashcards:");
  for (const [l, h, why] of malformed) console.log(`  L${pad(l, 4)}${pad(h, 12)}${why}`);
  console.log();
}
if (disagree.length) {
  console.log("READING DISAGREES WITH THE DICTIONARY — worth checking your copy:");
  for (const [l, h, p, theirs, eng] of disagree) {
    const alt = theirs.map((t) => `${t[0]}(${t[1]})`).join(", ");
    console.log(`  L${pad(l, 4)}${pad(h, 10)}yours: ${pad(p, 16)}cedict: ${pad(alt, 26)}${eng.slice(0, 34)}`);
  }
  console.log();
}
if (unknown.length) {
  console.log("NOT IN CC-CEDICT — usually fine (names, ordinary compounds):");
  for (const [l, h, p, eng] of unknown) {
    console.log(`  L${pad(l, 4)}${pad(h, 12)}${pad(p, 18)}${eng.slice(0, 44)}`);
  }
  console.log();
}
if (sandhi.length) {
  console.log(`(${sandhi.length} 一/不 entries differ only by the tone change the textbook writes — expected.)`);
}

process.exitCode = malformed.length ? 1 : 0;
