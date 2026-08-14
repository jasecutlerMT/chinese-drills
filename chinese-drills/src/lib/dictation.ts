import { getDb } from "./db";
import { getLessonRange } from "./lessons";
import { getSettings } from "./settings";
import { getProvider } from "./llm/cli-provider";
import { completeJSON } from "./llm/json";
import { DICTATION_SYSTEM, buildDictationPrompt, validateDictation } from "./prompts";
import { pickTargeting } from "./weakness";
import { toSimplified } from "./zh";
import { getAudio } from "./tts";
import { pinyinFor } from "./dict";
import { insertAttemptWithErrors } from "./attempts";
import type { GradedError, TargetedWeakness } from "./types";

export interface DictationTask {
  sentence: string;
  pinyin: string;
  english: string;
  targeted: boolean;
  targeted_weaknesses: TargetedWeakness[];
  lesson_start: number;
  lesson_end: number;
}

// One-slot prefetch, mirroring src/lib/tasks.ts.
interface Slot {
  key: string;
  promise: Promise<DictationTask>;
}
const globalForDictation = globalThis as unknown as { __dictationPrefetch?: Slot | null };

async function generate(background = false): Promise<DictationTask> {
  const settings = getSettings();
  const lessons = getLessonRange(settings.default_lesson_start, settings.default_lesson_end);
  if (lessons.length === 0) {
    throw new Error(
      `No lessons in range ${settings.default_lesson_start}-${settings.default_lesson_end}. Check Settings.`
    );
  }
  const targeted = pickTargeting();

  const db = getDb();
  const recent = db
    .prepare(
      "SELECT task_prompt FROM attempts WHERE kind = 'dictation' ORDER BY id DESC LIMIT 5"
    )
    .all() as { task_prompt: string }[];

  const result = await completeJSON(
    getProvider(),
    {
      prompt: buildDictationPrompt({
        lessons,
        difficulty: settings.difficulty,
        targeted,
        recentSentences: recent.map((r) => r.task_prompt),
      }),
      system: DICTATION_SYSTEM,
      tier: "fast",
      background,
    },
    validateDictation
  );

  const sentence = toSimplified(result.sentence);

  // The whole point is listening: the audio must exist before we serve the
  // task. (If both TTS engines are down this throws and the UI says so.)
  await getAudio(sentence);

  return {
    sentence,
    // The rule is enforced here, not hoped for: if the model skipped the
    // reading, the dictionary supplies it rather than the panel showing a
    // sentence with a blank line under it.
    pinyin: result.pinyin?.trim() || pinyinFor(sentence),
    english: result.english,
    targeted: targeted.length > 0,
    targeted_weaknesses: targeted,
    lesson_start: settings.default_lesson_start,
    lesson_end: settings.default_lesson_end,
  };
}

function settingsKey(): string {
  const s = getSettings();
  return `${s.default_lesson_start}-${s.default_lesson_end}-${s.difficulty}`;
}

export async function nextDictation(): Promise<DictationTask> {
  const key = settingsKey();
  const slot = globalForDictation.__dictationPrefetch;
  if (slot && slot.key === key) {
    globalForDictation.__dictationPrefetch = null;
    try {
      return await slot.promise;
    } catch {
      // fall through to fresh generation
    }
  }
  return generate();
}

export function refillDictationPrefetch(): void {
  const promise = generate(true);
  promise.catch(() => {
    if (globalForDictation.__dictationPrefetch?.promise === promise) {
      globalForDictation.__dictationPrefetch = null;
    }
  });
  globalForDictation.__dictationPrefetch = { key: settingsKey(), promise };
}

// ---------- local, instant grading ----------

export interface DiffSegment {
  type: "match" | "wrong" | "missing" | "extra";
  expected: string; // characters the audio actually said ("" for extra)
  got: string; // characters the learner typed ("" for missing)
}

/** Strip whitespace and punctuation — dictation grades characters, not commas. */
function normalize(text: string): string {
  return text.replace(/[\s，。？！、；：""''…—,.?!;:'"()（）]/gu, "");
}

/** Character-level LCS alignment between what was said and what was typed. */
export function diffDictation(expectedRaw: string, typedRaw: string): DiffSegment[] {
  const a = [...normalize(expectedRaw)];
  const b = [...normalize(typedRaw)];
  // LCS table (sentences are short; O(n*m) is nothing).
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the table, merging runs into segments.
  const segments: DiffSegment[] = [];
  const push = (type: DiffSegment["type"], expected: string, got: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) {
      last.expected += expected;
      last.got += got;
    } else {
      segments.push({ type, expected, got });
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("match", a[i], b[j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("missing", a[i], "");
      i++;
    } else {
      push("extra", "", b[j]);
      j++;
    }
  }
  while (i < a.length) push("missing", a[i++], "");
  while (j < b.length) push("extra", "", b[j++]);

  // A missing run adjacent to an extra run is really a substitution.
  const merged: DiffSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (
      last &&
      ((last.type === "missing" && seg.type === "extra") ||
        (last.type === "extra" && seg.type === "missing"))
    ) {
      merged[merged.length - 1] = {
        type: "wrong",
        expected: last.expected + seg.expected,
        got: last.got + seg.got,
      };
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

export interface DictationGrade {
  score: number;
  segments: DiffSegment[];
  perfect: boolean;
}

export function gradeDictation(expected: string, typed: string): DictationGrade {
  const segments = diffDictation(expected, typed);
  const total = [...normalize(expected)].length;
  const matched = segments
    .filter((s) => s.type === "match")
    .reduce((n, s) => n + [...s.expected].length, 0);
  const extras = segments
    .filter((s) => s.type === "extra")
    .reduce((n, s) => n + [...s.got].length, 0);
  const score = Math.max(
    0,
    Math.min(100, Math.round(((matched - extras * 0.5) / Math.max(1, total)) * 100))
  );
  return { score, segments, perfect: segments.every((s) => s.type === "match") };
}

/** Store the attempt and log each mistake to the shared error log. */
export function recordDictation(
  task: DictationTask,
  typed: string,
  grade: DictationGrade
): { attemptId: number; errors: GradedError[] } {
  const errors: GradedError[] = grade.segments
    .filter((s) => s.type !== "match")
    .map((s) => ({
      error_category: "other" as const,
      target_item: s.expected || null,
      my_fragment: s.got || "(missing)",
      corrected_fragment: s.expected || "(extra)",
      explanation_short:
        s.type === "wrong"
          ? `The audio said ${s.expected} (${pinyinFor(s.expected)}) but you typed ${s.got}.`
          : s.type === "missing"
            ? `You missed ${s.expected} (${pinyinFor(s.expected)}).`
            : `You added ${s.got} (${pinyinFor(s.got)}), which wasn't in the audio.`,
      // Mishearings are logged softly so they inform targeting via their
      // specific target_item without drowning out grammar weaknesses.
      severity: "minor" as const,
    }));

  const attemptId = insertAttemptWithErrors(
    {
      kind: "dictation",
      parentAttemptId: null,
      lessonStart: task.lesson_start,
      lessonEnd: task.lesson_end,
      taskSize: "sentence",
      taskPrompt: task.sentence,
      targetVocab: "[]",
      targetGrammar: "[]",
      targeted: task.targeted,
      targetedWeaknesses: task.targeted_weaknesses.length
        ? JSON.stringify(task.targeted_weaknesses)
        : null,
      myText: typed,
      correctedText: task.sentence,
      whatWorked: grade.perfect
        ? "Perfect dictation — every character right."
        : `You caught ${grade.score}% of the sentence by ear.`,
      overallScore: grade.score,
    },
    errors,
    "dictation"
  );
  return { attemptId, errors };
}
