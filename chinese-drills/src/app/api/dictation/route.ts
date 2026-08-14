import { NextRequest, NextResponse } from "next/server";
import { readJson, badRequest } from "@/lib/http";
import {
  nextDictation,
  gradeDictation,
  recordDictation,
  refillDictationPrefetch,
  type DictationTask,
} from "@/lib/dictation";
import { creditResolvedWeaknesses } from "@/lib/weakness";
import type { TargetedWeakness } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Serve the next dictation task (audio already synthesized). */
export async function GET() {
  try {
    const task = await nextDictation();
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not create a dictation" },
      { status: 500 }
    );
  }
}

function validateTask(x: unknown): DictationTask | null {
  const t = x as DictationTask;
  if (!t || typeof t.sentence !== "string" || t.sentence.length < 2) return null;
  if (!Number.isInteger(t.lesson_start) || !Number.isInteger(t.lesson_end)) return null;
  const weaknesses: TargetedWeakness[] = Array.isArray(t.targeted_weaknesses)
    ? t.targeted_weaknesses.filter(
        (w) =>
          w &&
          (w.kind === "category" || w.kind === "item") &&
          typeof w.value === "string" &&
          Array.isArray(w.error_ids)
      )
    : [];
  return {
    sentence: t.sentence,
    pinyin: typeof t.pinyin === "string" ? t.pinyin : "",
    english: typeof t.english === "string" ? t.english : "",
    targeted: !!t.targeted,
    targeted_weaknesses: weaknesses,
    lesson_start: t.lesson_start,
    lesson_end: t.lesson_end,
  };
}

/** Grade a transcript (local, instant) and store the attempt. */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    if (!body) return badRequest();
    const task = validateTask(body.task);
    const myText = String(body.myText ?? "").trim();
    if (!task) {
      return NextResponse.json({ error: "Missing or invalid dictation task" }, { status: 400 });
    }
    if (!myText) {
      return NextResponse.json({ error: "Type what you heard first" }, { status: 400 });
    }
    const grade = gradeDictation(task.sentence, myText);
    const { attemptId, errors } = recordDictation(task, myText, grade);

    // Close the loop: a targeted dictation with no reoccurrence of the
    // weakness credits the motivating log entries, same as composition.
    if (task.targeted && task.targeted_weaknesses.length) {
      creditResolvedWeaknesses(task.targeted_weaknesses, errors);
    }

    // Grading is instant, so kick off the next sentence + audio now.
    refillDictationPrefetch();
    return NextResponse.json({ attemptId, grade });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Dictation grading failed" },
      { status: 500 }
    );
  }
}
