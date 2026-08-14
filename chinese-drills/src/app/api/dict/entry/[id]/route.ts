import { NextRequest, NextResponse } from "next/server";
import {
  getEntry,
  cacheExamples,
  recordLookup,
  bestEntryFor,
  bestPinyin,
  type UsageExample,
} from "@/lib/dict";
import { getProvider } from "@/lib/llm/cli-provider";
import { EXAMPLES_SYSTEM, buildExamplesPrompt, parseExampleLine } from "@/lib/prompts";
import { toSimplified } from "@/lib/zh";
import { prewarmAudio } from "@/lib/tts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "Bad entry id" }, { status: 400 });
  }
  const entry = getEntry(id);
  if (!entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  recordLookup(id);
  // Opening an entry is the strongest signal that its speaker buttons are about
  // to be pressed. A revisited entry used to warm nothing at all — its examples
  // were already cached, so the generation request that carried the prewarm
  // never fired, and every click paid full synthesis.
  prewarmAudio([entry.simplified, ...(entry.examples ?? []).map((e) => e.hanzi)]);
  // Per-character sound and sense, so the stroke practice tab can show all
  // three parts for each character rather than a bare glyph.
  const seen = new Set<string>();
  const chars = [...entry.simplified]
    .filter((ch) => /[㐀-鿿]/u.test(ch) && !seen.has(ch) && (seen.add(ch), true))
    .map((ch) => {
      const own = bestEntryFor(ch);
      return {
        hanzi: ch,
        pinyin: own?.pinyin_marks ?? "",
        english: own ? own.definitions.slice(0, 2).join("; ") : "",
      };
    });
  return NextResponse.json({ entry, chars });
}

/**
 * One generation per entry, however many clients ask for it.
 *
 * React's development StrictMode mounts effects twice, which used to fire two
 * identical POSTs and spawn two `claude` processes for one entry — enough to
 * occupy every scheduler slot and stall the rest of the app. Late arrivals now
 * replay what has already been emitted and then follow along. A client going
 * away only detaches its listener: the run finishes and caches, because a
 * nearly-complete set of sentences is worth more than a cancelled one.
 */
interface Generation {
  emitted: UsageExample[];
  listeners: Set<(evt: Record<string, unknown>) => void>;
  done: boolean;
}
const globalForGen = globalThis as unknown as {
  __dictExampleGen?: Map<number, Generation>;
};
function generations(): Map<number, Generation> {
  if (!globalForGen.__dictExampleGen) globalForGen.__dictExampleGen = new Map();
  return globalForGen.__dictExampleGen;
}

function startGeneration(
  id: number,
  entry: { simplified: string; pinyin_marks: string; definitions: string[] }
): Generation {
  const gen: Generation = { emitted: [], listeners: new Set(), done: false };
  generations().set(id, gen);

  const broadcast = (evt: Record<string, unknown>) => {
    for (const listener of gen.listeners) listener(evt);
  };

  void (async () => {
    let buffer = "";
    const take = (line: string) => {
      const example = parseExampleLine(line, gen.emitted.length);
      if (!example) return;
      example.hanzi = toSimplified(example.hanzi);
      // The model's own reading is the better one when it is right — it knows
      // 都 is "dōu" here and "dū" in 首都 — but it does occasionally invent
      // one, and a learner cannot catch that. Keep it only if it checks out.
      example.pinyin = bestPinyin(example.hanzi, example.pinyin);
      gen.emitted.push(example);
      // Warm the audio the moment a sentence exists, not once all five do.
      prewarmAudio([example.hanzi]);
      broadcast({ example });
    };

    try {
      await getProvider().completeStream(
        {
          prompt: buildExamplesPrompt(entry),
          system: EXAMPLES_SYSTEM,
          tier: "fast",
          timeoutMs: 45_000,
        },
        (delta) => {
          buffer += delta;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            take(line);
          }
        }
      );
      take(buffer); // whatever the model left without a trailing newline
      if (gen.emitted.length > 0) {
        cacheExamples(id, gen.emitted);
        broadcast({ done: true, examples: gen.emitted });
      } else {
        broadcast({ error: "No example sentences came back. Try again in a moment." });
      }
    } catch (err) {
      broadcast({
        error: err instanceof Error ? err.message : "Example generation failed",
      });
    } finally {
      gen.done = true;
      gen.listeners.clear();
      generations().delete(id);
    }
  })();

  return gen;
}

/** Generate (and cache) usage examples for this entry, streamed as they land. */
export async function POST(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "Bad entry id" }, { status: 400 });
  }
  const entry = getEntry(id);
  if (!entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  if (entry.examples) {
    return NextResponse.json({ examples: entry.examples });
  }

  const existing = generations().get(id);
  const gen = existing ?? startGeneration(id, entry);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        gen.listeners.delete(listener);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const listener = (evt: Record<string, unknown>) => {
        send(evt);
        if (evt.done || evt.error) finish();
      };

      // Catch a late joiner up on everything already generated.
      for (const example of gen.emitted) send({ example });
      if (gen.done) {
        send({ done: true, examples: gen.emitted });
        finish();
        return;
      }
      gen.listeners.add(listener);
    },
    cancel() {
      // The client left; the generation carries on and caches for next time.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
