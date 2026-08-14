"use client";

import { useEffect, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import { VOICE_SAMPLE } from "@/lib/voice-sample";

interface UpdateCheck {
  current: { version: number; label: string };
  latest: { version: number; label: string } | null;
  updateAvailable: boolean;
  error?: string;
}

type UpdateState = "idle" | "checking" | "upToDate" | "available" | "updating" | "failed";

function UpdatePanel() {
  const [state, setState] = useState<UpdateState>("idle");
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // Show the current version instantly — ?local=1 never touches the network.
    fetch("/api/update?local=1")
      .then((r) => r.json())
      .then((d: { current: UpdateCheck["current"] }) =>
        setCheck({ current: d.current, latest: null, updateAvailable: false })
      )
      .catch(() => {});
  }, []);

  const runCheck = async () => {
    setState("checking");
    setMessage(null);
    try {
      const res = await fetch("/api/update");
      const d: UpdateCheck = await res.json();
      setCheck(d);
      if (d.error) {
        setState("failed");
        setMessage(d.error);
      } else {
        setState(d.updateAvailable ? "available" : "upToDate");
      }
    } catch {
      setState("failed");
      setMessage("Couldn't check for updates. Are you online?");
    }
  };

  const runUpdate = async () => {
    setState("updating");
    setMessage("Downloading and installing the update — this takes a minute or two…");
    try {
      const res = await fetch("/api/update", { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Update failed to start");
      const fromVersion: number = d.from;
      // The update runs in a separate process and restarts the server when
      // done. Poll the (network-free) local version until it increases.
      const started = Date.now();
      const poll = setInterval(async () => {
        try {
          const v = await fetch("/api/update?local=1", { cache: "no-store" });
          if (v.ok) {
            const dv = await v.json();
            if (dv.current.version > fromVersion) {
              clearInterval(poll);
              setMessage("Updated — reloading…");
              setTimeout(() => location.reload(), 800);
            }
          }
        } catch {
          /* server restarting — keep polling */
        }
        if (Date.now() - started > 300_000) {
          clearInterval(poll);
          try {
            const lg = await fetch("/api/update?log=1", { cache: "no-store" });
            const { log } = await lg.json();
            const lastLine = String(log).trim().split("\n").slice(-2).join(" · ");
            setMessage(
              `The update didn't finish (${lastLine || "no details"}). Your current version still works. Close this tab and double-click Start Chinese Drills to restart.`
            );
          } catch {
            setMessage(
              "The update didn't finish, but your current version still works. Close this tab and double-click Start Chinese Drills to restart."
            );
          }
          setState("failed");
        }
      }, 2500);
    } catch (e) {
      setState("failed");
      setMessage(e instanceof Error ? e.message : "Update failed");
    }
  };

  return (
    <div className="g-card space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-[#202124]">
            App version {check ? check.current.version : "…"}
          </p>
          {check && <p className="mt-0.5 text-xs text-[#9aa0a6]">{check.current.label}</p>}
        </div>
        {state === "available" ? (
          <button onClick={runUpdate} className="g-btn shrink-0">
            Update now
          </button>
        ) : (
          <button
            onClick={runCheck}
            disabled={state === "checking" || state === "updating"}
            className="g-btn-text shrink-0"
          >
            {state === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
      {state === "upToDate" && (
        <p className="text-sm text-[#188038]">✓ You&apos;re on the latest version.</p>
      )}
      {state === "available" && check?.latest && (
        <p className="text-sm text-[#5f6368]">
          Version {check.latest.version} is available: {check.latest.label}
        </p>
      )}
      {state === "updating" && (
        <div className="flex items-center gap-3 text-sm text-[#5f6368]">
          <div className="g-spinner !h-4 !w-4 !border-2" />
          {message}
        </div>
      )}
      {state === "failed" && message && <p className="text-sm text-[#c5221f]">{message}</p>}
    </div>
  );
}

function DeckPanel() {
  const [info, setInfo] = useState<{
    books: { book: string; words: number }[];
    totalWords: number;
    counts: { total: number; studied: number };
  } | null>(null);
  const [state, setState] = useState<"idle" | "syncing" | "done" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () =>
    fetch("/api/srs/build")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  const sync = async () => {
    setState("syncing");
    setMessage(null);
    try {
      const res = await fetch("/api/srs/build", { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Sync failed");
      const parts = [
        `${d.created} new card${d.created === 1 ? "" : "s"} added`,
        `${d.updated} refreshed`,
      ];
      // Only mention the unusual outcomes, and say what "retired" means —
      // nothing was deleted, so a word you put back comes back with its history.
      if (d.revived) parts.push(`${d.revived} brought back`);
      if (d.retired) {
        parts.push(
          `${d.retired} set aside for words no longer in your lesson data (not deleted — put the word back and its history returns)`
        );
      }
      setMessage(`${parts.join(", ")}. Your review progress was kept.`);
      setState("done");
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
      setState("failed");
    }
  };

  return (
    <div className="g-card flex items-start justify-between gap-4 p-6">
      <div>
        <p className="text-sm font-medium text-[#202124]">Flashcard deck</p>
        <p className="mt-0.5 text-xs leading-relaxed text-[#9aa0a6]">
          {info
            ? `${info.totalWords} words in your textbook data · ${info.counts.total} cards built · ${info.counts.studied} started`
            : "…"}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-[#9aa0a6]">
          Edited <code className="rounded bg-[#f1f3f4] px-1">data/lessons.json</code>? Sync to
          fold your corrections into the deck — cards you&apos;ve already learned keep their
          schedule.
        </p>
        {message && (
          <p className={`mt-2 text-sm ${state === "failed" ? "text-[#c5221f]" : "text-[#188038]"}`}>
            {message}
          </p>
        )}
      </div>
      <button onClick={sync} disabled={state === "syncing"} className="g-btn-text shrink-0">
        {state === "syncing" ? "Syncing…" : "Sync deck"}
      </button>
    </div>
  );
}

function SpeedPanel() {
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const run = async () => {
    setState("running");
    setMessage(null);
    try {
      const res = await fetch("/api/health?speed=1");
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || "Speed test failed");
      setMessage(`Claude answered in ${(d.ms / 1000).toFixed(1)}s — ${d.verdict}.`);
      setState("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Speed test failed");
      setState("failed");
    }
  };

  return (
    <div className="g-card flex items-center justify-between gap-4 p-6">
      <div>
        <p className="text-sm font-medium text-[#202124]">Claude speed test</p>
        <p className="mt-0.5 text-xs text-[#9aa0a6]">
          Times one real round trip — run this if the app ever feels slow.
        </p>
        {message && (
          <p className={`mt-2 text-sm ${state === "failed" ? "text-[#c5221f]" : "text-[#188038]"}`}>
            {message}
          </p>
        )}
      </div>
      <button onClick={run} disabled={state === "running"} className="g-btn-text shrink-0">
        {state === "running" ? "Testing…" : "Run test"}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [start, setStart] = useState(6);
  const [end, setEnd] = useState(10);
  const [target, setTarget] = useState(10);
  const [voice, setVoice] = useState<"xiaoxiao" | "yunxi">("xiaoxiao");
  const [newPerDay, setNewPerDay] = useState(20);
  const [maxReviews, setMaxReviews] = useState(200);
  const [directions, setDirections] = useState<"recognize" | "both">("both");
  const [includeChars, setIncludeChars] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setStart(s.default_lesson_start);
        setEnd(s.default_lesson_end);
        setTarget(s.daily_rep_target);
        if (s.tts_voice) setVoice(s.tts_voice);
        if (s.srs_new_per_day != null) setNewPerDay(s.srs_new_per_day);
        if (s.srs_max_reviews != null) setMaxReviews(s.srs_max_reviews);
        if (s.srs_directions) setDirections(s.srs_directions);
        if (typeof s.srs_include_characters === "boolean") setIncludeChars(s.srs_include_characters);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setError(null);
    setSaved(false);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        default_lesson_start: start,
        default_lesson_end: end,
        daily_rep_target: target,
        tts_voice: voice,
        srs_new_per_day: newPerDay,
        srs_max_reviews: maxReviews,
        srs_directions: directions,
        srs_include_characters: includeChars,
      }),
    });
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      const d = await res.json();
      setError(d.error || "Save failed");
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-[28px] font-normal text-[#202124]">Settings</h1>

      <div className="g-card space-y-6 p-6">
        <div>
          <p className="mb-3 text-sm font-medium text-[#202124]">Default lesson range</p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              max={40}
              value={start}
              onChange={(e) => setStart(Number(e.target.value))}
              className="g-input w-20"
            />
            <span className="text-sm text-[#9aa0a6]">to</span>
            <input
              type="number"
              min={1}
              max={40}
              value={end}
              onChange={(e) => setEnd(Number(e.target.value))}
              className="g-input w-20"
            />
          </div>
          <p className="mt-2 text-xs text-[#9aa0a6]">
            Integrated Chinese Level 1 (1–20) and Level 2 (21–40)
          </p>
        </div>

        <div>
          <p className="mb-3 text-sm font-medium text-[#202124]">Daily rep target</p>
          <input
            type="number"
            min={1}
            max={100}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="g-input w-20"
          />
        </div>

        <div>
          <p className="mb-3 text-sm font-medium text-[#202124]">Pronunciation voice</p>
          <div className="flex items-center gap-3">
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value as "xiaoxiao" | "yunxi")}
              className="g-input"
            >
              <option value="xiaoxiao">Xiaoxiao 晓晓 (female)</option>
              <option value="yunxi">Yunxi 云希 (male)</option>
            </select>
            <span className="text-xs text-[#9aa0a6]">save, then test →</span>
            <SpeakButton text={VOICE_SAMPLE} />
          </div>
        </div>

        <div className="border-t border-[#f1f3f4] pt-5">
          <p className="text-sm font-medium text-[#202124]">
            Flashcards <span className="zh text-[#9aa0a6]">抽认卡</span>{" "}
            <span className="text-xs font-normal text-[#9aa0a6]">chōurènkǎ</span>
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-5">
            <div>
              <span className="g-label">New cards / day</span>
              <input
                type="number"
                min={0}
                max={500}
                value={newPerDay}
                onChange={(e) => setNewPerDay(Number(e.target.value))}
                className="g-input w-24"
              />
            </div>
            <div>
              <span className="g-label">Max reviews / day</span>
              <input
                type="number"
                min={10}
                max={9999}
                value={maxReviews}
                onChange={(e) => setMaxReviews(Number(e.target.value))}
                className="g-input w-24"
              />
            </div>
            <div>
              <span className="g-label">Card types</span>
              <select
                value={directions}
                onChange={(e) => setDirections(e.target.value as "recognize" | "both")}
                className="g-input"
              >
                <option value="both">Recognise + write</option>
                <option value="recognize">Recognise only</option>
              </select>
            </div>
          </div>
          <p className="mt-2 text-xs text-[#9aa0a6]">
            &ldquo;Recognise + write&rdquo; adds a second card per word (English → characters),
            unlocked once you know the word by sight.
          </p>
          <label className="mt-3 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={includeChars}
              onChange={(e) => setIncludeChars(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#1a73e8]"
            />
            <span className="text-xs leading-relaxed text-[#5f6368]">
              Also test single characters that only appear inside words — e.g.{" "}
              <span className="zh">咖</span> (kā) from <span className="zh">咖啡</span> (kāfēi,
              coffee). Adds roughly a thousand extra cards across both levels.
            </span>
          </label>
        </div>

        <div className="flex items-center gap-4">
          <button onClick={save} className="g-btn">
            Save
          </button>
          {saved && <span className="text-sm text-[#188038]">Saved ✓</span>}
          {error && <span className="text-sm text-[#c5221f]">{error}</span>}
        </div>
      </div>

      <DeckPanel />

      <SpeedPanel />

      <UpdatePanel />

      <p className="text-xs leading-relaxed text-[#9aa0a6]">
        Lesson content lives in <code className="rounded bg-[#f1f3f4] px-1">data/lessons.json</code>{" "}
        — reconstructed, not scanned; hand-edit it against your textbook and press Sync deck.
        Your practice history lives in{" "}
        <code className="rounded bg-[#f1f3f4] px-1">data/drills.db</code>, which updates never
        touch. Updates do refresh the lesson file while it is still exactly as shipped; once
        you have edited it they leave your copy alone and leave the new version beside it as{" "}
        <code className="rounded bg-[#f1f3f4] px-1">data/lessons.incoming.json</code>.
      </p>
    </div>
  );
}
