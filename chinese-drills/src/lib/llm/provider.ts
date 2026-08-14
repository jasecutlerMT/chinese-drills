export type ModelTier = "fast" | "smart";

export interface CompletionRequest {
  prompt: string;
  system?: string;
  tier: ModelTier;
  timeoutMs?: number;
  /**
   * Background requests (prefetch, warmup, audio prep) queue behind
   * interactive ones so they never make the user wait.
   */
  background?: boolean;
  /** Abort the request (streaming: kills the CLI process immediately). */
  signal?: AbortSignal;
  /** Reports time spent waiting in the scheduler queue, for honest timing. */
  onQueued?: (ms: number) => void;
}

/**
 * Single-shot text completion. Implementations must not use tools,
 * file access, or multi-turn behavior. CliProvider is the only
 * implementation for now; an ApiProvider can be added later without
 * touching app code if billing rules change.
 */
export interface LLMProvider {
  complete(req: CompletionRequest): Promise<string>;
  /** Stream the answer's text chunks as they arrive. Resolves to the full text. */
  completeStream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string>;
}
