"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";

type Rating = "again" | "hard" | "good" | "easy";

interface SrsCard {
  id: number;
  direction: "recognize" | "produce";
  book: string;
  lesson: number;
  hanzi: string;
  pinyin: string;
  english: string;
  pos: string | null;
  state: string;
  interval_days: number;
  reps: number;
  lapses: number;
}

interface Counts {
  newCards: number;
  learning: number;
  due: number;
  total: number;
  locked: number;
  studied: number;
  mature: number;
  young: number;
  newRemainingToday: number;
  reviewRemainingToday: number;
  reviewCapPerDay: number;
  newCapPerDay: number;
}

interface Example {
  hanzi: string;
  pinyin: string;
  english: string;
}

interface Payload {
  card: SrsCard | null;
  counts: Counts;
  waitSeconds: number | null;
  idleReason?: "capped" | "waiting" | "empty" | "done";
  preview: Record<Rating, string> | null;
  example: Example | null;
}

interface BookSummary {
  book: string;
  lessons: number;
  words: number;
  lessonStart: number;
  lessonEnd: number;
}

const BOOK_LABELS: Record<string, string> = {
  L1P1: "Level 1 · Part 1",
  L1P2: "Level 1 · Part 2",
  L2P1: "Level 2 · Part 1",
  L2P2: "Level 2 · Part 2",
};

const RATING_STYLE: Record<Rating, { label: string; key: string; bg: string; hover: string }> = {
  again: { label: "Again", key: "1", bg: "bg-[#d93025]", hover: "hover:bg-[#b3261e]" },
  hard: { label: "Hard", key: "2", bg: "bg-[#f29900]", hover: "hover:bg-[#d68b00]" },
  good: { label: "Good", key: "3", bg: "bg-[#1a73e8]", hover: "hover:bg-[#1765cc]" },
  easy: { label: "Easy", key: "4", bg: "bg-[#188038]", hover: "hover:bg-[#136c30]" },
};

export default function StudyPage() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [scopeBooks, setScopeBooks] = useState<string[]>([]);
  const [data, setData] = useState<Payload | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState("");
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState({ reviewed: 0, correct: 0 });
  const shownAt = useRef<number>(Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Guards a rating in flight so a double-tap can't record two reviews.
  const ratingRef = useRef(false);

  const scopeQuery = useCallback(
    () => (scopeBooks.length ? `books=${scopeBooks.join(",")}` : ""),
    [scopeBooks]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/srs?${scopeQuery()}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not load the deck");
      setData(d);
      setRevealed(false);
      setTyped("");
      shownAt.current = Date.now();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the deck");
    } finally {
      setLoading(false);
    }
  }, [scopeQuery]);

  useEffect(() => {
    fetch("/api/srs/build")
      .then((r) => r.json())
      .then((d) => setBooks(d.books ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const buildDeck = async () => {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/srs/build", { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not build the deck");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the deck");
    } finally {
      setBuilding(false);
    }
  };

  const rate = useCallback(
    async (rating: Rating) => {
      if (!data?.card || ratingRef.current) return;
      ratingRef.current = true;
      const ms = Date.now() - shownAt.current;
      setSession((s) => ({
        reviewed: s.reviewed + 1,
        correct: s.correct + (rating === "again" ? 0 : 1),
      }));
      try {
        const res = await fetch("/api/srs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId: data.card.id, rating, ms, scope: scopeQuery() }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "Could not save the review");
        setData(d);
        setRevealed(false);
        setTyped("");
        shownAt.current = Date.now();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save the review");
      } finally {
        ratingRef.current = false;
      }
    },
    [data, scopeQuery]
  );

  // Keyboard: space reveals, 1-4 rate, and on a revealed card space = Good.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!data?.card) return;
      // A Chinese IME uses space and Enter to pick candidates — never steal
      // those keys mid-composition.
      if (e.isComposing) return;
      const typingInInput =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement;
      if (e.key === " " || e.key === "Enter") {
        if (typingInInput && e.key === " ") return;
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else rate("good");
        return;
      }
      if (!revealed) return;
      // Digits are legitimate IME candidate keys while typing.
      if (typingInInput) return;
      const map: Record<string, Rating> = { "1": "again", "2": "hard", "3": "good", "4": "easy" };
      if (map[e.key]) {
        e.preventDefault();
        rate(map[e.key]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, revealed, rate]);

  useEffect(() => {
    if (data?.card?.direction === "produce" && !revealed) inputRef.current?.focus();
  }, [data, revealed]);

  const counts = data?.counts;
  const card = data?.card ?? null;
  const deckEmpty = (counts?.total ?? 0) === 0;
  const typedMatches = typed.trim() === card?.hanzi;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-normal text-[#202124]">
            Flashcards{" "}
            <span className="zh text-xl text-[#9aa0a6]">抽认卡</span>{" "}
            <span className="text-sm text-[#9aa0a6]">chōurènkǎ · spaced repetition</span>
          </h1>
        </div>
        {counts && !deckEmpty && (
          <div className="flex items-center gap-2">
            <CountChip label="New" value={Math.min(counts.newCards, counts.newRemainingToday)} color="#1a73e8" />
            <CountChip label="Learning" value={counts.learning} color="#d93025" />
            <CountChip label="Due" value={Math.min(counts.due, counts.reviewRemainingToday)} color="#188038" />
          </div>
        )}
      </div>

      {/* Deck scope */}
      {books.length > 0 && !deckEmpty && (
        <div className="flex flex-wrap items-center gap-2">
          <ScopePill active={scopeBooks.length === 0} onClick={() => setScopeBooks([])}>
            All books
          </ScopePill>
          {books.map((b) => (
            <ScopePill
              key={b.book}
              active={scopeBooks.includes(b.book)}
              onClick={() =>
                setScopeBooks((s) =>
                  s.includes(b.book) ? s.filter((x) => x !== b.book) : [...s, b.book]
                )
              }
            >
              {BOOK_LABELS[b.book] ?? b.book}
              <span className="ml-1.5 text-[11px] opacity-60">{b.words}</span>
            </ScopePill>
          ))}
        </div>
      )}

      {error && (
        <div className="g-card border-[#f6aea9] bg-[#fce8e6] p-4 text-sm text-[#c5221f]">{error}</div>
      )}

      {/* Empty deck: offer to build it */}
      {!loading && deckEmpty && (
        <div className="g-card p-10 text-center">
          <p className="text-lg font-medium text-[#202124]">Build your deck</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#5f6368]">
            Every word from your Integrated Chinese books becomes a flashcard — shown to you
            just before you would forget it, exactly like Anki.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {books.map((b) => (
              <span
                key={b.book}
                className="rounded-full bg-[#f1f3f4] px-4 py-1.5 text-sm text-[#5f6368]"
              >
                {BOOK_LABELS[b.book] ?? b.book}:{" "}
                <span className="font-medium text-[#202124]">{b.words}</span> words
              </span>
            ))}
          </div>
          <button onClick={buildDeck} disabled={building} className="g-btn mt-6">
            {building ? "Building…" : "Build my deck"}
          </button>
        </div>
      )}

      {loading && !card && !deckEmpty && (
        <div className="g-card flex items-center justify-center gap-3 p-16">
          <div className="g-spinner" />
          <span className="text-sm text-[#5f6368]">Loading your cards…</span>
        </div>
      )}

      {/* All caught up */}
      {!loading && !card && !deckEmpty && (
        <div className="g-card p-12 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#e6f4ea]">
            <span className="text-3xl">✓</span>
          </div>
          <p className="text-lg font-medium text-[#202124]">
            {data?.waitSeconds != null
              ? "Nothing due right now"
              : data?.idleReason === "capped"
                ? "That's today's limit"
                : "All caught up"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#5f6368]">
            {data?.waitSeconds != null
              ? `Your next card comes back in ${formatWait(data.waitSeconds)}.`
              : counts && counts.due > 0 && counts.reviewRemainingToday === 0
                ? `You've reviewed your ${counts.reviewCapPerDay} cards for today. ${counts.due} are still due here — the daily limit is shared across every book, so switching books above won't add more. Raise "Max reviews / day" in Settings to keep going.`
                : counts && counts.newRemainingToday === 0 && counts.newCards > 0
                  ? `That's today's batch of new words done. ${counts.newCards} are still waiting their turn here — the daily limit is shared across every book, so switching books above won't add more. Raise "New cards / day" in Settings if you want more, or come back tomorrow.`
                  : "Nothing is due. Come back tomorrow, or study another book above."}
          </p>
          {counts && (
            <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm">
              <Stat label="Studied" value={`${counts.studied}/${counts.total}`} />
              <Stat label="Solid" value={String(counts.mature)} />
              <Stat label="This session" value={`${session.reviewed} cards`} />
            </div>
          )}
          <Forecast />
          <button onClick={load} className="g-btn-text mt-4">
            Check again
          </button>
        </div>
      )}

      {/* The card */}
      {card && (
        <div className="space-y-4">
          <div className="g-card g-enter overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#f1f3f4] px-6 py-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
                <span>
                  {card.pos === "char"
                    ? "Single character"
                    : card.direction === "recognize"
                      ? "Recognise"
                      : "Write it"}{" "}
                  · Lesson {card.lesson}
                </span>
                <span className="rounded-full bg-[#f1f3f4] px-2 py-0.5 normal-case tracking-normal">
                  {BOOK_LABELS[card.book] ?? card.book}
                </span>
                {card.lapses >= 4 && (
                  <span className="rounded-full bg-[#fce8e6] px-2 py-0.5 normal-case tracking-normal text-[#c5221f]">
                    tricky · {card.lapses} slips
                  </span>
                )}
              </div>
              <span className="text-[11px] text-[#9aa0a6]">
                {card.state === "new" ? "new card" : `seen ${card.reps}×`}
              </span>
            </div>

            {/* Session progress: how much of today's workload is behind you */}
            {counts && (
              <div className="h-0.5 w-full bg-[#f1f3f4]">
                <div
                  className="h-full bg-[#1a73e8] transition-all duration-500"
                  style={{
                    width: `${(() => {
                      const remaining =
                        Math.min(counts.newCards, counts.newRemainingToday) +
                        counts.learning +
                        Math.min(counts.due, counts.reviewRemainingToday);
                      const total = session.reviewed + remaining;
                      return total > 0 ? (session.reviewed / total) * 100 : 0;
                    })()}%`,
                  }}
                />
              </div>
            )}

            <div className="px-6 py-10 text-center">
              {/* Question side */}
              {card.direction === "recognize" ? (
                <div
                  className={`relative flex items-center justify-center py-6 ${
                    [...card.hanzi].length === 1 ? "g-tian" : ""
                  }`}
                >
                  <p className="zh text-7xl font-medium leading-tight text-[#202124]">
                    {card.hanzi}
                  </p>
                  {/* Out of the flow, so revealing the answer never nudges
                      the character off the centre of the grid. */}
                  {revealed && (
                    <span className="absolute inset-y-0 right-0 flex items-center">
                      <SpeakButton text={card.hanzi} size="lg" />
                    </span>
                  )}
                </div>
              ) : (
                <div>
                  <p className="text-3xl font-normal leading-snug text-[#202124]">{card.english}</p>
                  {card.pos && <p className="mt-2 text-sm text-[#9aa0a6]">{card.pos}</p>}
                </div>
              )}

              {/* Typing box for production cards */}
              {card.direction === "produce" && !revealed && (
                <input
                  ref={inputRef}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="写出汉字…  (type the characters, or press space to reveal)"
                  className="zh mx-auto mt-8 block w-full max-w-md rounded-xl border border-[#dadce0] px-4 py-3 text-center text-2xl outline-none transition-colors focus:border-[#1a73e8] focus:shadow-[0_0_0_1px_#1a73e8]"
                />
              )}

              {/* Answer side — the learner always ends up seeing all three */}
              {revealed && (
                <div className="g-reveal mt-6 border-t border-[#f1f3f4] pt-6">
                  {/* Production cards reveal the characters; recognition cards
                      already show them, so the answer adds sound and meaning. */}
                  {card.direction === "produce" && (
                    <div className="mb-4">
                      {typed.trim() && (
                        <p
                          className={`zh mb-3 text-xl ${typedMatches ? "text-[#188038]" : "text-[#c5221f] line-through"}`}
                        >
                          {typed}
                          <span className="ml-2 not-italic">{typedMatches ? "✓" : "✗"}</span>
                        </p>
                      )}
                      <div className="flex items-center justify-center gap-3">
                        <p className="zh text-5xl font-medium leading-tight text-[#202124]">
                          {card.hanzi}
                        </p>
                        <SpeakButton text={card.hanzi} size="lg" />
                      </div>
                    </div>
                  )}
                  <p className="text-2xl text-[#1967d2]">{card.pinyin}</p>
                  {card.direction === "recognize" && (
                    <p className="mt-1 text-lg text-[#5f6368]">{card.english}</p>
                  )}

                  {data?.example && (
                    <div className="mx-auto mt-6 max-w-lg rounded-xl bg-[#f8f9fa] p-4 text-left">
                      <div className="mb-1 flex items-center justify-between">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
                          In a sentence
                        </p>
                        <SpeakButton text={data.example.hanzi} size="sm" />
                      </div>
                      <p className="zh text-lg leading-relaxed text-[#202124]">
                        {data.example.hanzi}
                      </p>
                      <p className="mt-1 text-sm text-[#1967d2]">{data.example.pinyin}</p>
                      <p className="mt-0.5 text-sm text-[#5f6368]">{data.example.english}</p>
                    </div>
                  )}

                  <a
                    href={`/dictionary?q=${encodeURIComponent(card.hanzi)}`}
                    className="g-btn-text mt-4 inline-block"
                  >
                    Strokes, examples & full entry →
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          {!revealed ? (
            <div className="flex flex-col items-center gap-2">
              <button onClick={() => setRevealed(true)} className="g-btn w-full max-w-xs justify-center py-3">
                Show answer
              </button>
              <span className="text-xs text-[#9aa0a6]">or press space</span>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-4 gap-2">
                {(Object.keys(RATING_STYLE) as Rating[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => rate(r)}
                    className={`flex flex-col items-center rounded-xl px-3 py-3 text-white transition-colors ${RATING_STYLE[r].bg} ${RATING_STYLE[r].hover}`}
                  >
                    <span className="text-sm font-medium">{RATING_STYLE[r].label}</span>
                    <span className="mt-0.5 text-xs opacity-90">{data?.preview?.[r] ?? "—"}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-center text-xs text-[#9aa0a6]">
                Keys 1–4 · space = Good · &ldquo;Again&rdquo; brings the card straight back
              </p>
            </div>
          )}

          {/* Today's shape: session so far, plus how much of the deck is solid */}
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-[#9aa0a6]">
            {session.reviewed > 0 && (
              <span>
                This session:{" "}
                <span className="font-medium text-[#5f6368]">{session.reviewed} cards</span> ·{" "}
                <span className="font-medium text-[#5f6368]">
                  {Math.round((session.correct / session.reviewed) * 100)}% remembered
                </span>
              </span>
            )}
            {counts && (
              <span>
                Deck:{" "}
                <span className="font-medium text-[#5f6368]">
                  {counts.studied}/{counts.total}
                </span>{" "}
                started ·{" "}
                <span className="font-medium text-[#5f6368]">{counts.mature}</span> solid
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The next two weeks of reviews — Anki's forecast, in miniature. */
function Forecast() {
  const [days, setDays] = useState<{ date: string; count: number }[] | null>(null);

  useEffect(() => {
    fetch("/api/srs/stats")
      .then((r) => r.json())
      .then((d) => setDays(d.forecast ?? null))
      .catch(() => {});
  }, []);

  if (!days || days.every((d) => d.count === 0)) return null;
  const max = Math.max(1, ...days.map((d) => d.count));

  return (
    <div className="mx-auto mt-8 max-w-sm">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
        Coming up
      </p>
      <div
        className="flex h-12 items-end gap-[3px]"
        role="img"
        aria-label="Cards due each day for the next two weeks"
      >
        {days.map((d, i) => (
          <div
            key={d.date}
            title={`${d.date}: ${d.count} card${d.count === 1 ? "" : "s"} due`}
            className="flex-1 rounded-t-[3px]"
            style={{
              height: `${d.count === 0 ? 2 : Math.max(5, Math.round((d.count / max) * 44))}px`,
              background: i === 0 ? "#1a73e8" : "#c6dafc",
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[#9aa0a6]">
        <span>today</span>
        <span>in 2 weeks</span>
      </div>
    </div>
  );
}

function CountChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-[#dadce0] bg-white px-3 py-1.5 text-sm">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="text-[#5f6368]">{label}</span>
      <span className="font-medium text-[#202124]">{value}</span>
    </span>
  );
}

function ScopePill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "border-[#1a73e8] bg-[#e8f0fe] text-[#1967d2]"
          : "border-[#dadce0] bg-white text-[#5f6368] hover:bg-[#f1f3f4]"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full bg-[#f1f3f4] px-4 py-1.5">
      <span className="text-[#5f6368]">{label}: </span>
      <span className="font-medium text-[#202124]">{value}</span>
    </span>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, seconds)} seconds`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
