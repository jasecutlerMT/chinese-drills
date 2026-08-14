"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import { isMostlyChinese } from "@/lib/cjk";

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
}

type Direction = "en2zh" | "zh2en" | "en2yue" | "zh2yue";
type Target = "zh" | "yue";

interface TranslationResult {
  translation: string;
  pinyin: string | null;
  gloss?: string | null;
  romanizationMissing?: boolean;
  direction: Direction;
  source: "claude" | "dictionary";
}

interface HistoryRow {
  id: number;
  input: string;
  translation: string;
  pinyin: string | null;
  direction: Direction;
}

const MAX_INPUT = 1500;

/**
 * Suggestions to fill the box with. The Chinese ones carry their reading and
 * meaning like everything else — a chip you have to click (and spend a call
 * on) to find out what it says is the app failing its own rule in its own UI.
 */
const CANTONESE_PHRASES: { text: string; pinyin?: string; english?: string }[] = [
  { text: "Could we get the bill, please?" },
  { text: "How do I get to the nearest subway station?" },
  {
    text: "唔该，埋单！",
    pinyin: "m4 goi1, maai4 daan1!",
    english: "excuse me — the bill, please!",
  },
  {
    text: "你食咗饭未呀？",
    pinyin: "nei5 sik6 zo2 faan6 mei6 aa3?",
    english: "have you eaten yet?",
  },
];

const QUICK_PHRASES: { text: string; pinyin?: string; english?: string }[] = [
  { text: "Nice to meet you, I've heard a lot about you." },
  { text: "Could we get the bill, please?" },
  { text: "How do I get to the nearest subway station?" },
  { text: "I've been learning Chinese for five years." },
  {
    text: "什么风把你吹来了？",
    pinyin: "shénme fēng bǎ nǐ chuī lái le?",
    english: "what brings you here?",
  },
  {
    text: "我请客，你别跟我抢。",
    pinyin: "wǒ qǐngkè, nǐ bié gēn wǒ qiǎng.",
    english: "it's on me — don't fight me for the bill.",
  },
];

export default function TranslatePage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [target, setTarget] = useState<Target>("zh");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    setSpeechSupported(!!w.webkitSpeechRecognition);
    const saved = localStorage.getItem("translate.target");
    if (saved === "yue" || saved === "zh") setTarget(saved);
    refreshHistory();
  }, []);

  useEffect(() => {
    if (!translating) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => clearInterval(id);
  }, [translating]);

  const refreshHistory = () =>
    fetch("/api/translate")
      .then((r) => r.json())
      .then((d) => setHistory(d.recent ?? []))
      .catch(() => {});

  const translate = useCallback(
    async (text: string, forTarget: Target = target) => {
    // A direct call (button, swap, voice, chip) supersedes any pending debounce.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = text.trim();
    if (!trimmed) {
      setResult(null);
      setStreamText(null);
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setTranslating(true);
    setError(null);
    setResult(null);
    setStreamText("");
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, target: forTarget }),
      });
      if (seq !== seqRef.current) return;
      const contentType = res.headers.get("content-type") ?? "";

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Translation failed");
      }

      if (contentType.includes("text/event-stream") && res.body) {
        // Streamed: render text as Claude writes it.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let acc = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (seq !== seqRef.current) {
            reader.cancel().catch(() => {});
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const evt = JSON.parse(line.slice(6));
            if (evt.delta) {
              acc += evt.delta;
              // Show only the translation part while streaming (before ---).
              setStreamText(acc.split(/\r?\n[ \t]*-{3,}/)[0]);
            } else if (evt.done) {
              setResult(evt);
              setStreamText(null);
              refreshHistory();
            } else if (evt.error) {
              throw new Error(evt.error);
            }
          }
        }
      } else {
        // Instant dictionary answer.
        const d = (await res.json()) as TranslationResult;
        setResult(d);
        setStreamText(null);
        refreshHistory();
      }
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : "Translation failed");
      setResult(null);
      setStreamText(null);
    } finally {
      if (seq === seqRef.current) setTranslating(false);
    }
    },
    [target]
  );

  const chooseTarget = (next: Target) => {
    if (next === target) return;
    setTarget(next);
    localStorage.setItem("translate.target", next);
    if (input.trim()) translate(input, next);
  };

  const onInput = (text: string) => {
    setInput(text);
    setCopied(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => translate(text), 1200);
  };

  const useText = (text: string) => {
    setInput(text);
    setResult(null);
    translate(text);
  };

  const swap = () => {
    if (!result) return;
    useText(result.translation);
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const startVoice = () => {
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    if (!w.webkitSpeechRecognition || listening) return;
    const rec = new w.webkitSpeechRecognition();
    rec.lang =
      isMostlyChinese(input) || input.trim() === "" ? (cantonese ? "zh-HK" : "zh-CN") : "en-US";
    rec.interimResults = false;
    rec.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      useText(transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const chineseIn = isMostlyChinese(input);
  const cantonese = target === "yue";
  const activeDirection: Direction =
    result?.direction ?? (chineseIn ? (cantonese ? "zh2yue" : "zh2en") : cantonese ? "en2yue" : "en2zh");
  const outputIsChinese = activeDirection !== "zh2en";
  const outputVoice = activeDirection.endsWith("yue") ? ("cantonese" as const) : undefined;
  const romanizationLabel = activeDirection.endsWith("yue") ? "Jyutping" : "pinyin";

  return (
    <div className="space-y-5">
      <h1 className="text-[28px] font-normal text-[#202124]">Translate</h1>

      {/* Language chip row, Google Translate style */}
      <div className="flex items-center gap-3">
        <div className="flex gap-1 rounded-full border border-[#dadce0] bg-white p-1">
          <LangChip active={!chineseIn}>
            {input.trim() ? (chineseIn ? "Detected: Chinese" : "Detected: English") : "Detect language"}
          </LangChip>
        </div>
        <button
          onClick={swap}
          disabled={!result}
          title="Use translation as input"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#5f6368] transition-colors hover:bg-[#f1f3f4] disabled:opacity-30"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M7 8h11M15 5l3 3-3 3M17 16H6M9 13l-3 3 3 3" />
          </svg>
        </button>
        <div className="flex gap-1 rounded-full border border-[#dadce0] bg-white p-1">
          {chineseIn && target === "zh" ? (
            <LangChip active>English</LangChip>
          ) : (
            <>
              <LangChip active={target === "zh"} onClick={() => chooseTarget("zh")}>
                Chinese (Simplified)
              </LangChip>
              <LangChip active={target === "yue"} onClick={() => chooseTarget("yue")}>
                Cantonese
              </LangChip>
            </>
          )}
        </div>
      </div>

      {/* Panes */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Input */}
        <div className="g-card flex flex-col p-5">
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value.slice(0, MAX_INPUT))}
            placeholder="Type English or Chinese…"
            rows={6}
            className={`w-full flex-1 resize-none bg-transparent text-xl leading-relaxed outline-none placeholder:text-[#9aa0a6] ${chineseIn ? "zh" : ""}`}
            autoFocus
          />
          {/* Chinese input keeps its own pinyin — the pinyin of Chinese text
              belongs beside the characters, not under the English. */}
          {result?.direction === "zh2en" && result.pinyin && (
            <p className="mt-2 text-sm leading-relaxed text-[#1967d2]">{result.pinyin}</p>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-[#f1f3f4] pt-3">
            <div className="flex items-center gap-1">
              {speechSupported && (
                <button
                  onClick={startVoice}
                  title="Speak"
                  className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                    listening ? "bg-[#fce8e6] text-[#d93025]" : "text-[#1a73e8] hover:bg-[#e8f0fe]"
                  }`}
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z" />
                  </svg>
                </button>
              )}
              {chineseIn && input.trim() && (
              <SpeakButton text={input.trim()} size="md" voice={cantonese ? "cantonese" : undefined} />
            )}
              {input && (
                <button
                  onClick={() => {
                    setInput("");
                    setResult(null);
                    setStreamText(null);
                    setError(null);
                  }}
                  className="g-btn-text"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#9aa0a6]">
                {input.length} / {MAX_INPUT}
              </span>
              <button
                onClick={() => translate(input)}
                disabled={!input.trim() || translating}
                className="g-btn"
              >
                {translating ? `${elapsed.toFixed(1)}s…` : "Translate"}
              </button>
            </div>
          </div>
        </div>

        {/* Output */}
        <div
          className={`flex flex-col rounded-2xl p-5 transition-all ${
            translating
              ? "border-2 border-[#1a73e8]/40 bg-[#e8f0fe]/40"
              : "border border-transparent bg-[#f1f3f4]"
          }`}
        >
          {error ? (
            <div>
              <p className="text-sm text-[#c5221f]">{error}</p>
              <button onClick={() => translate(input)} className="g-btn-text mt-2 -ml-3">
                Try again
              </button>
            </div>
          ) : streamText !== null ? (
            <p className={`flex-1 text-xl leading-relaxed text-[#202124] ${outputIsChinese ? "zh" : ""}`}>
              {streamText}
              <span className="ml-0.5 inline-block h-5 w-0.5 animate-pulse bg-[#1a73e8] align-middle" />
            </p>
          ) : result ? (
            <>
              <p className={`flex-1 text-xl leading-relaxed text-[#202124] ${outputIsChinese ? "zh" : ""}`}>
                {result.translation}
              </p>
              {result.pinyin && outputIsChinese && (
                <p className="mt-2 text-sm leading-relaxed text-[#1967d2]">{result.pinyin}</p>
              )}
              {result.gloss && (
                <p className="mt-1.5 text-sm leading-relaxed text-[#5f6368]">{result.gloss}</p>
              )}
              {result.romanizationMissing && (
                <p className="mt-1.5 text-xs text-[#9aa0a6]">
                  The Jyutping didn&apos;t come back this time — press Try again for it.
                </p>
              )}
              <div className="mt-3 flex items-center gap-1 border-t border-[#e8eaed] pt-3">
                {outputIsChinese && (
                  <SpeakButton text={result.translation} size="md" voice={outputVoice} />
                )}
                <button onClick={copyResult} className="g-btn-text">
                  {copied ? "Copied ✓" : "Copy"}
                </button>
                {result.source === "dictionary" && (
                  <span className="ml-auto rounded-full bg-[#e6f4ea] px-2.5 py-0.5 text-[10px] font-medium text-[#188038]">
                    dictionary · instant
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-xl text-[#9aa0a6]">Translation</p>
          )}
        </div>
      </div>

      {/* Quick phrases */}
      {!input && (
        <div className="flex flex-wrap gap-2">
          {(cantonese ? CANTONESE_PHRASES : QUICK_PHRASES).map((p) => (
            <button
              key={p.text}
              onClick={() => useText(p.text)}
              className="rounded-full border border-[#dadce0] bg-white px-4 py-1.5 text-left text-sm text-[#5f6368] transition-colors hover:border-[#1a73e8] hover:text-[#1a73e8]"
            >
              <span className={isMostlyChinese(p.text) ? "zh" : ""}>{p.text}</span>
              {p.pinyin && (
                <span className="ml-2 text-xs text-[#1967d2]">{p.pinyin}</span>
              )}
              {p.english && (
                <span className="ml-1.5 text-xs text-[#9aa0a6]">{p.english}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* History */}
      {history.length > 0 && !result && !streamText && (
        <div>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#9aa0a6]">
            Recent translations
          </h2>
          <div className="g-card divide-y divide-[#f1f3f4]">
            {history.map((h) => (
              <button
                key={h.id}
                onClick={() => useText(h.input)}
                className="flex w-full items-baseline gap-4 p-3.5 text-left transition-colors hover:bg-[#f8f9fa]"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-sm text-[#202124] ${isMostlyChinese(h.input) ? "zh" : ""}`}
                  >
                    {h.input}
                  </span>
                  {/* The reading was fetched with the translation and stored;
                      showing only characters here threw it away. */}
                  {h.pinyin && h.direction === "zh2en" && (
                    <span className="block truncate text-xs text-[#1967d2]">{h.pinyin}</span>
                  )}
                </span>
                <span className="text-[#9aa0a6]">→</span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-sm text-[#5f6368] ${h.direction !== "zh2en" ? "zh" : ""}`}
                  >
                    {h.translation}
                  </span>
                  {h.pinyin && h.direction !== "zh2en" && (
                    <span className="block truncate text-xs text-[#1967d2]">{h.pinyin}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-[#9aa0a6]">
        Words answer instantly from the built-in dictionary; sentences stream in live as
        they're translated. Chinese is always simplified — Mandarin with pinyin, Cantonese with Jyutping.
      </p>
    </div>
  );
}

function LangChip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const className = `rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
    active ? "bg-[#e8f0fe] text-[#1967d2]" : "text-[#5f6368]"
  } ${onClick && !active ? "hover:bg-[#f1f3f4]" : ""}`;
  // A label when it only reports the detected language, a button when it is a
  // choice the user can make.
  return onClick ? (
    <button onClick={onClick} className={className}>
      {children}
    </button>
  ) : (
    <span className={className}>{children}</span>
  );
}
