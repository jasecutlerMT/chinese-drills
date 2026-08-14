import { NextRequest, NextResponse } from "next/server";
import { readJson, badRequest } from "@/lib/http";
import {
  ensureSrs,
  nextCard,
  deckCounts,
  previewIntervals,
  rateCard,
  idleReason,
  secondsUntilNextLearning,
  type Rating,
  type Scope,
  type SrsCard,
} from "@/lib/srs";
import { bestEntryFor, getEntry, type UsageExample } from "@/lib/dict";
import { prewarmAudio } from "@/lib/tts";

export const dynamic = "force-dynamic";

const RATINGS: Rating[] = ["again", "hard", "good", "easy"];

function scopeFrom(params: URLSearchParams): Scope {
  const books = (params.get("books") ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  const start = Number(params.get("lessonStart"));
  const end = Number(params.get("lessonEnd"));
  return {
    books,
    lessonStart: Number.isInteger(start) && start > 0 ? start : undefined,
    lessonEnd: Number.isInteger(end) && end > 0 ? end : undefined,
  };
}

/** An example sentence for this word, only if one is already cached. */
function cachedExample(hanzi: string): UsageExample | null {
  const entry = bestEntryFor(hanzi);
  if (!entry) return null;
  const full = getEntry(entry.id);
  if (!full?.examples || full.examples.length === 0) return null;
  // Prefer the easiest example that actually contains the word.
  const containing = full.examples.filter((e) => e.hanzi.includes(hanzi));
  const pool = containing.length > 0 ? containing : full.examples;
  return pool.reduce((a, b) => ((a.difficulty ?? 3) <= (b.difficulty ?? 3) ? a : b));
}

function payload(scope: Scope, card: SrsCard | null) {
  const counts = deckCounts(scope);
  if (!card) {
    return {
      card: null,
      counts,
      waitSeconds: secondsUntilNextLearning(scope),
      idleReason: idleReason(scope),
      preview: null,
      example: null,
    };
  }
  prewarmAudio([card.hanzi]);
  return {
    card,
    counts,
    waitSeconds: null,
    preview: previewIntervals(card),
    example: cachedExample(card.hanzi),
  };
}

export async function GET(req: NextRequest) {
  try {
    ensureSrs();
    const scope = scopeFrom(req.nextUrl.searchParams);
    return NextResponse.json(payload(scope, nextCard(scope)));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load the deck" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    ensureSrs();
    const body = await readJson(req);
    if (!body) return badRequest();
    const cardId = Number(body.cardId);
    const rating = String(body.rating) as Rating;
    const ms = Number.isFinite(Number(body.ms)) ? Number(body.ms) : undefined;
    if (!Number.isInteger(cardId) || !RATINGS.includes(rating)) {
      return NextResponse.json({ error: "Invalid review" }, { status: 400 });
    }
    const updated = rateCard(cardId, rating, ms);
    if (!updated) return NextResponse.json({ error: "Card not found" }, { status: 404 });

    const scope = scopeFrom(new URLSearchParams(String(body.scope ?? "")));
    return NextResponse.json({ ...payload(scope, nextCard(scope)), rated: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save the review" },
      { status: 500 }
    );
  }
}
