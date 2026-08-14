import { NextRequest, NextResponse } from "next/server";
import { readJson, badRequest } from "@/lib/http";
import { getProvider } from "@/lib/llm/cli-provider";
import { completeJSON } from "@/lib/llm/json";
import { GRADING_SYSTEM, buildGradingPrompt, validateGrading } from "@/lib/prompts";
import { creditResolvedWeaknesses } from "@/lib/weakness";
import { getSettings, setSetting } from "@/lib/settings";
import { insertAttemptWithErrors } from "@/lib/attempts";
import { refillPrefetch } from "@/lib/tasks";
import { maxLesson } from "@/lib/lessons";
import { toSimplified } from "@/lib/zh";
import { pinyinFor } from "@/lib/dict";
import { prewarmAudio } from "@/lib/tts";
import type { GeneratedTask, TaskSize, TargetedWeakness } from "@/lib/types";

export const dynamic = "force-dynamic";

const SIZES: TaskSize[] = ["sentence", "three_sentences", "paragraph"];

/** Validate the round-tripped task object before paying for a grading call. */
function validateTask(x: unknown): GeneratedTask | null {
  const t = x as GeneratedTask;
  if (!t || typeof t.prompt_en !== "string" || t.prompt_en.length < 10) return null;
  if (!Array.isArray(t.target_vocab) || !Array.isArray(t.target_grammar)) return null;
  if (!SIZES.includes(t.task_size)) return null;
  if (
    !Number.isInteger(t.lesson_start) ||
    !Number.isInteger(t.lesson_end) ||
    t.lesson_start < 1 ||
    t.lesson_end > maxLesson() ||
    t.lesson_start > t.lesson_end
  )
    return null;
  const weaknesses: TargetedWeakness[] = Array.isArray(t.targeted_weaknesses)
    ? t.targeted_weaknesses.filter(
        (w) =>
          w &&
          (w.kind === "category" || w.kind === "item") &&
          typeof w.value === "string" &&
          Array.isArray(w.error_ids) &&
          w.error_ids.every((id) => Number.isInteger(id))
      )
    : [];
  return { ...t, targeted: !!t.targeted, targeted_weaknesses: weaknesses };
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    if (!body) return badRequest();
    const task = validateTask(body.task);
    const myText = String(body.myText ?? "").trim();

    if (!task) {
      return NextResponse.json({ error: "Missing or invalid task" }, { status: 400 });
    }
    if (myText.length < 2) {
      return NextResponse.json({ error: "Write your answer first" }, { status: 400 });
    }

    const grading = await completeJSON(
      getProvider(),
      {
        prompt: buildGradingPrompt({
          taskPrompt: task.prompt_en,
          targetVocab: task.target_vocab,
          targetGrammar: task.target_grammar,
          taskSize: task.task_size,
          myText,
        }),
        system: GRADING_SYSTEM,
        tier: "smart",
      },
      validateGrading
    );

    // Guarantee simplified characters even if the model slips, and guarantee
    // the three-part rule: every Chinese string leaves here with pinyin.
    grading.corrected_text = toSimplified(grading.corrected_text);
    grading.corrected_pinyin = grading.corrected_pinyin ?? pinyinFor(grading.corrected_text);
    grading.my_text_pinyin = grading.my_text_pinyin ?? pinyinFor(myText);
    for (const e of grading.errors) {
      e.corrected_fragment = toSimplified(e.corrected_fragment);
      e.explanation_short = toSimplified(e.explanation_short);
      e.corrected_fragment_pinyin =
        e.corrected_fragment_pinyin ?? pinyinFor(e.corrected_fragment);
      e.my_fragment_pinyin = e.my_fragment_pinyin ?? pinyinFor(e.my_fragment);
    }
    if (grading.micro_task) {
      grading.micro_task.source_sentence = toSimplified(grading.micro_task.source_sentence);
      grading.micro_task.source_sentence_pinyin =
        grading.micro_task.source_sentence_pinyin ??
        pinyinFor(grading.micro_task.source_sentence);
    }

    // Pre-generate pronunciation audio so the speaker buttons play instantly.
    prewarmAudio([
      grading.corrected_text,
      grading.micro_task?.source_sentence,
      ...grading.errors.map((e) => e.corrected_fragment),
    ]);

    const attemptId = insertAttemptWithErrors(
      {
        kind: "task",
        parentAttemptId: null,
        lessonStart: task.lesson_start,
        lessonEnd: task.lesson_end,
        taskSize: task.task_size,
        taskPrompt: task.prompt_en,
        targetVocab: JSON.stringify(task.target_vocab),
        targetGrammar: JSON.stringify(task.target_grammar),
        targeted: task.targeted,
        targetedWeaknesses: task.targeted_weaknesses.length
          ? JSON.stringify(task.targeted_weaknesses)
          : null,
        myText,
        correctedText: grading.corrected_text,
        whatWorked: grading.what_worked,
        overallScore: grading.overall_score,
      },
      grading.errors
    );

    // Close the loop on targeted weaknesses that did not reoccur.
    if (task.targeted && task.targeted_weaknesses.length) {
      creditResolvedWeaknesses(task.targeted_weaknesses, grading.errors);
    }

    // Adapt difficulty: clean rep bumps it up, a rough one brings it down.
    const settings = getSettings();
    if (grading.errors.length === 0 && grading.overall_score >= 90) {
      setSetting("difficulty", Math.min(5, settings.difficulty + 1));
    } else if (grading.overall_score < 70) {
      setSetting("difficulty", Math.max(1, settings.difficulty - 1));
    }

    // Pre-generate the next task now that difficulty and the error log are
    // current; the user's feedback-reading time covers the latency.
    refillPrefetch({
      lessonStart: task.lesson_start,
      lessonEnd: task.lesson_end,
      taskSize: task.task_size,
    });

    return NextResponse.json({ attemptId, grading });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Grading failed" },
      { status: 500 }
    );
  }
}
