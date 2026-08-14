import { NextRequest, NextResponse } from "next/server";
import { readJson, badRequest } from "@/lib/http";
import { getDb } from "@/lib/db";
import { getProvider } from "@/lib/llm/cli-provider";
import { completeJSON } from "@/lib/llm/json";
import { MICRO_SYSTEM, buildMicroPrompt, validateGrading } from "@/lib/prompts";
import { insertAttemptWithErrors } from "@/lib/attempts";
import { pinyinFor } from "@/lib/dict";
import { prewarmAudio } from "@/lib/tts";
import type { AttemptRow, ErrorRow, TaskSize } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Pick the error the micro-task is about: the worst-severity error from the
 * parent attempt whose flawed fragment appears in the micro-task's source
 * sentence, falling back to the worst overall.
 */
function findTargetError(errors: ErrorRow[], sourceSentence: string): ErrorRow | undefined {
  const rank = { critical: 0, major: 1, minor: 2 } as const;
  const sorted = [...errors].sort((a, b) => rank[a.severity] - rank[b.severity]);
  return (
    sorted.find((e) => e.my_fragment && sourceSentence.includes(e.my_fragment)) ?? sorted[0]
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    if (!body) return badRequest();
    const parentAttemptId = Number(body.parentAttemptId);
    const instruction = String(body.instruction ?? "");
    const sourceSentence = String(body.sourceSentence ?? "");
    const myText = String(body.myText ?? "").trim();

    if (!Number.isInteger(parentAttemptId) || myText.length < 2 || !sourceSentence) {
      return NextResponse.json({ error: "Missing micro-task data" }, { status: 400 });
    }

    const db = getDb();
    const parent = db
      .prepare("SELECT * FROM attempts WHERE id = ?")
      .get(parentAttemptId) as AttemptRow | undefined;
    if (!parent) {
      return NextResponse.json({ error: "Parent attempt not found" }, { status: 404 });
    }

    const parentErrors = db
      .prepare("SELECT * FROM errors WHERE attempt_id = ?")
      .all(parentAttemptId) as ErrorRow[];
    const targetError = findTargetError(parentErrors, sourceSentence);

    const grading = await completeJSON(
      getProvider(),
      {
        prompt: buildMicroPrompt({
          instruction,
          sourceSentence,
          fixExplanation: targetError?.explanation_short ?? "",
          myText,
        }),
        system: MICRO_SYSTEM,
        tier: "fast",
      },
      validateGrading
    );

    // Three-part rule: pinyin for every Chinese string this returns.
    grading.corrected_pinyin = grading.corrected_pinyin ?? pinyinFor(grading.corrected_text);
    grading.my_text_pinyin = grading.my_text_pinyin ?? pinyinFor(myText);
    for (const e of grading.errors) {
      e.corrected_fragment_pinyin =
        e.corrected_fragment_pinyin ?? pinyinFor(e.corrected_fragment);
      e.my_fragment_pinyin = e.my_fragment_pinyin ?? pinyinFor(e.my_fragment);
    }

    const attemptId = insertAttemptWithErrors(
      {
        kind: "micro",
        parentAttemptId,
        lessonStart: parent.lesson_start,
        lessonEnd: parent.lesson_end,
        taskSize: "sentence" as TaskSize,
        taskPrompt: `Micro-task: ${instruction}`,
        targetVocab: parent.target_vocab,
        targetGrammar: parent.target_grammar,
        targeted: false,
        targetedWeaknesses: null,
        myText,
        correctedText: grading.corrected_text,
        whatWorked: grading.what_worked,
        overallScore: grading.overall_score,
      },
      grading.errors
    );

    // The corrected sentence gets a speaker button the moment this renders.
    prewarmAudio([grading.corrected_text, ...grading.errors.map((e) => e.corrected_fragment)]);

    return NextResponse.json({ attemptId, grading });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Micro-task grading failed" },
      { status: 500 }
    );
  }
}
