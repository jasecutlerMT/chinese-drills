import { getDb, nowIso, localDate } from "./db";
import type { GradedError, TaskSize } from "./types";

export interface AttemptInsert {
  kind: "task" | "micro" | "dictation";
  parentAttemptId: number | null;
  lessonStart: number;
  lessonEnd: number;
  taskSize: TaskSize;
  taskPrompt: string;
  targetVocab: string; // JSON
  targetGrammar: string; // JSON
  targeted: boolean;
  targetedWeaknesses: string | null; // JSON
  myText: string;
  correctedText: string;
  whatWorked: string;
  overallScore: number;
}

/** Insert one attempt plus its errors atomically. Returns the attempt id. */
export function insertAttemptWithErrors(
  attempt: AttemptInsert,
  errors: GradedError[],
  errorModule: string = "composition"
): number {
  const db = getDb();
  const now = nowIso();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO attempts
           (created_at, local_date, kind, parent_attempt_id, lesson_start, lesson_end,
            task_size, task_prompt, target_vocab, target_grammar, targeted,
            targeted_weaknesses, my_text, corrected_text, what_worked, overall_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        now,
        localDate(),
        attempt.kind,
        attempt.parentAttemptId,
        attempt.lessonStart,
        attempt.lessonEnd,
        attempt.taskSize,
        attempt.taskPrompt,
        attempt.targetVocab,
        attempt.targetGrammar,
        attempt.targeted ? 1 : 0,
        attempt.targetedWeaknesses,
        attempt.myText,
        attempt.correctedText,
        attempt.whatWorked,
        attempt.overallScore
      );
    const id = Number(info.lastInsertRowid);

    const insertError = db.prepare(
      `INSERT INTO errors
         (attempt_id, created_at, module, error_category, target_item,
          my_fragment, corrected_fragment, explanation_short, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of errors) {
      insertError.run(
        id,
        now,
        errorModule,
        e.error_category,
        e.target_item,
        e.my_fragment,
        e.corrected_fragment,
        e.explanation_short,
        e.severity
      );
    }
    return id;
  })();
}
