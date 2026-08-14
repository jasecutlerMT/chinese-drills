import { execFile, spawn } from "child_process";
import type { CompletionRequest, LLMProvider } from "./provider";

const MODEL_FOR_TIER = { fast: "haiku", smart: "sonnet" } as const;

interface CliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

// ---------- scheduler ----------
// At most MAX_CONCURRENT claude processes at once, and interactive requests
// always jump the queue ahead of background ones (prefetch/warmup/audio prep).
// This is what keeps translation/grading snappy on modest machines: without
// it, a pile of background prefetches can starve the call the user is
// actually waiting on.
const MAX_CONCURRENT = 2;

interface QueueEntry {
  background: boolean;
  enqueuedAt: number;
  run: () => void;
}

const globalForSched = globalThis as unknown as {
  __llmQueue?: QueueEntry[];
  __llmRunning?: { n: number };
};
function queue(): QueueEntry[] {
  if (!globalForSched.__llmQueue) globalForSched.__llmQueue = [];
  return globalForSched.__llmQueue;
}
function running(): { n: number } {
  if (!globalForSched.__llmRunning) globalForSched.__llmRunning = { n: 0 };
  return globalForSched.__llmRunning;
}

function pump(): void {
  const q = queue();
  const r = running();
  while (q.length > 0) {
    const idx = q.findIndex((e) => !e.background);
    let entry: QueueEntry;
    if (idx >= 0) {
      // Jumping the queue is not enough when both slots are held by long
      // background jobs that will not yield — the thing the user is actually
      // waiting on gets one extra slot of its own.
      if (r.n >= MAX_CONCURRENT + 1) break;
      entry = q.splice(idx, 1)[0];
    } else {
      if (r.n >= MAX_CONCURRENT) break;
      entry = q.shift()!;
    }
    r.n++;
    entry.run();
  }
}

function schedule<T>(
  background: boolean,
  job: () => Promise<T>,
  onQueued?: (ms: number) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry = {
      background,
      enqueuedAt: Date.now(),
      run: () => {
        const queuedMs = Date.now() - entry.enqueuedAt;
        onQueued?.(queuedMs);
        job()
          .then(resolve, reject)
          .finally(() => {
            running().n--;
            pump();
          });
        if (queuedMs > 500) {
          console.log(`[llm] request waited ${Math.round(queuedMs / 100) / 10}s in queue`);
        }
      },
    };
    queue().push(entry);
    pump();
  });
}

// ---------- provider ----------

function baseArgs(tier: "fast" | "smart", system?: string): string[] {
  // The lean flags matter: without them the CLI loads the user's entire
  // personal Claude config (MCP servers, plugins, skills) for every
  // one-shot call. OAuth subscription auth still works with all of these.
  const args = [
    "-p",
    "--model",
    MODEL_FOR_TIER[tier],
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
  ];
  // Quick tasks skip extended thinking: answers start streaming sooner.
  if (tier === "fast") args.push("--effort", "low");
  if (system) args.push("--system-prompt", system);
  return args;
}

/**
 * Everything that could route this call somewhere that bills per token. The
 * hard requirement is that drills run on the Claude subscription, so the child
 * process is handed an environment with no way to reach a paid endpoint —
 * not just no API key, but no alternate base URL, gateway or cloud provider
 * either. One of these left over in a shell profile from unrelated work would
 * otherwise silently redirect every grading call.
 */
const BILLING_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_BEARER_TOKEN_BEDROCK",
];

function cleanEnv(tier: "fast" | "smart"): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of BILLING_ENV_VARS) delete env[name];
  // The fast tier does mechanical work — translate this sentence, write five
  // examples — where extended thinking buys nothing and costs the user real
  // waiting: measured here, the model spent 11-16s thinking before writing a
  // single character, against ~2s with the budget zeroed. `--effort low` does
  // not go far enough; it still leaves a thinking phase. Grading keeps its
  // reasoning (smart tier), because there the quality is the point.
  if (tier === "fast") env.MAX_THINKING_TOKENS = "0";
  return env;
}

function friendlyError(detail: string): Error {
  if (/log\s*in|login|api key|authentication|unauthorized/i.test(detail)) {
    return new Error(
      "Claude isn't logged in. In Terminal, run: claude — then log in with your Claude account and type /exit."
    );
  }
  return new Error(`claude CLI failed: ${detail}`);
}

/**
 * Runs the locally installed, subscription-authenticated `claude` CLI in
 * non-interactive print mode. No API key is ever used. `--tools ""` disables
 * all tools, making calls inherently single-shot.
 */
export class CliProvider implements LLMProvider {
  complete(req: CompletionRequest): Promise<string> {
    return schedule(!!req.background, () => this.runOnce(req), req.onQueued);
  }

  private runOnce(req: CompletionRequest): Promise<string> {
    const args = [...baseArgs(req.tier, req.system), "--output-format", "json"];
    const timeoutMs = req.timeoutMs ?? 180_000;
    const started = Date.now();

    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        "claude",
        args,
        { env: cleanEnv(req.tier), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          const secs = Math.round((Date.now() - started) / 100) / 10;
          if (err) {
            const detail = (stderr || stdout || err.message).slice(0, 2000);
            console.log(`[llm] ${req.tier} FAILED after ${secs}s`);
            if (err.killed) {
              reject(
                new Error(
                  `Claude took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. This is usually temporary — try again.`
                )
              );
            } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              reject(
                new Error(
                  "The claude program isn't installed or can't be found. In Terminal, run: npm install -g @anthropic-ai/claude-code"
                )
              );
            } else {
              reject(friendlyError(detail));
            }
            return;
          }
          console.log(`[llm] ${req.tier} ${secs}s${req.background ? " (background)" : ""}`);
          let envelope: CliEnvelope;
          try {
            envelope = JSON.parse(stdout) as CliEnvelope;
          } catch {
            reject(new Error(`claude CLI returned unparseable output: ${stdout.slice(0, 500)}`));
            return;
          }
          if (envelope.is_error || envelope.subtype !== "success") {
            reject(
              new Error(
                `claude CLI reported an error (subtype=${envelope.subtype}): ${String(envelope.result).slice(0, 1000)}`
              )
            );
            return;
          }
          if (typeof envelope.result !== "string") {
            reject(new Error("claude CLI envelope had no result field"));
            return;
          }
          resolve(envelope.result);
        }
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(req.prompt);
    });
  }

  completeStream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string> {
    return schedule(!!req.background, () => this.runStream(req, onDelta), req.onQueued);
  }

  private runStream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string> {
    const args = [
      ...baseArgs(req.tier, req.system),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    // Idle timeout: kill only if NO output arrives for this long.
    const idleMs = req.timeoutMs ?? 45_000;
    const started = Date.now();

    return new Promise<string>((resolve, reject) => {
      const child = spawn("claude", args, { env: cleanEnv(req.tier) });
      let full = "";
      let buffer = "";
      let settled = false;
      let stderrTail = "";
      let envelopeError: string | null = null;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("cancelled"));
      };
      if (req.signal) {
        if (req.signal.aborted) {
          onAbort();
          return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });
      }

      let idleTimer: ReturnType<typeof setTimeout>;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill("SIGKILL");
            reject(
              new Error(
                `Claude stopped responding (no output for ${Math.round(idleMs / 1000)}s). Try again.`
              )
            );
          }
        }, idleMs);
      };
      resetIdle();

      child.stdout.on("data", (chunk: Buffer) => {
        resetIdle();
        buffer += chunk.toString("utf-8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const evt = JSON.parse(line) as {
              type?: string;
              event?: { type?: string; delta?: { type?: string; text?: string } };
              subtype?: string;
              is_error?: boolean;
              result?: string;
            };
            if (
              evt.type === "stream_event" &&
              evt.event?.type === "content_block_delta" &&
              evt.event.delta?.type === "text_delta" &&
              typeof evt.event.delta.text === "string"
            ) {
              full += evt.event.delta.text;
              onDelta(evt.event.delta.text);
            } else if (evt.type === "result") {
              if (evt.is_error || (evt.subtype && evt.subtype !== "success")) {
                // Mid-stream API failure: partial deltas must not pass as success.
                envelopeError = String(evt.result ?? evt.subtype ?? "unknown error").slice(0, 500);
              } else if (typeof evt.result === "string" && evt.result.length > 0) {
                // Authoritative final text (also covers models that skipped deltas).
                full = evt.result;
              }
            }
          } catch {
            // Non-JSON line — ignore.
          }
        }
      });
      child.stderr.on("data", (c: Buffer) => {
        stderrTail = (stderrTail + c.toString("utf-8")).slice(-2000);
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        reject(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error(
                "The claude program isn't installed or can't be found. In Terminal, run: npm install -g @anthropic-ai/claude-code"
              )
            : err
        );
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        req.signal?.removeEventListener("abort", onAbort);
        const secs = Math.round((Date.now() - started) / 100) / 10;
        if (code === 0 && !envelopeError && full.trim().length > 0) {
          console.log(`[llm] ${req.tier} stream ${secs}s`);
          resolve(full);
        } else {
          console.log(`[llm] ${req.tier} stream FAILED after ${secs}s (exit ${code})`);
          reject(friendlyError(envelopeError || stderrTail || `stream ended with exit code ${code}`));
        }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(req.prompt);
    });
  }
}

// Singleton accessor so app code never constructs providers directly.
const globalForLlm = globalThis as unknown as { __llmProvider?: LLMProvider };

export function getProvider(): LLMProvider {
  if (!globalForLlm.__llmProvider) {
    globalForLlm.__llmProvider = new CliProvider();
  }
  return globalForLlm.__llmProvider;
}
