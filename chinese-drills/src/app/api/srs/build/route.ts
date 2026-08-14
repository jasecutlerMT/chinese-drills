import { NextResponse } from "next/server";
import { buildDeck, ensureSrs, deckCounts, type VocabSeed } from "@/lib/srs";
import { allVocab, bookSummaries } from "@/lib/lessons";
import { bestEntryFor } from "@/lib/dict";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const CJK = /[㐀-鿿豈-﫿]/u;

/**
 * An English gloss for a character card, from CC-CEDICT's raw definitions.
 *
 * CEDICT writes cross-references inline — "used to form interrogative
 * 什麼|什么[shen2 me5]" — in traditional|simplified pairs with numbered pinyin.
 * Copied onto a card, the answer side shows traditional characters with no
 * reading and no meaning, on the one surface that exists to teach meaning, in
 * an app that promises simplified only. So the references come out, and any
 * sense that is nothing but a reference goes with them.
 */
function glossFor(definitions: string[]): string {
  const senses: string[] = [];
  for (const raw of definitions) {
    // Drop whole clauses that lean on a cross-reference rather than surgically
    // removing the reference: "used to form interrogative 什麼|什么[shen2 me5]"
    // has nothing left to say once the reference goes.
    const kept = raw
      .split(/[,;]/)
      .map((clause) => clause.replace(/\(\s*(abbr\.|CL)[^)]*\)/gi, "").trim())
      .filter(
        (clause) =>
          clause &&
          !CJK.test(clause) &&
          !/\[[^\]]*\]/.test(clause) &&
          !/^(variant|old variant|used in|see|abbr\.|CL:)/i.test(clause) &&
          !/\b(abbr\. for|used to form|indefinite|interrogative)\b\s*$/i.test(clause)
      );
    const cleaned = kept.join("; ").replace(/\s{2,}/g, " ").trim();
    if (!cleaned) continue;
    senses.push(cleaned);
    if (senses.length === 3) break;
  }
  return senses.join("; ");
}

/** What's in the textbook data, and how much of it is already carded. */
export async function GET() {
  ensureSrs();
  return NextResponse.json({
    books: bookSummaries(),
    totalWords: allVocab().length,
    counts: deckCounts({ books: [] }),
  });
}

/** Create SRS cards for every word (and character) in the textbook data. */
export async function POST() {
  try {
    ensureSrs();
    const vocab = allVocab();
    const items: VocabSeed[] = vocab.map((v) => ({
      hanzi: v.hanzi,
      pinyin: v.pinyin,
      english: v.english,
      pos: v.pos,
      book: v.book,
      lesson: v.lesson,
    }));

    // "Every word and character": each single character that only ever
    // appears inside a compound also gets its own recognition card, taught
    // in the lesson where it first shows up.
    if (getSettings().srs_include_characters) {
      const known = new Set(vocab.map((v) => v.hanzi));
      const firstSeen = new Map<string, { book: string; lesson: number }>();
      for (const v of vocab) {
        for (const ch of v.hanzi) {
          if (!/[㐀-鿿]/u.test(ch) || known.has(ch)) continue;
          const prev = firstSeen.get(ch);
          if (!prev || v.lesson < prev.lesson) {
            firstSeen.set(ch, { book: v.book, lesson: v.lesson });
          }
        }
      }
      for (const [ch, where] of firstSeen) {
        const entry = bestEntryFor(ch);
        if (!entry) continue; // no dictionary meaning — nothing to test against
        const english = glossFor(entry.definitions);
        if (!english) continue; // nothing left once the cross-references go
        items.push({
          hanzi: ch,
          pinyin: entry.pinyin_marks,
          english,
          pos: "char",
          book: where.book,
          lesson: where.lesson,
          recognizeOnly: true,
        });
      }
    }

    const result = buildDeck(items);
    return NextResponse.json({ ...result, counts: deckCounts({ books: [] }) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not build the deck" },
      { status: 500 }
    );
  }
}
