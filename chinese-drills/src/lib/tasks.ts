import { getDb } from "./db";
import { getLessonRange } from "./lessons";
import { getSettings } from "./settings";
import { getProvider } from "./llm/cli-provider";
import { completeJSON } from "./llm/json";
import {
  GENERATION_SYSTEM,
  buildGenerationPrompt,
  validateGeneratedTask,
} from "./prompts";
import { pickTargeting } from "./weakness";
import { strugglingWords } from "./srs";
import type { GeneratedTask, TaskSize } from "./types";

export interface TaskKeyParts {
  lessonStart: number;
  lessonEnd: number;
  taskSize: TaskSize;
}

function cacheKey(k: TaskKeyParts): string {
  return `${k.lessonStart}-${k.lessonEnd}-${k.taskSize}`;
}

// One-slot prefetch cache. Refilled from /api/grade AFTER an attempt is
// stored — not at serve time — so the pre-generated task sees the updated
// difficulty and the just-logged errors. The user's feedback-reading time
// covers the generation latency. Held on globalThis to survive dev reloads.
interface PrefetchSlot {
  key: string;
  promise: Promise<GeneratedTask>;
}
const globalForTasks = globalThis as unknown as { __taskPrefetch?: PrefetchSlot | null };

async function generateTask(parts: TaskKeyParts, background = false): Promise<GeneratedTask> {
  const lessons = getLessonRange(parts.lessonStart, parts.lessonEnd);
  if (lessons.length === 0) {
    throw new Error(
      `No lessons found in range ${parts.lessonStart}-${parts.lessonEnd}. Check data/lessons.json.`
    );
  }
  const settings = getSettings();
  const targeted = pickTargeting();

  const db = getDb();
  const recent = db
    .prepare("SELECT task_prompt FROM attempts WHERE kind = 'task' ORDER BY id DESC LIMIT 5")
    .all() as { task_prompt: string }[];

  const prompt = buildGenerationPrompt({
    lessons,
    taskSize: parts.taskSize,
    difficulty: settings.difficulty,
    targeted,
    recentPrompts: recent.map((r) => r.task_prompt),
    // Words the flashcard deck says are shaky get written practice too.
    srsFocus: strugglingWords(parts.lessonStart, parts.lessonEnd),
  });

  const generated = await completeJSON(
    getProvider(),
    { prompt, system: GENERATION_SYSTEM, tier: "fast", background },
    validateGeneratedTask
  );

  return {
    ...generated,
    lesson_start: parts.lessonStart,
    lesson_end: parts.lessonEnd,
    task_size: parts.taskSize,
    targeted: targeted.length > 0,
    targeted_weaknesses: targeted,
  };
}

/** Serve the next task, from the prefetch slot when it matches. */
export async function nextTask(parts: TaskKeyParts): Promise<GeneratedTask> {
  const key = cacheKey(parts);
  const slot = globalForTasks.__taskPrefetch;
  if (slot && slot.key === key) {
    globalForTasks.__taskPrefetch = null;
    try {
      const task = await slot.promise;
      console.log(`[tasks] served from prefetch (${key})`);
      return task;
    } catch {
      console.log(`[tasks] prefetch failed, generating fresh (${key})`);
    }
  }
  return generateTask(parts);
}

/**
 * Start generating the next task in the background. Called after grading
 * stores the attempt, so the generated task reflects the new difficulty and
 * error log. Errors are swallowed; nextTask() falls back to live generation.
 */
export function refillPrefetch(parts: TaskKeyParts): void {
  const promise = generateTask(parts, true);
  promise.catch(() => {
    if (globalForTasks.__taskPrefetch?.promise === promise) {
      globalForTasks.__taskPrefetch = null;
    }
  });
  globalForTasks.__taskPrefetch = { key: cacheKey(parts), promise };
}
