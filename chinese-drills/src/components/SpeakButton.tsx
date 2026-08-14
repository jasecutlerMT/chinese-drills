"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { playText, type PlayState, type SpeakVoice } from "./audio";

/**
 * Speaker button for any Chinese text. Plays neural TTS from /api/tts
 * (cached server-side); if that fails, falls back to the browser's own
 * speech synthesis so the button never dead-ends.
 */
export default function SpeakButton({
  text,
  size = "md",
  className = "",
  voice,
}: {
  text: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Which language to read it in. Omitted = Mandarin. */
  voice?: SpeakVoice;
}) {
  const [state, setState] = useState<PlayState>("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const play = useCallback(() => {
    playText(
      text,
      (s) => {
        if (mounted.current) setState(s);
      },
      voice
    );
  }, [text, voice]);

  const px = { sm: "h-6 w-6", md: "h-8 w-8", lg: "h-9 w-9" }[size];
  const icon = { sm: "h-3.5 w-3.5", md: "h-4 w-4", lg: "h-5 w-5" }[size];

  return (
    <button
      onClick={play}
      disabled={state === "loading"}
      title="Listen"
      aria-label={`Pronounce ${text}`}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-colors ${px} ${
        state === "playing"
          ? "bg-[#e8f0fe] text-[#1a73e8]"
          : "text-[#1a73e8] hover:bg-[#e8f0fe]"
      } ${className}`}
    >
      {state === "loading" ? (
        <span className={`g-spinner !border-2 ${icon}`} />
      ) : (
        <svg className={icon} viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 10v4h4l5 5V5L7 10H3z" />
          <path
            d="M16 8.5a4.5 4.5 0 010 7M18.5 6a8 8 0 010 12"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
            className={state === "playing" ? "animate-pulse" : ""}
          />
        </svg>
      )}
    </button>
  );
}
