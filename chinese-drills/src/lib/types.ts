export type TaskSize = "sentence" | "three_sentences" | "paragraph";

export type Severity = "critical" | "major" | "minor";

export const ERROR_CATEGORIES = [
  "word_choice",
  "word_order",
  "grammar_pattern",
  "measure_word",
  "particle",
  "collocation",
  "register",
  "missing_structure",
  "other",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface VocabItem {
  hanzi: string;
  pinyin: string;
  english: string;
  traditional?: string;
  /** Textbook part-of-speech code (n, v, adj, m, …). */
  pos?: string;
}

export interface GrammarPattern {
  pattern: string;
  description: string;
  pinyin?: string;
}

export interface Lesson {
  lesson: number;
  theme: string;
  vocab: VocabItem[];
  grammar: GrammarPattern[];
  /** Which book this lesson comes from: L1P1, L1P2, L2P1, L2P2. */
  book?: string;
  /** Lesson number within that book (Level 2 restarts at 1). */
  book_lesson?: number;
  title_zh?: string;
  title_pinyin?: string;
  title_en?: string;
  confidence?: "high" | "medium" | "low";
}

export const BOOK_LABELS: Record<string, string> = {
  L1P1: "Level 1 · Part 1",
  L1P2: "Level 1 · Part 2",
  L2P1: "Level 2 · Part 1",
  L2P2: "Level 2 · Part 2",
};

/** A weakness the targeting engine decided to drill, with the log rows that motivated it. */
export interface TargetedWeakness {
  kind: "category" | "item";
  value: string;
  error_ids: number[];
}

/** What the model returns for task generation, plus server-side bookkeeping. */
export interface GeneratedTask {
  prompt_en: string;
  target_vocab: VocabItem[];
  target_grammar: GrammarPattern[];
  difficulty: number;
  // server-side additions
  lesson_start: number;
  lesson_end: number;
  task_size: TaskSize;
  targeted: boolean;
  targeted_weaknesses: TargetedWeakness[];
}

export interface GradedError {
  error_category: ErrorCategory;
  target_item: string | null;
  my_fragment: string;
  /** Pinyin of my_fragment. What you wrote is Chinese too, so it carries its
   *  reading — otherwise the half of the correction you most need to recognise
   *  is the half shown bare. */
  my_fragment_pinyin?: string;
  corrected_fragment: string;
  /** Pinyin of corrected_fragment — the three-part rule. */
  corrected_fragment_pinyin?: string;
  explanation_short: string;
  severity: Severity;
}

export interface MicroTask {
  instruction_en: string;
  source_sentence: string;
  source_sentence_pinyin?: string;
}

export interface GradingResult {
  corrected_text: string;
  /** Pinyin + meaning of the corrected sentence — the three-part rule. */
  corrected_pinyin?: string;
  corrected_english?: string;
  /** Pinyin + literal meaning of what the learner actually wrote. */
  my_text_pinyin?: string;
  my_text_english?: string;
  overall_score: number;
  what_worked: string;
  errors: GradedError[];
  micro_task: MicroTask | null;
}

export interface DiagnosisPattern {
  pattern_en: string;
  drill_suggestion: string;
}

export interface AttemptRow {
  id: number;
  created_at: string;
  local_date: string;
  kind: "task" | "micro" | "dictation";
  parent_attempt_id: number | null;
  lesson_start: number;
  lesson_end: number;
  task_size: TaskSize;
  task_prompt: string;
  target_vocab: string;
  target_grammar: string;
  targeted: number;
  targeted_weaknesses: string | null;
  my_text: string;
  corrected_text: string;
  what_worked: string;
  overall_score: number;
}

export interface ErrorRow {
  id: number;
  attempt_id: number;
  created_at: string;
  module: string;
  error_category: ErrorCategory;
  target_item: string | null;
  my_fragment: string;
  corrected_fragment: string;
  explanation_short: string;
  severity: Severity;
  resolved_count: number;
}

export interface AppSettings {
  default_lesson_start: number;
  default_lesson_end: number;
  daily_rep_target: number;
  difficulty: number;
  tts_voice: "xiaoxiao" | "yunxi";
  srs_new_per_day: number;
  srs_max_reviews: number;
  srs_directions: "recognize" | "both";
  srs_include_characters: boolean;
}
