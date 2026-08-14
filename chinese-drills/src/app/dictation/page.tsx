"use client";

import { useCallback, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import { playText } from "@/components/audio";
import type { DictationTask, DictationGrade } from "@/lib/dictation";

type Phase = "idle" | "loading" | "listening" | "feedback";

export default function DictationPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [task, setTask] = useState<DictationTask | null>(null);
  const [typed, setTyped] = useState("");
  const [grade, setGrade] = useState<DictationGrade | null>(null);
  const [plays, setPlays] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchTask = useCallback(async () => {
    setError(null);
    setPhase("loading");
    setGrade(null);
    setTyped("");
    setPlays(0);
    try {
      const res = await fetch("/api/dictation");
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not create a dictation");
      setTask(d.task);
      setPhase("listening");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a dictation");
      setPhase("idle");
    }
  }, []);

  const play = useCallback(() => {
    if (!task || playing) return;
    let counted = false;
    playText(task.sentence, (s) => {
      setPlaying(s !== "idle");
      if (s === "playing" && !counted) {
        counted = true;
        setPlays((n) => n + 1);
      }
    });
  }, [task, playing]);

  const submit = useCallback(async () => {
    if (!task || typed.trim().length === 0 || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/dictation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, myText: typed }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Grading failed");
      setGrade(d.grade);
      setPhase("feedback");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grading failed");
    } finally {
      setSubmitting(false);
    }
  }, [task, typed, submitting]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-[28px] font-normal text-[#202124]">
          Dictation <span className="zh text-xl text-[#9aa0a6]">听写</span>
        </h1>
        {task && (
          <span className="rounded-full bg-[#f1f3f4] px-3 py-1 text-[11px] font-medium text-[#5f6368]">
            lessons {task.lesson_start}–{task.lesson_end}
            {task.targeted && " · targeted"}
          </span>
        )}
      </div>

      {error && (
        <div className="g-card border-[#f6aea9] bg-[#fce8e6] p-4 text-sm text-[#c5221f]">
          {error}
        </div>
      )}

      {phase === "idle" && (
        <div className="g-card p-8 text-center">
          <p className="text-[#5f6368]">
            Hear a sentence built from your lesson range, type exactly what you heard.
            Every miss goes into your error log.
          </p>
          <button onClick={fetchTask} className="g-btn mt-5">
            Start dictation
          </button>
          <p className="mt-3 text-xs text-[#9aa0a6]">
            Uses your default lesson range from Settings.
          </p>
        </div>
      )}

      {phase === "loading" && (
        <div className="g-card flex flex-col items-center gap-4 p-12">
          <div className="g-spinner" />
          <p className="text-sm text-[#5f6368]">Writing a sentence and preparing the audio…</p>
        </div>
      )}

      {phase === "listening" && task && (
        <div className="g-card g-enter p-8">
          <div className="flex flex-col items-center gap-4">
            <button
              onClick={play}
              className={`flex h-20 w-20 items-center justify-center rounded-full text-white shadow-lg transition-all ${
                playing ? "scale-95 bg-[#1765cc]" : "bg-[#1a73e8] hover:scale-105 hover:bg-[#1765cc]"
              }`}
              title="Play the sentence"
            >
              <svg className="h-9 w-9" viewBox="0 0 24 24" fill="currentColor">
                {playing ? (
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                ) : (
                  <path d="M8 5v14l11-7z" />
                )}
              </svg>
            </button>
            <p className="text-xs text-[#9aa0a6]">
              {plays === 0 ? "Press play and listen carefully" : `Played ${plays}×`}
            </p>
          </div>

          <textarea
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="听到什么就写什么……"
            rows={2}
            className="zh mt-6 w-full resize-none rounded-xl border border-[#dadce0] p-4 text-xl leading-relaxed outline-none transition-colors focus:border-[#1a73e8] focus:shadow-[0_0_0_1px_#1a73e8]"
            autoFocus
          />
          <div className="mt-4 flex justify-end">
            <button
              onClick={submit}
              disabled={typed.trim().length === 0 || submitting}
              className="g-btn"
            >
              {submitting ? "Checking…" : "Check"}
            </button>
          </div>
        </div>
      )}

      {phase === "feedback" && task && grade && (
        <div className="space-y-4">
          <div className="g-card g-enter space-y-5 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-wider text-[#9aa0a6]">
                {grade.perfect ? "Perfect!" : "How you heard it"}
              </h2>
              <span
                className={`flex h-12 w-12 items-center justify-center rounded-full text-base font-semibold ${
                  grade.score >= 90
                    ? "bg-[#e6f4ea] text-[#188038]"
                    : grade.score >= 60
                      ? "bg-[#fef7e0] text-[#b26a00]"
                      : "bg-[#fce8e6] text-[#c5221f]"
                }`}
              >
                {grade.score}
              </span>
            </div>

            {/* Aligned comparison */}
            <div className="rounded-xl bg-[#f8f9fa] p-4">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6]">
                You typed
              </p>
              <p className="zh text-xl leading-relaxed">
                {grade.segments.map((s, i) =>
                  s.got ? (
                    <span
                      key={i}
                      className={
                        s.type === "match"
                          ? ""
                          : "rounded bg-[#fce8e6] px-0.5 text-[#c5221f] line-through"
                      }
                    >
                      {s.got}
                    </span>
                  ) : (
                    <span key={i} className="rounded bg-[#fef7e0] px-1 text-[#b26a00]">
                      ⌄
                    </span>
                  )
                )}
              </p>
            </div>
            <div className="rounded-xl bg-[#e6f4ea] p-4">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[#188038]">
                  The audio said
                </p>
                <SpeakButton text={task.sentence} size="sm" />
              </div>
              <p className="zh text-xl leading-relaxed">
                {grade.segments.map((s, i) =>
                  s.expected ? (
                    <span key={i} className={s.type === "match" ? "" : "font-semibold text-[#188038]"}>
                      {s.expected}
                    </span>
                  ) : null
                )}
              </p>
              <p className="mt-2 text-sm text-[#1967d2]">{task.pinyin}</p>
              <p className="mt-0.5 text-sm text-[#5f6368]">{task.english}</p>
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={fetchTask} className="g-btn">
              Next sentence →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
