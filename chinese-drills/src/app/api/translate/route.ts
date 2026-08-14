import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/llm/cli-provider";
import {
  TRANSLATE_SYSTEM,
  buildTranslatePrompt,
  parseTranslationText,
  type TranslateDirection,
} from "@/lib/prompts";
import { readJson, badRequest } from "@/lib/http";
import { toSimplified } from "@/lib/zh";
import { isMostlyChinese } from "@/lib/cjk";
import { prewarmAudio } from "@/lib/tts";
import { searchDict, pinyinFor, bestPinyin } from "@/lib/dict";
import { recordTranslation, recentTranslations } from "@/lib/translations";

export const dynamic = "force-dynamic";

const MAX_INPUT = 1500;

/** Recent translation history for the page. */
export async function GET() {
  return NextResponse.json({ recent: recentTranslations() });
}

/**
 * Translation. Single words / short phrases with an exact dictionary match
 * answer instantly from CC-CEDICT; everything else streams from Claude as
 * server-sent events so text appears while it's being written.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    if (!body) return badRequest();
    const text = String(body.text ?? "").trim();
    if (!text) return NextResponse.json({ error: "Nothing to translate" }, { status: 400 });
    if (text.length > MAX_INPUT) {
      return NextResponse.json(
        { error: `Text too long (max ${MAX_INPUT} characters)` },
        { status: 400 }
      );
    }

    const target = body.target === undefined ? "zh" : body.target;
    if (target !== "zh" && target !== "yue") {
      return NextResponse.json({ error: "Unknown target language" }, { status: 400 });
    }
    const cantonese = target === "yue";
    const chineseIn = isMostlyChinese(text);
    const direction: TranslateDirection = chineseIn
      ? cantonese
        ? "zh2yue"
        : "zh2en"
      : cantonese
        ? "en2yue"
        : "en2zh";
    const speakVoice = cantonese ? ("cantonese" as const) : undefined;

    // The Chinese side always has a speaker button; warm it now rather than
    // when it is clicked.
    if (chineseIn) prewarmAudio([text]);

    // Instant dictionary path for words and very short phrases. Skipped for
    // Cantonese: CC-CEDICT's readings and wording are Mandarin.
    const instant = cantonese ? null : tryDictionary(text, direction);
    if (instant) {
      recordTranslation({ input: text, ...instant, direction, source: "dictionary" });
      if (direction === "en2zh") prewarmAudio([instant.translation]);
      return NextResponse.json({ ...instant, direction, source: "dictionary" });
    }

    // Streamed LLM path. Cancelling the response (user typed something new)
    // kills the CLI process so it doesn't hold a scheduler slot, and the
    // half-done result never reaches the history. Client disconnects arrive
    // via req.signal; explicit stream cancellation via cancel() below.
    const abort = new AbortController();
    req.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            // Controller already closed (client went away).
          }
        };
        try {
          const raw = await getProvider().completeStream(
            {
              prompt: buildTranslatePrompt(text, direction),
              system: TRANSLATE_SYSTEM,
              tier: "fast",
              timeoutMs: 45_000,
              signal: abort.signal,
            },
            (delta) => send({ delta })
          );
          const parsed = parseTranslationText(raw);
          const outputIsChinese = direction !== "zh2en";
          const translation = outputIsChinese
            ? toSimplified(parsed.translation)
            : parsed.translation;

          // The romanization comes from a plain-text protocol with no schema,
          // so a dropped separator would otherwise ship bare characters.
          let pinyin = parsed.pinyin?.trim() || null;
          let romanizationMissing = false;
          if (!pinyin) {
            if (cantonese) {
              // Never fall back to the dictionary here: it would answer with
              // Mandarin pinyin for Cantonese words, which is worse than
              // nothing. Ask once for the Jyutping alone instead.
              pinyin = await getProvider()
                .complete({
                  prompt:
                    "Output ONLY the Jyutping romanization with tone numbers for this " +
                    `Cantonese text, nothing else:\n\n${translation}`,
                  system: TRANSLATE_SYSTEM,
                  tier: "fast",
                  timeoutMs: 20_000,
                })
                .then((r) => r.trim() || null)
                .catch(() => null);
              romanizationMissing = !pinyin;
            } else {
              pinyin = pinyinFor(direction === "en2zh" ? translation : text);
            }
          } else if (!cantonese) {
            // Mandarin pinyin the model wrote: keep it when it genuinely reads
            // the characters, fall back to the dictionary when it does not.
            // Jyutping is never checked this way — CC-CEDICT's readings are
            // Mandarin, so it would reject every correct Cantonese line.
            pinyin = bestPinyin(direction === "en2zh" ? translation : text, pinyin);
          }

          recordTranslation({
            input: text,
            translation,
            pinyin,
            direction,
            source: "claude",
          });
          if (outputIsChinese) prewarmAudio([translation], speakVoice);
          send({
            done: true,
            translation,
            pinyin,
            gloss: parsed.gloss,
            romanizationMissing,
            direction,
            source: "claude",
          });
        } catch (err) {
          if (!abort.signal.aborted) {
            send({ error: err instanceof Error ? err.message : "Translation failed" });
          }
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Translation failed" },
      { status: 500 }
    );
  }
}

function tryDictionary(
  text: string,
  direction: TranslateDirection
): { translation: string; pinyin: string | null } | null {
  // Instant answers only for short hanzi with an exact dictionary entry —
  // English-word glosses are too ambiguous for a reliable shortcut ("phone"
  // could be 电话/手机/致电), so English always goes to the model.
  if (direction !== "zh2en") return null;
  if ([...text].length > 4 || /[\s，。？！,.?!]/.test(text)) return null;

  // Rank over a real candidate set so a "variant of" entry can't win by
  // being the only row the SQL returned.
  const top = searchDict(text, 10)[0];
  if (!top || (top.simplified !== text && top.traditional !== text)) return null;
  return { translation: top.definitions.join("; "), pinyin: top.pinyin_marks };
}
