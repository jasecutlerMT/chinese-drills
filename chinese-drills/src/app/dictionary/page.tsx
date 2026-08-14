"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import HanziWriter from "hanzi-writer";
import SpeakButton from "@/components/SpeakButton";

interface Result {
  id: number;
  simplified: string;
  traditional: string;
  pinyin_marks: string;
  definitions: string[];
}

interface UsageExample {
  hanzi: string;
  pinyin: string;
  english: string;
  difficulty?: number;
}

const DIFFICULTY_LABEL: Record<number, { label: string; cls: string }> = {
  1: { label: "beginner", cls: "bg-[#e6f4ea] text-[#188038]" },
  2: { label: "easy", cls: "bg-[#e6f4ea] text-[#188038]" },
  3: { label: "medium", cls: "bg-[#e8f0fe] text-[#1967d2]" },
  4: { label: "hard", cls: "bg-[#fef7e0] text-[#b26a00]" },
  5: { label: "native", cls: "bg-[#fce8e6] text-[#c5221f]" },
};

type Entry = Result & { examples: UsageExample[] | null };

interface CharInfo {
  hanzi: string;
  pinyin: string;
  english: string;
}

// Minimal typing for the Chrome-only Web Speech API.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface VocabPick {
  hanzi: string;
  pinyin: string;
  english: string;
}

export default function DictionaryPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [recent, setRecent] = useState<Result[]>([]);
  const [wotd, setWotd] = useState<Result | null>(null);
  const [chars, setChars] = useState<CharInfo[]>([]);
  const [picks, setPicks] = useState<VocabPick[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  useEffect(() => {
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    setSpeechSupported(!!w.webkitSpeechRecognition);
    // Load recent lookups + daily discovery content on first visit.
    fetch("/api/dict/search?q=")
      .then((r) => r.json())
      .then((d) => {
        setRecent(d.recent ?? []);
        setWotd(d.wotd ?? null);
        setPicks(d.lessonPicks ?? []);
      })
      .catch(() => {});
  }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`/api/dict/search?q=${encodeURIComponent(q)}`);
      const d = await res.json();
      if (seq !== searchSeqRef.current) return; // a newer search superseded this one
      if (!res.ok) throw new Error(d.error || "Search failed");
      setResults(d.results ?? []);
    } catch (e) {
      if (seq !== searchSeqRef.current) return;
      setResults([]);
      setSearchError(e instanceof Error ? e.message : "Search failed — is the app running?");
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  }, []);

  // Deep link: /dictionary?q=汉字 opens straight into that search, so the
  // flashcards can hand a word over for strokes and examples.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      setQuery(q);
      runSearch(q);
    }
  }, [runSearch]);

  const onQueryChange = (q: string) => {
    setQuery(q);
    setEntry(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(q), 250);
  };

  const openEntry = async (id: number) => {
    const res = await fetch(`/api/dict/entry/${id}`);
    if (!res.ok) return;
    const d = await res.json();
    setEntry(d.entry);
    setChars(d.chars ?? []);
  };

  const startVoice = () => {
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    if (!w.webkitSpeechRecognition || listening) return;
    const rec = new w.webkitSpeechRecognition();
    recognitionRef.current = rec;
    rec.lang = "zh-CN";
    rec.interimResults = false;
    rec.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      setQuery(transcript);
      setEntry(null);
      runSearch(transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-[28px] font-normal text-[#202124]">Dictionary</h1>

      {/* Search bar */}
      <div className="g-card flex items-center gap-2 p-2 pl-5">
        <svg className="h-5 w-5 shrink-0 text-[#9aa0a6]" viewBox="0 0 24 24" fill="none">
          <path
            d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search hanzi (手机), pinyin (shouji), or English (phone)…"
          className="zh w-full bg-transparent py-2.5 text-lg outline-none placeholder:text-[#9aa0a6]"
          autoFocus
        />
        {query && (
          <button
            onClick={() => onQueryChange("")}
            className="rounded-full p-2 text-[#9aa0a6] hover:bg-[#f1f3f4]"
            title="Clear"
          >
            ✕
          </button>
        )}
        {speechSupported && (
          <button
            onClick={startVoice}
            title="Speak in Mandarin"
            className={`rounded-full p-2.5 transition-colors ${
              listening ? "bg-[#fce8e6] text-[#d93025]" : "text-[#1a73e8] hover:bg-[#e8f0fe]"
            }`}
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z" />
            </svg>
          </button>
        )}
      </div>
      {listening && (
        <p className="animate-pulse text-sm text-[#d93025]">Listening — speak in Mandarin…</p>
      )}

      {/* Entry view */}
      {entry ? (
        <EntryView
          entry={entry}
          chars={chars}
          onBack={() => setEntry(null)}
          onLookup={(q) => {
            setEntry(null);
            setQuery(q);
            runSearch(q);
          }}
        />
      ) : (
        <>
          {/* Results */}
          {query.trim() ? (
            <div className="g-card divide-y divide-[#f1f3f4]">
              {searchError && <p className="p-5 text-sm text-[#c5221f]">{searchError}</p>}
              {searching && results.length === 0 && !searchError && (
                <div className="space-y-3 p-5">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex items-center gap-4">
                      <div className="g-skeleton h-7 w-16" />
                      <div className="g-skeleton h-4 w-24" />
                      <div className="g-skeleton h-4 flex-1" />
                    </div>
                  ))}
                </div>
              )}
              {!searching && results.length === 0 && !searchError && (
                <p className="p-5 text-sm text-[#9aa0a6]">No entries found.</p>
              )}
              {results.map((r) => (
                <ResultRow key={r.id} r={r} onClick={() => openEntry(r.id)} />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              {/* Daily discovery */}
              <div className="grid gap-4 lg:grid-cols-2">
                {wotd && (
                  <div className="g-card g-card-hover g-enter relative overflow-hidden p-6">
                    <span className="zh pointer-events-none absolute -right-6 -top-10 select-none text-[150px] font-bold leading-none text-[#e8f0fe]">
                      {wotd.simplified[0]}
                    </span>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-[#1967d2]">
                      Word of the day
                    </p>
                    <div className="relative mt-3 flex items-center gap-3">
                      <button
                        onClick={() => openEntry(wotd.id)}
                        className="zh text-5xl font-medium text-[#202124] transition-colors hover:text-[#1a73e8]"
                      >
                        {wotd.simplified}
                      </button>
                      <SpeakButton text={wotd.simplified} size="lg" />
                    </div>
                    <p className="relative mt-1 text-lg text-[#1967d2]">{wotd.pinyin_marks}</p>
                    <p className="relative mt-2 line-clamp-2 text-sm leading-relaxed text-[#5f6368]">
                      {wotd.definitions.join("; ")}
                    </p>
                    <button onClick={() => openEntry(wotd.id)} className="g-btn-text relative mt-3 -ml-3">
                      Full entry & strokes →
                    </button>
                  </div>
                )}
                {picks.length > 0 && (
                  <div className="g-card g-enter p-6">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-[#188038]">
                      From your lessons
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2.5">
                      {picks.map((p) => (
                        <button
                          key={p.hanzi}
                          onClick={() => {
                            setQuery(p.hanzi);
                            runSearch(p.hanzi);
                          }}
                          className="rounded-xl bg-[#f1f3f4] px-4 py-2.5 text-left transition-all hover:bg-[#e8f0fe] hover:shadow-sm"
                        >
                          <span className="zh block text-xl font-medium leading-tight text-[#202124]">
                            {p.hanzi}
                          </span>
                          <span className="mt-0.5 block text-xs leading-snug text-[#1967d2]">
                            {p.pinyin}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-snug text-[#5f6368]">
                            {p.english}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="mt-4 text-xs text-[#9aa0a6]">
                      A fresh handful from your lesson range every day — tap to explore.
                    </p>
                  </div>
                )}
              </div>

              {recent.length > 0 && (
                <div>
                  <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#9aa0a6]">
                    Recent lookups
                  </h2>
                  <div className="g-card divide-y divide-[#f1f3f4]">
                    {recent.map((r) => (
                      <ResultRow key={r.id} r={r} onClick={() => openEntry(r.id)} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <p className="text-xs text-[#9aa0a6]">
        Dictionary data: CC-CEDICT (Creative Commons BY-SA 4.0). Example sentences are
        AI-generated — treat them as practice material, not gospel.
      </p>
    </div>
  );
}

function ResultRow({ r, onClick }: { r: Result; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-baseline gap-4 p-4 text-left transition-colors hover:bg-[#f8f9fa]"
    >
      <span className="zh shrink-0 text-2xl font-medium text-[#202124]">{r.simplified}</span>
      <span className="shrink-0 text-sm text-[#1967d2]">{r.pinyin_marks}</span>
      <span className="truncate text-sm text-[#5f6368]">{r.definitions.join("; ")}</span>
    </button>
  );
}

/** Renders hanzi where every Chinese character is tappable for lookup. */
function TappableHanzi({
  text,
  word,
  onLookup,
}: {
  text: string;
  word?: string;
  onLookup: (q: string) => void;
}) {
  const chars = [...text];
  // Bold only characters inside actual occurrences of the headword, not any
  // character that merely appears in it (学 in 学校 vs the looked-up 学生).
  const inWord = new Array<boolean>(chars.length).fill(false);
  if (word) {
    const wordChars = [...word];
    for (let i = 0; i + wordChars.length <= chars.length; i++) {
      if (wordChars.every((wc, j) => chars[i + j] === wc)) {
        for (let j = 0; j < wordChars.length; j++) inWord[i + j] = true;
      }
    }
  }
  return (
    <>
      {chars.map((ch, i) =>
        /[㐀-鿿]/u.test(ch) ? (
          <span
            key={i}
            onClick={() => onLookup(ch)}
            title={`Look up ${ch}`}
            className={`cursor-pointer rounded-sm transition-colors hover:bg-[#e8f0fe] ${
              inWord[i] ? "font-semibold text-[#1a73e8]" : ""
            }`}
          >
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </>
  );
}

function EntryView({
  entry,
  chars,
  onBack,
  onLookup,
}: {
  entry: Entry;
  chars: CharInfo[];
  onBack: () => void;
  onLookup: (q: string) => void;
}) {
  const [tab, setTab] = useState<"definition" | "strokes">("definition");
  const [examples, setExamples] = useState<UsageExample[] | null>(entry.examples);
  const [examplesError, setExamplesError] = useState<string | null>(null);
  const [loadingExamples, setLoadingExamples] = useState(false);

  useEffect(() => {
    setExamples(entry.examples);
    setExamplesError(null);
    setTab("definition");
  }, [entry]);

  useEffect(() => {
    if (entry.examples) return;
    const ac = new AbortController();
    let cancelled = false;
    setLoadingExamples(true);

    // Sentences arrive one at a time, so the first one is readable while the
    // rest are still being written rather than after all of them.
    (async () => {
      try {
        const res = await fetch(`/api/dict/entry/${entry.id}`, {
          method: "POST",
          signal: ac.signal,
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || "Example generation failed");
        }
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
          const d = await res.json();
          if (!cancelled) setExamples(d.examples);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const arrived: UsageExample[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const evt = JSON.parse(line.slice(6));
            if (evt.example) {
              arrived.push(evt.example);
              setExamples([...arrived]);
              setLoadingExamples(false);
            } else if (evt.done) {
              setExamples(evt.examples);
              setLoadingExamples(false);
            } else if (evt.error) {
              throw new Error(evt.error);
            }
          }
        }
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        // Whatever already arrived stays on screen; only the tail is missing.
        setExamplesError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoadingExamples(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  const strokeChars = [...new Set(entry.simplified.split("").filter((c) => /[㐀-鿿]/u.test(c)))];

  return (
    <div className="g-card p-6">
      <button onClick={onBack} className="g-btn-text -ml-2 mb-4">
        ← Back to results
      </button>

      <div className="flex items-center gap-4">
        <span className="zh text-5xl font-medium text-[#202124]">{entry.simplified}</span>
        <SpeakButton text={entry.simplified} size="lg" />
        {entry.traditional !== entry.simplified && (
          <span className="zh text-2xl text-[#9aa0a6]">〔{entry.traditional}〕</span>
        )}
        <span className="text-xl text-[#1967d2]">{entry.pinyin_marks}</span>
      </div>

      {/* Tabs */}
      <div className="mt-5 flex gap-1 border-b border-[#dadce0]">
        {(["definition", "strokes"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-[#1a73e8] text-[#1a73e8]"
                : "text-[#5f6368] hover:text-[#202124]"
            }`}
          >
            {t === "definition" ? "Definition" : "Strokes"}
          </button>
        ))}
      </div>

      {tab === "definition" ? (
        <div className="mt-5 space-y-6">
          <ol className="space-y-1.5">
            {entry.definitions.map((d, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-[#202124]">
                <span className="shrink-0 text-sm font-medium text-[#9aa0a6]">{i + 1}.</span>
                {d}
              </li>
            ))}
          </ol>

          <div>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#9aa0a6]">
              How it&apos;s used
            </h3>
            {examples && (
              <div className="space-y-3">
                {examples.map((ex, i) => {
                  const diff = DIFFICULTY_LABEL[ex.difficulty ?? 3] ?? DIFFICULTY_LABEL[3];
                  return (
                    <div key={i} className="g-enter rounded-xl bg-[#f8f9fa] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <p className="zh text-lg leading-relaxed text-[#202124]">
                          <TappableHanzi
                            text={ex.hanzi}
                            word={entry.simplified}
                            onLookup={onLookup}
                          />
                        </p>
                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${diff.cls}`}
                          >
                            {diff.label}
                          </span>
                          <SpeakButton text={ex.hanzi} size="sm" />
                        </div>
                      </div>
                      <p className="mt-1 text-sm text-[#1967d2]">{ex.pinyin}</p>
                      <p className="mt-0.5 text-sm text-[#5f6368]">{ex.english}</p>
                    </div>
                  );
                })}
                <p className="text-xs text-[#9aa0a6]">
                  Tap any character to look it up · sentences ordered easiest → hardest
                </p>
              </div>
            )}
            {loadingExamples && (
              <div className={`space-y-3 ${examples?.length ? "mt-3" : ""}`}>
                {/* Only as many placeholders as are still to come — they fill in
                    one by one rather than all appearing at the end. */}
                {Array.from({ length: Math.max(1, 3 - (examples?.length ?? 0)) }).map((_, i) => (
                  <div key={i} className="rounded-xl bg-[#f8f9fa] p-4">
                    <div className="g-skeleton h-6 w-2/3" />
                    <div className="g-skeleton mt-2 h-4 w-1/2" />
                  </div>
                ))}
                <p className="text-xs text-[#9aa0a6]">
                  Writing example sentences, easiest first… (cached forever after this)
                </p>
              </div>
            )}
            {examplesError && <p className="text-sm text-[#c5221f]">{examplesError}</p>}

          </div>
        </div>
      ) : (
        <div className="mt-5">
          <p className="mb-4 text-sm text-[#5f6368]">
            Watch the stroke order, then press <span className="font-medium">Practice</span> and
            draw the strokes yourself with your trackpad or mouse.
          </p>
          <div className="flex flex-wrap gap-6">
            {strokeChars.map((c) => (
              <StrokeCard
                key={c}
                char={c}
                pinyin={chars.find((x) => x.hanzi === c)?.pinyin}
                english={chars.find((x) => x.hanzi === c)?.english}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StrokeCard({ char, pinyin, english }: { char: string; pinyin?: string; english?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const [mode, setMode] = useState<"idle" | "animating" | "quiz">("idle");
  const [quizDone, setQuizDone] = useState(false);
  const [noData, setNoData] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = "";
    const writer = HanziWriter.create(containerRef.current, char, {
      width: 200,
      height: 200,
      padding: 8,
      showOutline: true,
      strokeAnimationSpeed: 1,
      delayBetweenStrokes: 250,
      strokeColor: "#202124",
      outlineColor: "#e8eaed",
      drawingColor: "#1a73e8",
      highlightColor: "#1a73e8",
      charDataLoader: (c: string) =>
        fetch(`/api/strokes/${encodeURIComponent(c)}`).then((r) => {
          if (!r.ok) {
            setNoData(true);
            throw new Error("no stroke data");
          }
          return r.json();
        }),
    });
    writerRef.current = writer;
    return () => {
      writerRef.current = null;
    };
  }, [char]);

  const animate = () => {
    const w = writerRef.current;
    if (!w) return;
    setMode("animating");
    setQuizDone(false);
    w.cancelQuiz();
    w.showCharacter();
    w.animateCharacter({ onComplete: () => setMode("idle") });
  };

  const quiz = () => {
    const w = writerRef.current;
    if (!w) return;
    setMode("quiz");
    setQuizDone(false);
    w.quiz({
      showHintAfterMisses: 2,
      onComplete: () => {
        setQuizDone(true);
        setMode("idle");
      },
    });
  };

  if (noData) {
    return (
      <div className="rounded-xl border border-[#dadce0] p-4 text-sm text-[#9aa0a6]">
        <span className="zh text-3xl">{char}</span>
        <p className="mt-2">No stroke data for this character.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[#dadce0] p-4">
      <div
        ref={containerRef}
        className="rounded-xl"
        style={{
          backgroundImage:
            "linear-gradient(to right, #f1f3f4 1px, transparent 1px), linear-gradient(to bottom, #f1f3f4 1px, transparent 1px)",
          backgroundSize: "100px 100px",
          backgroundPosition: "center",
        }}
      />
      {/* Three-part rule: each character carries its own sound and sense */}
      <div className="mt-2 text-center">
        <p className="zh text-lg font-medium leading-tight text-[#202124]">{char}</p>
        {pinyin && <p className="text-xs leading-snug text-[#1967d2]">{pinyin}</p>}
        {english && (
          <p className="mx-auto max-w-[200px] truncate text-[11px] leading-snug text-[#5f6368]">
            {english}
          </p>
        )}
      </div>
      <div className="mt-2 flex items-center justify-center gap-2">
        <button
          onClick={animate}
          disabled={mode === "animating"}
          className="g-btn-text disabled:opacity-40"
        >
          ▶ Watch
        </button>
        <button
          onClick={quiz}
          disabled={mode === "quiz"}
          className="g-btn-text disabled:opacity-40"
        >
          ✎ Practice
        </button>
      </div>
      {mode === "quiz" && (
        <p className="mt-1 text-center text-xs text-[#5f6368]">Draw stroke by stroke</p>
      )}
      {quizDone && <p className="mt-1 text-center text-xs text-[#188038]">✓ Nice — got it!</p>}
    </div>
  );
}
