"use client";

export type PlayState = "idle" | "loading" | "playing";
export type SpeakVoice = "cantonese" | undefined;

// One shared <audio> element so starting a new clip stops the previous one.
// playGeneration lets a play that was superseded mid-fetch abandon itself.
let sharedAudio: HTMLAudioElement | null = null;
let stopCurrent: (() => void) | null = null;
let playGeneration = 0;

/**
 * How long to wait for the good voice before speaking with the plain one.
 *
 * Short on purpose. Hearing the word now in the browser's built-in voice beats
 * silence followed by a better voice several seconds later — and the neural
 * clip is still fetched in the background, so the next click is instant.
 */
const NEURAL_BUDGET_MS = 3_500;

function speakFallback(text: string, onState: (s: PlayState) => void, voice?: SpeakVoice): void {
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice === "cantonese" ? "zh-HK" : "zh-CN";
    utterance.onend = () => onState("idle");
    utterance.onerror = () => onState("idle");
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
    stopCurrent = () => {
      speechSynthesis.cancel();
      onState("idle");
      stopCurrent = null;
    };
    onState("playing");
  } catch {
    onState("idle");
  }
}

/**
 * Plays a Chinese text: server neural audio first (cached, so usually
 * instant), browser speech synthesis as the fallback. Never leaves the
 * caller stuck: every path ends in an "idle" state change.
 */
export async function playText(
  text: string,
  onState: (s: PlayState) => void,
  voice?: SpeakVoice
): Promise<void> {
  const gen = ++playGeneration;
  stopCurrent?.();
  onState("loading");
  const url = `/api/tts?text=${encodeURIComponent(text)}${voice ? `&voice=${voice}` : ""}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(NEURAL_BUDGET_MS) });
    if (gen !== playGeneration) return;
    if (!res.ok) throw new Error("tts unavailable");
    const blob = await res.blob();
    if (gen !== playGeneration) return;
    const objectUrl = URL.createObjectURL(blob);
    if (!sharedAudio) sharedAudio = new Audio();
    const audio = sharedAudio;
    audio.src = objectUrl;
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      onState("idle");
      if (gen === playGeneration) stopCurrent = null;
    };
    stopCurrent = () => {
      audio.pause();
      cleanup();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    await audio.play();
    if (gen !== playGeneration) return;
    onState("playing");
  } catch {
    if (gen !== playGeneration) {
      onState("idle");
      return;
    }
    // Speak now with the plain voice, and let the good one finish landing in
    // the server's cache so the next click on this word is instant.
    fetch(url).catch(() => {});
    speakFallback(text, onState, voice);
  }
}
