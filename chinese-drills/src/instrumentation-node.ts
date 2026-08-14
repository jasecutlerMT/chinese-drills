/**
 * Runs once when the Next.js server starts (node runtime only). Fires a tiny
 * background ping at the claude CLI so any one-time startup cost (version
 * checks, cache creation) is paid before the user's first real request.
 */
import { getProvider } from "./lib/llm/cli-provider";

const started = Date.now();
getProvider()
  .complete({
    prompt: 'Reply with ONLY this JSON: {"ok":true}',
    system: "You reply with strict JSON only.",
    tier: "fast",
    timeoutMs: 120_000,
    background: true,
  })
  .then(() =>
    console.log(`[warmup] claude CLI ready in ${Math.round((Date.now() - started) / 1000)}s`)
  )
  .catch((err: Error) => console.log(`[warmup] claude CLI ping failed: ${err.message}`));
