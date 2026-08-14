"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import type {
  GeneratedTask,
  GradingResult,
  TaskSize,
  GradedError,
} from "@/lib/types";

interface Stats {
  todayReps: number;
  streak: number;
  dailyTarget: number;
  daily?: { date: string; reps: number }[];
  totals?: {
    totalReps: number;
    avgScoreLast10: number | null;
    errorsResolved: number;
    errorsTotal: number;
  };
}

interface Health {
  ok: boolean;
  message: string;
}

/** What the flashcard deck knows about the lesson range you're about to write in. */
interface DeckLook {
  scoped?: {
    newCards: number;
    learning: number;
    due: number;
    total: number;
    studied: number;
    mature: number;
    newRemainingToday: number;
  };
  focus?: { hanzi: string; pinyin: string; english: string }[];
}

type Phase =
  | "config"
  | "loadingTask"
  | "answering"
  | "grading"
  | "feedback"
  | "microGrading";

const SIZE_LABELS: { value: TaskSize; label: string }[] = [
  { value: "sentence", label: "One sentence" },
  { value: "three_sentences", label: "Three sentences" },
  { value: "paragraph", label: "Short paragraph" },
];

const SEVERITY_STYLE: Record<string, { chip: string; card: string }> = {
  critical: { chip: "bg-[#fce8e6] text-[#c5221f]", card: "border-[#f6aea9]" },
  major: { chip: "bg-[#fef7e0] text-[#b26a00]", card: "border-[#fdd663]" },
  minor: { chip: "bg-[#e8f0fe] text-[#1967d2]", card: "border-[#c6dafc]" },
};

function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

export default function PracticePage() {
  const [phase, setPhase] = useState<Phase>("config");
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [lessonStart, setLessonStart] = useState(6);
  const [lessonEnd, setLessonEnd] = useState(10);
  const [taskSize, setTaskSize] = useState<TaskSize>("three_sentences");
  const [task, setTask] = useState<GeneratedTask | null>(null);
  const [myText, setMyText] = useState("");
  const [grading, setGrading] = useState<GradingResult | null>(null);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [microText, setMicroText] = useState("");
  const [microResult, setMicroResult] = useState<GradingResult | null>(null);
  const [microDone, setMicroDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deck, setDeck] = useState<DeckLook | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = phase === "loadingTask" || phase === "grading" || phase === "microGrading";
  const elapsed = useElapsed(busy);

  const refreshStats = useCallback(async () => {
    const res = await fetch("/api/stats?extended=1");
    if (res.ok) setStats(await res.json());
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    refreshStats();
    checkHealth();
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setLessonStart(s.default_lesson_start);
        setLessonEnd(s.default_lesson_end);
      })
      .catch(() => {});
  }, [refreshStats, checkHealth]);

  // Re-ask the deck whenever the lesson range moves, so the panel always
  // describes the range you're actually about to write in.
  useEffect(() => {
    if (phase !== "config" || lessonEnd < lessonStart) return;
    let live = true;
    fetch(`/api/srs/stats?lessonStart=${lessonStart}&lessonEnd=${lessonEnd}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setDeck(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [phase, lessonStart, lessonEnd]);

  const fetchTask = useCallback(async () => {
    setError(null);
    setPhase("loadingTask");
    setGrading(null);
    setMicroResult(null);
    setMicroDone(false);
    setMicroText("");
    setMyText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonStart, lessonEnd, taskSize }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Task generation failed");
      setTask(data.task);
      setPhase("answering");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : "Task generation failed");
      }
      setPhase("config");
    }
  }, [lessonStart, lessonEnd, taskSize]);

  const cancelTask = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const submitAnswer = useCallback(async () => {
    if (!task || myText.trim().length < 2) return;
    setError(null);
    setPhase("grading");
    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, myText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Grading failed");
      setGrading(data.grading);
      setAttemptId(data.attemptId);
      setPhase("feedback");
      refreshStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grading failed");
      setPhase("answering");
    }
  }, [task, myText, refreshStats]);

  const submitMicro = useCallback(async () => {
    if (!grading?.micro_task || !attemptId || microText.trim().length < 2) return;
    setError(null);
    setPhase("microGrading");
    try {
      const res = await fetch("/api/micro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentAttemptId: attemptId,
          instruction: grading.micro_task.instruction_en,
          sourceSentence: grading.micro_task.source_sentence,
          myText: microText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Micro-task grading failed");
      setMicroResult(data.grading);
      setMicroDone(true);
      setPhase("feedback");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Micro-task grading failed");
      setPhase("feedback");
    }
  }, [grading, attemptId, microText]);

  const microPending = !!grading?.micro_task && !microDone;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-[28px] font-normal text-[#202124]">Practice</h1>
        {stats && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-[#dadce0] bg-white px-4 py-1.5">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[#f1f3f4]">
                <div
                  className="h-full rounded-full bg-[#1a73e8] transition-all duration-500"
                  style={{
                    width: `${Math.min(100, (stats.todayReps / Math.max(1, stats.dailyTarget)) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-sm text-[#5f6368]">
                <span className="font-medium text-[#202124]">
                  {stats.todayReps}/{stats.dailyTarget}
                </span>{" "}
                today
              </span>
            </div>
            <StatPill
              label={stats.streak > 0 ? "🔥" : "Streak"}
              value={`${stats.streak} ${stats.streak === 1 ? "day" : "days"}`}
            />
          </div>
        )}
      </div>

      {stats && stats.todayReps >= stats.dailyTarget && phase === "config" && (
        <div className="g-card g-enter border-[#a8dab5] bg-[#e6f4ea] p-5">
          <p className="font-medium text-[#188038]">
            🎉 Daily goal reached — {stats.todayReps} reps today, streak at {stats.streak}{" "}
            {stats.streak === 1 ? "day" : "days"}.
          </p>
          <p className="mt-1 text-sm text-[#137333]">
            Every rep past this point is bonus consolidation.
          </p>
        </div>
      )}

      {health && !health.ok && (
        <div className="g-card flex items-start gap-3 border-[#fdd663] bg-[#fef7e0] p-4">
          <span className="mt-0.5 text-lg">⚠️</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-[#202124]">Setup needed before practicing</p>
            <p className="mt-1 text-sm text-[#5f6368]">{health.message}</p>
          </div>
          <button onClick={checkHealth} className="g-btn-text shrink-0">
            Check again
          </button>
        </div>
      )}

      {error && (
        <div className="g-card flex items-start gap-3 border-[#f6aea9] bg-[#fce8e6] p-4">
          <span className="mt-0.5 text-lg">✕</span>
          <p className="flex-1 text-sm text-[#c5221f]">{error}</p>
          <button onClick={checkHealth} className="g-btn-text shrink-0">
            Run check
          </button>
        </div>
      )}

      {phase === "config" && stats?.totals && stats.totals.totalReps > 0 && (
        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile label="Total reps" value={String(stats.totals.totalReps)} />
          <StatTile
            label="Avg score · last 10"
            value={stats.totals.avgScoreLast10 != null ? String(stats.totals.avgScoreLast10) : "—"}
          />
          <StatTile
            label="Errors fixed"
            value={`${stats.totals.errorsResolved}/${stats.totals.errorsTotal}`}
          />
          <div className="g-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
              Last 14 days
            </p>
            <ActivityBars daily={stats.daily ?? []} />
          </div>
        </div>
      )}

      {phase === "config" && (
        <div className="g-card p-6">
          <div className="flex flex-wrap items-end gap-5">
            <div>
              <span className="g-label">Lessons from</span>
              <input
                type="number"
                min={1}
                max={40}
                value={lessonStart}
                onChange={(e) => setLessonStart(Number(e.target.value))}
                className="g-input w-20"
              />
            </div>
            <div>
              <span className="g-label">to</span>
              <input
                type="number"
                min={1}
                max={40}
                value={lessonEnd}
                onChange={(e) => setLessonEnd(Number(e.target.value))}
                className="g-input w-20"
              />
            </div>
            <div>
              <span className="g-label">Task size</span>
              <select
                value={taskSize}
                onChange={(e) => setTaskSize(e.target.value as TaskSize)}
                className="g-input"
              >
                {SIZE_LABELS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <button onClick={fetchTask} className="g-btn">
              Start
            </button>
          </div>
          <p className="mt-4 text-xs text-[#9aa0a6]">
            Integrated Chinese Level 1 (lessons 1–20) and Level 2 (21–40)
          </p>
        </div>
      )}

      {phase === "config" && deck?.scoped && deck.scoped.total > 0 && (
        <DeckBridge deck={deck} lessonStart={lessonStart} lessonEnd={lessonEnd} />
      )}

      {phase === "loadingTask" && (
        <div className="g-card p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="g-skeleton h-5 w-3/4" />
            <div className="g-skeleton h-5 w-16 rounded-full" />
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            {[16, 20, 14, 24, 18].map((w, i) => (
              <div key={i} className="g-skeleton h-8 rounded-full" style={{ width: `${w * 4}px` }} />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <div className="g-skeleton h-8 w-40 rounded-full" />
            <div className="g-skeleton h-8 w-32 rounded-full" />
          </div>
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-[#5f6368]">
              Writing your task from lessons {lessonStart}–{lessonEnd}…{" "}
              <span className="tabular-nums">{elapsed}s</span>
            </p>
            <button onClick={cancelTask} className="g-btn-text">
              Cancel
            </button>
          </div>
        </div>
      )}

      {(phase === "answering" || phase === "grading") && task && (
        <div className="space-y-4">
          <TaskCard task={task} />
          <div className="g-card p-6">
            <textarea
              value={myText}
              onChange={(e) => setMyText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submitAnswer();
                }
              }}
              disabled={phase === "grading"}
              placeholder="用简体字写你的回答……（⌘Enter 提交）"
              rows={taskSize === "paragraph" ? 6 : 3}
              className="zh w-full resize-y rounded-xl border border-[#dadce0] p-4 text-lg leading-relaxed outline-none transition-colors focus:border-[#1a73e8] focus:shadow-[0_0_0_1px_#1a73e8] disabled:bg-[#f8f9fa]"
              autoFocus
            />
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-[#9aa0a6]">
                {myText.length > 0 ? `${myText.length} characters` : "Typed simplified Chinese"}
              </span>
              <button
                onClick={submitAnswer}
                disabled={phase === "grading" || myText.trim().length < 2}
                className="g-btn"
              >
                {phase === "grading" ? (
                  <>
                    <span className="g-spinner !h-4 !w-4 !border-2 !border-white/40 !border-t-white" />
                    Grading… {elapsed}s
                  </>
                ) : (
                  "Submit"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {(phase === "feedback" || phase === "microGrading") && task && grading && (
        <div className="space-y-4">
          <TaskCard task={task} compact />
          <FeedbackCard grading={grading} myText={myText} />

          {grading.micro_task && (
            <div className="g-card border-[#fdd663] p-6">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-[#fef7e0] px-3 py-1 text-xs font-medium text-[#b26a00]">
                  Micro-task
                </span>
                <span className="text-xs text-[#9aa0a6]">apply the fix before the next rep</span>
              </div>
              <p className="mt-3 text-sm text-[#202124]">{grading.micro_task.instruction_en}</p>
              <div className="mt-2 flex items-start gap-2 rounded-xl bg-[#f8f9fa] p-3">
                <div className="flex-1">
                  <p className="zh text-lg">{grading.micro_task.source_sentence}</p>
                  {grading.micro_task.source_sentence_pinyin && (
                    <p className="mt-0.5 text-xs text-[#1967d2]">
                      {grading.micro_task.source_sentence_pinyin}
                    </p>
                  )}
                </div>
                <SpeakButton text={grading.micro_task.source_sentence} size="sm" />
              </div>
              {!microDone ? (
                <>
                  <textarea
                    value={microText}
                    onChange={(e) => setMicroText(e.target.value)}
                    disabled={phase === "microGrading"}
                    rows={2}
                    placeholder="重写这个句子……"
                    className="zh mt-3 w-full rounded-xl border border-[#dadce0] p-3 text-lg outline-none focus:border-[#1a73e8] focus:shadow-[0_0_0_1px_#1a73e8] disabled:bg-[#f8f9fa]"
                  />
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      onClick={submitMicro}
                      disabled={phase === "microGrading" || microText.trim().length < 2}
                      className="g-btn"
                    >
                      {phase === "microGrading" ? `Checking… ${elapsed}s` : "Check rewrite"}
                    </button>
                    <button onClick={() => setMicroDone(true)} className="g-btn-text">
                      Skip
                    </button>
                  </div>
                </>
              ) : microResult ? (
                <div className="mt-4 rounded-xl bg-[#f8f9fa] p-4 text-sm">
                  {microResult.errors.length === 0 ? (
                    <p className="text-[#188038]">✓ {microResult.what_worked}</p>
                  ) : (
                    <div className="space-y-2">
                      <p className="font-medium text-[#b26a00]">Not quite:</p>
                      {microResult.errors.map((e, i) => (
                        <ErrorItem key={i} error={e} />
                      ))}
                      <div>
                        <p className="zh text-base">→ {microResult.corrected_text}</p>
                        {microResult.corrected_pinyin && (
                          <p className="text-xs text-[#1967d2]">{microResult.corrected_pinyin}</p>
                        )}
                        {microResult.corrected_english && (
                          <p className="text-xs text-[#5f6368]">
                            {microResult.corrected_english}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-xs text-[#9aa0a6]">Skipped.</p>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={fetchTask}
              disabled={microPending || phase === "microGrading"}
              title={microPending ? "Complete the micro-task first" : undefined}
              className="g-btn"
            >
              Next task →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The bridge between the two halves of the app: what the flashcard deck owes
 * you inside this lesson range, and the words it can already see you wobbling
 * on — which is exactly what the generator will aim the next task at.
 */
function DeckBridge({
  deck,
  lessonStart,
  lessonEnd,
}: {
  deck: DeckLook;
  lessonStart: number;
  lessonEnd: number;
}) {
  const s = deck.scoped!;
  const focus = deck.focus ?? [];
  // What today actually holds, not the whole backlog: new cards are rationed
  // by the daily limit, so promising all 319 of them would be a lie.
  const waiting = Math.min(s.newCards, s.newRemainingToday) + s.learning + s.due;
  const pct = s.total > 0 ? Math.round((s.studied / s.total) * 100) : 0;

  return (
    <div className="g-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-medium text-[#202124]">
          Your memory of lessons {lessonStart}–{lessonEnd}{" "}
          <span className="zh ml-1 text-[#9aa0a6]">记忆</span>{" "}
          <span className="text-sm font-normal text-[#9aa0a6]">jìyì</span>
        </h2>
        <a href="/study" className="g-btn-text">
          {waiting > 0
            ? `${waiting} ${waiting === 1 ? "card" : "cards"} for today →`
            : "Open flashcards →"}
        </a>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#e8eaed]">
          <div className="h-full rounded-full bg-[#1a73e8]" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-xs text-[#5f6368]">
          <span className="font-medium text-[#202124]">{s.studied}</span>/{s.total} started ·{" "}
          <span className="font-medium text-[#202124]">{s.mature}</span> solid
        </span>
      </div>

      {focus.length > 0 ? (
        <>
          <p className="mt-6 text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
            Shaky right now — the next task will try to use these
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {focus.map((w) => (
              <div key={w.hanzi} className="rounded-xl border border-[#e8eaed] px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="zh text-lg text-[#202124]">{w.hanzi}</span>
                  <span className="text-sm text-[#1a73e8]">{w.pinyin}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-[#5f6368]" title={w.english}>
                  {w.english}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-4 text-sm text-[#5f6368]">
          Nothing shaky in this range yet. Review a few flashcards and the words you keep
          forgetting will show up here — and in your writing tasks.
        </p>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="g-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">{label}</p>
      <p className="mt-1 text-2xl font-medium text-[#202124]">{value}</p>
    </div>
  );
}

/**
 * 14-day rep activity as a single-hue bar sparkline: today in full brand
 * blue, earlier days in the light step of the same hue; no legend (single
 * series — the tile label names it); native tooltips carry exact values.
 */
function ActivityBars({ daily }: { daily: { date: string; reps: number }[] }) {
  if (daily.length === 0) return null;
  const max = Math.max(1, ...daily.map((d) => d.reps));
  return (
    <div className="mt-2 flex h-10 items-end gap-[2px]" role="img" aria-label="Reps per day, last 14 days">
      {daily.map((d, i) => {
        const isToday = i === daily.length - 1;
        const h = d.reps === 0 ? 2 : Math.max(4, Math.round((d.reps / max) * 36));
        return (
          <div
            key={d.date}
            title={`${d.date}: ${d.reps} ${d.reps === 1 ? "rep" : "reps"}`}
            className="flex-1 rounded-t-[3px]"
            style={{
              height: `${h}px`,
              background: d.reps === 0 ? "#f1f3f4" : isToday ? "#1a73e8" : "#c6dafc",
            }}
          />
        );
      })}
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-[#dadce0] bg-white px-4 py-1.5 text-sm text-[#5f6368]">
      {label}: <span className="font-medium text-[#202124]">{value}</span>
    </span>
  );
}

function TaskCard({ task, compact }: { task: GeneratedTask; compact?: boolean }) {
  return (
    <div className="g-card p-6">
      <div className="flex items-start justify-between gap-4">
        <p className={compact ? "text-sm text-[#5f6368]" : "text-base leading-relaxed"}>
          {task.prompt_en}
        </p>
        <div className="flex shrink-0 gap-2">
          {task.targeted && (
            <span className="rounded-full bg-[#f1f3f4] px-3 py-1 text-[11px] font-medium text-[#5f6368]">
              targeted
            </span>
          )}
          <span className="rounded-full bg-[#f1f3f4] px-3 py-1 text-[11px] font-medium text-[#5f6368]">
            level {task.difficulty}
          </span>
        </div>
      </div>
      {!compact && (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap gap-2">
            {task.target_vocab.map((v) => (
              <span
                key={v.hanzi}
                className="rounded-full bg-[#f1f3f4] px-3.5 py-1.5 text-sm"
                title={v.english}
              >
                <span className="zh font-medium text-[#202124]">{v.hanzi}</span>{" "}
                <span className="text-xs text-[#5f6368]">
                  {v.pinyin} · {v.english}
                </span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {task.target_grammar.map((g) => (
              <span
                key={g.pattern}
                className="rounded-xl bg-[#e8f0fe] px-3.5 py-2 text-sm leading-tight"
              >
                <span className="zh font-medium text-[#1967d2]">{g.pattern}</span>
                {g.pinyin && (
                  <span className="ml-1.5 text-xs text-[#1967d2]/80">{g.pinyin}</span>
                )}
                <span className="mt-0.5 block text-xs text-[#5f6368]">{g.description}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const [offset, setOffset] = useState(2 * Math.PI * 22);
  const circumference = 2 * Math.PI * 22;
  const color =
    score >= 90 ? "#188038" : score >= 70 ? "#1a73e8" : score >= 40 ? "#f9ab00" : "#d93025";
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      setOffset(circumference * (1 - score / 100))
    );
    return () => cancelAnimationFrame(id);
  }, [score, circumference]);
  return (
    <div className="relative h-14 w-14">
      <svg viewBox="0 0 52 52" className="h-14 w-14 -rotate-90">
        <circle cx="26" cy="26" r="22" fill="none" strokeWidth="5" className="g-ring-track" />
        <circle
          cx="26"
          cy="26"
          r="22"
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="g-ring-value"
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-sm font-semibold"
        style={{ color }}
      >
        {score}
      </span>
    </div>
  );
}

function FeedbackCard({ grading, myText }: { grading: GradingResult; myText: string }) {
  return (
    <div className="g-card g-enter space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[#9aa0a6]">
          Feedback
        </h2>
        <ScoreRing score={grading.overall_score} />
      </div>

      <p className="text-sm text-[#188038]">✓ {grading.what_worked}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-[#f8f9fa] p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
              You wrote
            </p>
            <SpeakButton text={myText} size="sm" />
          </div>
          <p className="zh text-lg leading-relaxed">{myText}</p>
          {grading.my_text_pinyin && (
            <p className="mt-1 text-sm leading-snug text-[#1967d2]">{grading.my_text_pinyin}</p>
          )}
          {grading.my_text_english && (
            <p className="mt-0.5 text-sm leading-snug text-[#5f6368]">
              {grading.my_text_english}
            </p>
          )}
        </div>
        <div className="rounded-xl bg-[#e6f4ea] p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-[#188038]">
              Natural version
            </p>
            <SpeakButton text={grading.corrected_text} size="sm" />
          </div>
          <p className="zh text-lg leading-relaxed">{grading.corrected_text}</p>
          {grading.corrected_pinyin && (
            <p className="mt-1 text-sm leading-snug text-[#1967d2]">{grading.corrected_pinyin}</p>
          )}
          {grading.corrected_english && (
            <p className="mt-0.5 text-sm leading-snug text-[#5f6368]">
              {grading.corrected_english}
            </p>
          )}
        </div>
      </div>

      {grading.errors.length > 0 ? (
        <div className="space-y-2">
          {grading.errors.map((e, i) => (
            <ErrorItem key={i} error={e} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-[#5f6368]">
          No errors
          {grading.overall_score >= 90 ? " — the next task will be a notch harder." : "."}
        </p>
      )}
    </div>
  );
}

function ErrorItem({ error }: { error: GradedError }) {
  const style = SEVERITY_STYLE[error.severity] ?? SEVERITY_STYLE.minor;
  return (
    <div className={`rounded-xl border bg-white p-4 text-sm ${style.card}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${style.chip}`}>
          {error.error_category.replace(/_/g, " ")}
        </span>
        <span className="text-[11px] text-[#9aa0a6]">{error.severity}</span>
        {error.target_item && (
          <span className="zh text-[11px] text-[#9aa0a6]">· {error.target_item}</span>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-1">
        <span className="zh text-[#9aa0a6] line-through">{error.my_fragment}</span>{" "}
        <span className="zh font-medium text-[#202124]">→ {error.corrected_fragment}</span>
        <SpeakButton text={error.corrected_fragment} size="sm" />
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
        {error.my_fragment_pinyin && (
          <span className="text-[#9aa0a6] line-through">{error.my_fragment_pinyin}</span>
        )}
        {error.corrected_fragment_pinyin && (
          <span className="text-[#1967d2]">→ {error.corrected_fragment_pinyin}</span>
        )}
      </p>
      <p className="mt-1.5 leading-relaxed text-[#5f6368]">{error.explanation_short}</p>
    </div>
  );
}
