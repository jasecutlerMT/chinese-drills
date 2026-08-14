import type { CompletionRequest, LLMProvider } from "./provider";

/**
 * Runs a completion whose answer must be strict JSON. Strips code fences and
 * surrounding prose defensively, validates with the caller's validator, and
 * retries exactly once with a corrective nudge on parse/validation failure.
 */
export async function completeJSON<T>(
  provider: LLMProvider,
  req: CompletionRequest,
  validate: (x: unknown) => T
): Promise<T> {
  const first = await provider.complete(req);
  try {
    return validate(extractJson(first));
  } catch (firstError) {
    const retry = await provider.complete({
      ...req,
      prompt:
        req.prompt +
        "\n\nYour previous reply could not be parsed as the required JSON" +
        ` (${(firstError as Error).message.slice(0, 200)}).` +
        " Reply again with ONLY the JSON object. No code fences, no commentary.",
    });
    return validate(extractJson(retry));
  }
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  // Strip markdown code fences if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  // Fall back to the outermost {...} block if there's surrounding prose.
  if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("no JSON object found in model output");
    }
    t = t.slice(start, end + 1);
  }
  return JSON.parse(t);
}
