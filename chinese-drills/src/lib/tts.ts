import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { getSettings } from "./settings";
import { toTraditionalHK } from "./zh";

const execFileAsync = promisify(execFile);

export const VOICES = {
  xiaoxiao: "zh-CN-XiaoxiaoNeural",
  yunxi: "zh-CN-YunxiNeural",
} as const;
export type VoiceKey = keyof typeof VOICES;

/** Which language a piece of text should be read in. Undefined = Mandarin. */
export type SpeakVoice = "cantonese" | undefined;

const CANTONESE_EDGE_VOICE = "zh-HK-HiuMaanNeural";
const CANTONESE_SAY_VOICE = "Sinji";

export const MAX_TTS_CHARS = 300;

function audioDir(): string {
  const dir = path.join(process.cwd(), "data", "audio");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface AudioResult {
  file: string;
  contentType: string;
}

function cachePath(text: string, voice: string, ext: string): string {
  const key = crypto.createHash("sha1").update(`${voice}|${text}`).digest("hex");
  return path.join(audioDir(), `${key}.${ext}`);
}

interface VoicePlan {
  edgeVoice: string;
  sayVoice: string;
  /**
   * What is actually sent to the synthesiser. The zh-HK voices are trained on
   * traditional characters and read simplified input poorly, so Cantonese is
   * converted for synthesis only — every cache key, and everything on screen,
   * stays in the simplified text the learner chose.
   */
  spoken: string;
}

function planFor(text: string, voice: SpeakVoice): VoicePlan {
  if (voice === "cantonese") {
    return {
      edgeVoice: CANTONESE_EDGE_VOICE,
      sayVoice: CANTONESE_SAY_VOICE,
      spoken: toTraditionalHK(text),
    };
  }
  const settings = getSettings();
  const voiceKey: VoiceKey = settings.tts_voice === "yunxi" ? "yunxi" : "xiaoxiao";
  return { edgeVoice: VOICES[voiceKey], sayVoice: "Tingting", spoken: text };
}

// Concurrent requests for the same text share one synthesis instead of
// opening N sockets. Held on globalThis to survive dev hot reloads.
const globalForTts = globalThis as unknown as {
  __ttsInflight?: Map<string, Promise<AudioResult>>;
  __ttsClients?: Map<string, unknown>;
  __ttsEdgeDownUntil?: number;
};
function inflight(): Map<string, Promise<AudioResult>> {
  if (!globalForTts.__ttsInflight) globalForTts.__ttsInflight = new Map();
  return globalForTts.__ttsInflight;
}

// The Edge endpoint must never hang the request: it gets a hard time budget,
// after which the local `say` fallback takes over.
const EDGE_TIMEOUT_MS = 8_000;

/**
 * How long to stop trying Edge after it fails.
 *
 * Without this, every single click on a machine that cannot reach the endpoint
 * paid the full 8s timeout before falling back — which is exactly the "ten
 * seconds before it speaks" a user reports. One failure now parks Edge for a
 * while so subsequent clicks go straight to the local voice, and the next
 * background prewarm quietly re-tests it.
 */
const EDGE_COOLDOWN_MS = 10 * 60_000;

function edgeIsParked(): boolean {
  return Date.now() < (globalForTts.__ttsEdgeDownUntil ?? 0);
}

/**
 * Neural TTS via Microsoft Edge's Read-Aloud endpoint (no API key), cached
 * forever on disk. Falls back to the macOS `say` voice if the endpoint is
 * slow or unreachable, so pronunciation still works offline — and never hangs.
 */
export async function getAudio(text: string, voice?: SpeakVoice): Promise<AudioResult> {
  const plan = planFor(text, voice);

  const mp3 = cachePath(text, plan.edgeVoice, "mp3");
  if (fs.existsSync(mp3) && fs.statSync(mp3).size > 0) {
    return { file: mp3, contentType: "audio/mpeg" };
  }

  const key = `${plan.edgeVoice}|${text}`;
  const existing = inflight().get(key);
  if (existing) return existing;

  const m4a = cachePath(text, `say-${plan.sayVoice.toLowerCase()}`, "m4a");

  const job = (async (): Promise<AudioResult> => {
    if (!edgeIsParked()) {
      try {
        await withTimeout(
          synthesizeEdge(plan.spoken, plan.edgeVoice, mp3),
          EDGE_TIMEOUT_MS,
          "edge TTS"
        );
        globalForTts.__ttsEdgeDownUntil = 0;
        return { file: mp3, contentType: "audio/mpeg" };
      } catch (edgeErr) {
        globalForTts.__ttsEdgeDownUntil = Date.now() + EDGE_COOLDOWN_MS;
        console.log(
          `[tts] edge synthesis failed (${edgeErr instanceof Error ? edgeErr.message : edgeErr}); ` +
            `using the local voice for the next ${EDGE_COOLDOWN_MS / 60_000} minutes`
        );
      }
    }
    // Fallback cache is only consulted once Edge is unavailable, so one
    // offline playback never permanently locks a text to the lower-quality voice.
    if (fs.existsSync(m4a) && fs.statSync(m4a).size > 0) {
      return { file: m4a, contentType: "audio/mp4" };
    }
    await synthesizeSay(plan.spoken, plan.sayVoice, m4a); // throws if unavailable
    return { file: m4a, contentType: "audio/mp4" };
  })();

  inflight().set(key, job);
  try {
    return await job;
  } finally {
    inflight().delete(key);
  }
}

/**
 * Best-effort pre-generation so the user's click is a cache hit. Never throws.
 */
export function prewarmAudio(texts: (string | null | undefined)[], voice?: SpeakVoice): void {
  for (const t of texts) {
    const text = t?.trim();
    if (!text || text.length > MAX_TTS_CHARS) continue;
    getAudio(text, voice).catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * One live connection per voice, reused across clicks.
 *
 * Every synthesis used to open a fresh websocket to the Edge endpoint — DNS,
 * TLS and a handshake before a single byte of audio. The library's setMetadata
 * is a no-op while the socket is open and reconnects when it is not, so
 * holding the client is safe and self-healing; a failed call discards it so
 * the next attempt starts clean.
 */
async function edgeClient(voice: string) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  if (!globalForTts.__ttsClients) globalForTts.__ttsClients = new Map();
  const clients = globalForTts.__ttsClients as Map<string, InstanceType<typeof MsEdgeTTS>>;

  let client = clients.get(voice);
  if (!client) {
    client = new MsEdgeTTS();
    clients.set(voice, client);
  }
  await client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  return client;
}

function dropEdgeClient(voice: string): void {
  const clients = globalForTts.__ttsClients as Map<string, { close?: () => void }> | undefined;
  const client = clients?.get(voice);
  if (!client) return;
  try {
    client.close?.();
  } catch {
    /* already gone */
  }
  clients!.delete(voice);
}

async function synthesizeEdge(text: string, voice: string, outFile: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tts-"));
  try {
    const tts = await edgeClient(voice);
    const { audioFilePath } = await tts.toFile(tmp, text);
    const data = fs.readFileSync(audioFilePath);
    if (data.length === 0) throw new Error("edge TTS returned empty audio");
    fs.writeFileSync(outFile, data);
  } catch (err) {
    dropEdgeClient(voice);
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function synthesizeSay(text: string, sayVoice: string, outFile: string): Promise<void> {
  // Leading dashes would be parsed by `say` as flags (e.g. -f reads a file);
  // never pass such text through as a positional argument.
  const safe = text.replace(/^[-\s]+/, "");
  if (!safe) throw new Error("nothing speakable");
  // macOS built-in voice; AAC in .m4a so Chrome can play it.
  await execFileAsync("say", ["-v", sayVoice, "-o", outFile, "--data-format=aacl", safe], {
    timeout: 30_000,
  });
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    throw new Error("say produced no audio");
  }
}
