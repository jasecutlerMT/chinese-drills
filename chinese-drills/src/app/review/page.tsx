"use client";

import { useEffect, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import type { DiagnosisPattern, ErrorRow } from "@/lib/types";

interface ReviewData {
  totals: {
    attempts: number;
    taskAttempts: number;
    targetedAttempts: number;
    errors: number;
  };
  byCategory: {
    category: string;
    count: number;
    critical: number;
    major: number;
    minor: number;
    resolved: number;
    last_seen: string;
  }[];
  byItem: {
    item: string;
    count: number;
    resolved: number;
    last_seen: string;
    categories: string;
    pinyin?: string;
  }[];
  recentErrors: (ErrorRow & {
    attempt_targeted: number;
    corrected_pinyin?: string;
    my_pinyin?: string;
  })[];
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-[#d93025]",
  major: "bg-[#f9ab00]",
  minor: "bg-[#4285f4]",
};

interface SrsStats {
  reviewsToday: number;
  correctToday: number;
  streakDays: number;
  perBook: { book: string; total: number; studied: number; mature: number }[];
  leeches: { hanzi: string; pinyin: string; english: string; lapses: number }[];
}

const BOOK_LABELS: Record<string, string> = {
  L1P1: "Level 1 · Part 1",
  L1P2: "Level 1 · Part 2",
  L2P1: "Level 2 · Part 1",
  L2P2: "Level 2 · Part 2",
};

function VocabularyMemory() {
  const [stats, setStats] = useState<SrsStats | null>(null);

  useEffect(() => {
    fetch("/api/srs/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats || stats.perBook.length === 0) return null;
  const totalCards = stats.perBook.reduce((n, b) => n + b.total, 0);
  if (totalCards === 0) return null;

  return (
    <section className="g-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-medium text-[#202124]">
          Vocabulary memory{" "}
          <span className="zh text-[#9aa0a6]">词汇记忆</span>{" "}
          <span className="text-xs font-normal text-[#9aa0a6]">cíhuì jìyì · from your flashcards</span>
        </h2>
        <span className="text-sm text-[#5f6368]">
          {stats.reviewsToday > 0
            ? `${stats.reviewsToday} ${stats.reviewsToday === 1 ? "card" : "cards"} today · ${Math.round((stats.correctToday / stats.reviewsToday) * 100)}% remembered`
            : "no cards reviewed today"}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {stats.perBook.map((b) => {
          const studiedPct = b.total ? (b.studied / b.total) * 100 : 0;
          const maturePct = b.total ? (b.mature / b.total) * 100 : 0;
          return (
            <div key={b.book}>
              <div className="mb-1 flex items-baseline justify-between text-sm">
                <span className="text-[#202124]">{BOOK_LABELS[b.book] ?? b.book}</span>
                <span className="text-xs text-[#5f6368]">
                  {b.studied}/{b.total} started · {b.mature} solid
                </span>
              </div>
              <div
                className="relative h-2 w-full overflow-hidden rounded-full bg-[#f1f3f4]"
                title={`${b.studied} of ${b.total} cards started, ${b.mature} known for 3+ weeks`}
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-[#c6dafc]"
                  style={{ width: `${studiedPct}%` }}
                />
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-[#1a73e8]"
                  style={{ width: `${maturePct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {stats.leeches.length > 0 && (
        <div className="mt-6">
          <p className="text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
            Words that keep slipping away
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {stats.leeches.map((l) => (
              <div key={l.hanzi} className="rounded-xl bg-[#fce8e6] px-3.5 py-2">
                <span className="zh block text-lg font-medium leading-tight text-[#202124]">
                  {l.hanzi}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-[#1967d2]">{l.pinyin}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-[#5f6368]">
                  {l.english}
                </span>
                <span className="mt-1 block text-[10px] font-medium text-[#c5221f]">
                  forgotten {l.lapses}×
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export default function ReviewPage() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<DiagnosisPattern[] | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/review")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `Review request failed (${r.status})`);
        setData(d);
      })
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : "Could not load review data")
      );
  }, []);

  const runDiagnosis = async () => {
    setDiagnosing(true);
    setDiagError(null);
    try {
      const res = await fetch("/api/diagnose", { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Diagnosis failed");
      setDiagnosis(d.patterns);
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : "Diagnosis failed");
    } finally {
      setDiagnosing(false);
    }
  };

  if (loadError) {
    return (
      <div className="g-card border-[#f6aea9] bg-[#fce8e6] p-4 text-sm text-[#c5221f]">
        {loadError}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center gap-3 text-[#5f6368]">
        <div className="g-spinner !h-5 !w-5 !border-2" />
        <span className="text-sm">Loading review…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-[28px] font-normal text-[#202124]">Review</h1>
        <div className="text-sm text-[#5f6368]">
          <span className="font-medium text-[#202124]">{data.totals.errors}</span> errors
          across <span className="font-medium text-[#202124]">{data.totals.attempts}</span>{" "}
          attempts
          {data.totals.targetedAttempts > 0 && (
            <span> · {data.totals.targetedAttempts} targeted</span>
          )}
        </div>
      </div>

      {/* Diagnose */}
      <section className="g-card p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-medium text-[#202124]">Diagnosis</h2>
            <p className="mt-0.5 text-xs text-[#9aa0a6]">
              Claude reads your last 50 errors and names your top recurring patterns
            </p>
          </div>
          <button onClick={runDiagnosis} disabled={diagnosing} className="g-btn shrink-0">
            {diagnosing ? "Diagnosing…" : "Diagnose"}
          </button>
        </div>
        {diagError && <p className="mt-3 text-sm text-[#c5221f]">{diagError}</p>}
        {diagnosis && (
          <ol className="mt-5 space-y-3">
            {diagnosis.map((p, i) => (
              <li key={i} className="rounded-xl bg-[#f8f9fa] p-5">
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#e8f0fe] text-xs font-semibold text-[#1967d2]">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-sm leading-relaxed text-[#202124]">{p.pattern_en}</p>
                    <p className="mt-2 text-sm leading-relaxed text-[#5f6368]">
                      <span className="font-medium text-[#1967d2]">Drill: </span>
                      {p.drill_suggestion}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <VocabularyMemory />

      {/* Weakness view */}
      <section className="grid gap-6 lg:grid-cols-2">
        <div className="g-card p-6">
          <h2 className="mb-4 font-medium text-[#202124]">Weaknesses by category</h2>
          {data.byCategory.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
                  <th className="pb-3 font-medium">Category</th>
                  <th className="pb-3 text-right font-medium">Count</th>
                  <th className="pb-3 text-right font-medium">C / M / m</th>
                  <th className="pb-3 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.byCategory.map((c) => (
                  <tr key={c.category} className="border-t border-[#f1f3f4]">
                    <td className="py-2.5 font-medium text-[#202124]">
                      {c.category.replace(/_/g, " ")}
                    </td>
                    <td className="py-2.5 text-right">{c.count}</td>
                    <td className="py-2.5 text-right text-[#5f6368]">
                      {c.critical} / {c.major} / {c.minor}
                    </td>
                    <td className="py-2.5 text-right text-[#9aa0a6]">
                      {c.last_seen.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="g-card p-6">
          <h2 className="mb-4 font-medium text-[#202124]">Weaknesses by item</h2>
          {data.byItem.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
                  <th className="pb-3 font-medium">Item</th>
                  <th className="pb-3 font-medium">Categories</th>
                  <th className="pb-3 text-right font-medium">Count</th>
                  <th className="pb-3 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.byItem.map((it) => (
                  <tr key={it.item} className="border-t border-[#f1f3f4]">
                    <td className="py-2.5">
                      <span className="zh block font-medium leading-tight text-[#202124]">
                        {it.item}
                      </span>
                      {it.pinyin && (
                        <span className="block text-[11px] leading-snug text-[#1967d2]">
                          {it.pinyin}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-xs text-[#5f6368]">
                      {it.categories.replace(/_/g, " ").replace(/,/g, ", ")}
                    </td>
                    <td className="py-2.5 text-right">{it.count}</td>
                    <td className="py-2.5 text-right text-[#9aa0a6]">
                      {it.last_seen.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Error log */}
      <section className="g-card p-6">
        <h2 className="mb-4 font-medium text-[#202124]">Error log</h2>
        {data.recentErrors.length === 0 ? (
          <Empty />
        ) : (
          <div>
            {data.recentErrors.map((e) => (
              <div
                key={e.id}
                className="flex items-start gap-3 border-t border-[#f1f3f4] py-3 text-sm first:border-t-0"
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[e.severity]}`}
                  title={e.severity}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1">
                    <span className="zh text-[#9aa0a6] line-through">{e.my_fragment}</span>{" "}
                    <span className="zh font-medium text-[#202124]">
                      → {e.corrected_fragment}
                    </span>
                    <SpeakButton text={e.corrected_fragment} size="sm" />
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
                    {e.my_pinyin && (
                      <span className="text-[#9aa0a6] line-through">{e.my_pinyin}</span>
                    )}
                    {e.corrected_pinyin && (
                      <span className="text-[#1967d2]">→ {e.corrected_pinyin}</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-[#5f6368]">
                    {e.explanation_short}
                  </p>
                </div>
                <div className="shrink-0 text-right text-xs text-[#9aa0a6]">
                  <p>
                    {e.module !== "composition" && (
                      <span className="mr-1 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-[10px] font-medium text-[#1967d2]">
                        {e.module}
                      </span>
                    )}
                    {e.error_category.replace(/_/g, " ")}
                  </p>
                  <p>
                    {e.created_at.slice(0, 10)}
                    {e.attempt_targeted === 1 && " · targeted"}
                    {e.resolved_count > 0 && ` · resolved ×${e.resolved_count}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-[#9aa0a6]">Nothing here yet — go do some reps.</p>;
}
