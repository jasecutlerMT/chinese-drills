import type {
  GeneratedTask,
  GradingResult,
  GradedError,
  Lesson,
  TaskSize,
  TargetedWeakness,
  VocabItem,
  GrammarPattern,
  DiagnosisPattern,
  ErrorRow,
} from "./types";
import { ERROR_CATEGORIES } from "./types";
import { CJK_CHAR_RE } from "./cjk";

const JSON_ONLY =
  "All Chinese you write must be SIMPLIFIED characters only — never traditional. " +
  "Reply with ONLY a single JSON object. No code fences, no commentary, no text before or after the JSON.";

const SIZE_DESCRIPTION: Record<TaskSize, string> = {
  sentence: "exactly one sentence",
  three_sentences: "three sentences",
  paragraph: "a short paragraph of 4-6 sentences",
};

export const GENERATION_SYSTEM =
  "You generate written-production drills for an intermediate learner of Mandarin Chinese " +
  "working through Integrated Chinese Level 1 (Simplified). The learner has solid pinyin, tones, " +
  "and foundational grammar; their weakness is active production, so tasks must force output, " +
  "not test recognition. " +
  JSON_ONLY;

export function buildGenerationPrompt(opts: {
  lessons: Lesson[];
  taskSize: TaskSize;
  difficulty: number;
  targeted: TargetedWeakness[];
  recentPrompts: string[];
  srsFocus?: { hanzi: string; pinyin: string; english: string }[];
}): string {
  const vocabPool = opts.lessons
    .flatMap((l) => l.vocab)
    .map((v) => `${v.hanzi} (${v.pinyin}) - ${v.english}`)
    .join("\n");
  const grammarPool = opts.lessons
    .flatMap((l) => l.grammar)
    .map((g) => `${g.pattern}${g.pinyin ? ` (${g.pinyin})` : ""}: ${g.description}`)
    .join("\n");
  const themes = opts.lessons.map((l) => `L${l.lesson}: ${l.theme}`).join("; ");

  let targeting = "";
  if (opts.targeted.length > 0) {
    const desc = opts.targeted
      .map((w) =>
        w.kind === "category"
          ? `the error category "${w.value}"`
          : `correct use of "${w.value}"`
      )
      .join(" and ");
    targeting =
      `\nWEAKNESS TARGETING: this learner has recently struggled with ${desc}. ` +
      "Design the situation so a correct answer naturally requires exactly that. " +
      "Do not mention to the learner that this is remedial.";
  }

  let srs = "";
  if (opts.srsFocus && opts.srsFocus.length > 0) {
    srs =
      "\nFLASHCARD FOCUS: the learner is currently struggling to memorise these words — " +
      "prefer 1-2 of them among your target vocabulary if they fit the situation naturally:\n" +
      opts.srsFocus.map((v) => `${v.hanzi} (${v.pinyin}) - ${v.english}`).join("; ");
  }

  let avoid = "";
  if (opts.recentPrompts.length > 0) {
    avoid =
      "\nDo not repeat these recent task situations:\n- " +
      opts.recentPrompts.map((p) => p.slice(0, 120)).join("\n- ");
  }

  return `Create one written-production task for this learner.

Lesson themes in scope: ${themes}

VOCABULARY POOL (choose targets ONLY from this list):
${vocabPool}

GRAMMAR POOL (choose targets ONLY from this list):
${grammarPool}

Requirements:
- The answer should be ${SIZE_DESCRIPTION[opts.taskSize]} in simplified Chinese.
- Give a concrete situation or English prompt to respond to (in English).
- Pick 3-6 target vocabulary items and 1-2 target grammar patterns from the pools above that a good answer would naturally use together.
- Difficulty level: ${opts.difficulty} of 5. At 1-2 the situation is concrete and the targets are common words; at 4-5 the situation demands opinion, sequencing, or contrast and combines less-frequent targets.${targeting}${srs}${avoid}

Every Chinese item you return carries its pinyin (tone marks) and its English meaning —
the learner always sees all three together.

Return this JSON shape:
{
  "prompt_en": "string - the situation, in English",
  "target_vocab": [{ "hanzi": "...", "pinyin": "...", "english": "..." }],
  "target_grammar": [{ "pattern": "...", "pinyin": "pinyin of the pattern", "description": "..." }],
  "difficulty": ${opts.difficulty}
}`;
}

export const GRADING_SYSTEM =
  "You are a strict but fair Mandarin Chinese writing grader for an intermediate learner. " +
  "Grade against NATURAL Mandarin as used by native speakers, not merely 'understandable' Chinese. " +
  "Grammatical but unnatural phrasing is an error (word_choice or collocation, severity minor). " +
  "NEVER invent errors: if the writing is genuinely fine, return an empty errors array. " +
  "All feedback is in English; every Chinese example you give must be in simplified characters " +
  "followed by pinyin in parentheses. " +
  JSON_ONLY;

export function buildGradingPrompt(opts: {
  taskPrompt: string;
  targetVocab: VocabItem[];
  targetGrammar: GrammarPattern[];
  taskSize: TaskSize;
  myText: string;
}): string {
  const vocab = opts.targetVocab.map((v) => `${v.hanzi} (${v.pinyin}) - ${v.english}`).join("; ");
  const grammar = opts.targetGrammar.map((g) => `${g.pattern} (${g.description})`).join("; ");

  return `The learner was given this task (expected length: ${SIZE_DESCRIPTION[opts.taskSize]}):
"${opts.taskPrompt}"
Target vocabulary they were asked to use: ${vocab}
Target grammar patterns they were asked to use: ${grammar}

Their answer in simplified Chinese:
"""
${opts.myText}
"""

Grade it. Rules:
- corrected_text: a full, natural rewrite of their answer in simplified characters. If their answer is already natural, return it unchanged.
- overall_score: 0-100. 90+ means natural and correct; 70-89 minor issues only; 40-69 clear grammar errors; below 40 meaning is broken somewhere.
- what_worked: exactly one sentence in English naming something genuinely good in the answer.
- errors: every real error, each categorized. Categories: ${ERROR_CATEGORIES.join(", ")}.
  particle covers 了, 的/得/地, 把, 被, 吗, 呢, 吧 and similar.
  Severity: "critical" = meaning broken or wrong; "major" = clear grammar error; "minor" = grammatical but unnatural phrasing.
  target_item: the specific vocabulary word or grammar pattern implicated (from the targets above if applicable, otherwise the actual word/pattern misused), or null.
  my_fragment / corrected_fragment: the shortest span that shows the error and its fix.
  explanation_short: 1-2 sentences in English; any Chinese examples in simplified characters with pinyin.
- If a target vocabulary item or grammar pattern was asked for but simply not used, log it as missing_structure (severity major) with that item as target_item.
- Do NOT invent errors. A fine answer gets an empty errors array, a score of 90+, and one approving sentence in what_worked.
- micro_task: null unless at least one error is major or critical. If so, pick the single worst error and set:
  instruction_en: one sentence telling the learner to rewrite applying the fix (name the rule, not the answer),
  source_sentence: the learner's original sentence containing that error,
  source_sentence_pinyin: that sentence's pinyin with tone marks.

THREE-PART RULE: every Chinese string you return is accompanied by its pinyin (with tone
marks), and every whole sentence also by its English meaning — the learner always sees
characters, pinyin and meaning together.

Return this JSON shape:
{
  "corrected_text": "...",
  "corrected_pinyin": "pinyin of corrected_text, with tone marks",
  "corrected_english": "what the corrected sentence means in English",
  "my_text_pinyin": "pinyin of what the learner actually wrote",
  "my_text_english": "a literal English rendering of what the learner actually wrote — what they said, not what they meant",
  "overall_score": 0,
  "what_worked": "...",
  "errors": [{ "error_category": "...", "target_item": "... or null", "my_fragment": "...", "corrected_fragment": "...", "corrected_fragment_pinyin": "pinyin of corrected_fragment", "explanation_short": "...", "severity": "..." }],
  "micro_task": null
}`;
}

// Translation streams as plain text (not JSON) so partial output can be
// rendered live: first the translation, then a line with exactly ---, then
// the pinyin. parseTranslationText() splits the final buffer.
/** Which way a translation runs. "yue" targets are Cantonese. */
export type TranslateDirection = "en2zh" | "zh2en" | "en2yue" | "zh2yue";

export const TRANSLATE_SYSTEM =
  "You are a precise, natural translator between English, Mandarin Chinese and Cantonese. " +
  "Translate meaning and register, not word-for-word. All Chinese must be SIMPLIFIED " +
  "characters only — never traditional. Cantonese must be colloquial spoken Cantonese as " +
  "used in Hong Kong (\u53e3\u8bed), using Cantonese-specific words and particles rather than " +
  "Mandarin wording written out. Output EXACTLY the requested format: no preamble, no " +
  "commentary, no quotes around the text.";

export function buildTranslatePrompt(text: string, direction: TranslateDirection): string {
  if (direction === "en2zh") {
    return `Translate this English text into natural, everyday Mandarin (simplified characters).

"""
${text}
"""

Output format — nothing else:
<the Mandarin translation>
---
<full pinyin of the translation, with tone marks>`;
  }
  if (direction === "zh2en") {
    return `Translate this Chinese text into natural English.

"""
${text}
"""

Output format — nothing else:
<the English translation>
---
<full pinyin of the ORIGINAL Chinese text, with tone marks>`;
  }
  if (direction === "en2yue") {
    return `Translate this English text into natural, colloquial spoken Cantonese as used in
Hong Kong, written in SIMPLIFIED characters.

Use real Cantonese vocabulary and particles (\u5514\u3001\u5605\u3001\u54ba\u3001\u4fc2\u3001\u55ba\u3001\u55ad and so on) — do not
just write the Mandarin sentence out. Simplified characters only.

"""
${text}
"""

Output format — nothing else:
<the Cantonese translation, simplified characters>
---
<full Jyutping romanization with tone NUMBERS, e.g. nei5 hou2 maa3>`;
  }
  return `Rewrite this Chinese text (it may be Mandarin, or already Cantonese) as natural,
colloquial spoken Cantonese as used in Hong Kong, written in SIMPLIFIED characters.

Use real Cantonese vocabulary and particles (\u5514\u3001\u5605\u3001\u54ba\u3001\u4fc2\u3001\u55ba\u3001\u55ad and so on) — do not
just repeat the Mandarin wording. Simplified characters only.

"""
${text}
"""

Output format — nothing else:
<the Cantonese version, simplified characters>
---
<full Jyutping romanization with tone NUMBERS, e.g. nei5 hou2 maa3>
---
<what it means in natural English, one line>`;
}

/**
 * The line of dashes that separates the parts of a translation reply.
 *
 * Deliberately forgiving about whitespace: the old pattern required the
 * dashes to sit immediately after a newline, so a single leading space made
 * the split fail silently and the romanization ended up glued onto the end of
 * the translation — stored in the history and read aloud that way.
 */
export const TRANSLATE_SEPARATOR = /\r?\n[ \t]*-{3,}[ \t]*\r?\n?/;

export function parseTranslationText(raw: string): {
  translation: string;
  pinyin: string | null;
  gloss: string | null;
} {
  const cleaned = raw.trim().replace(/^```[a-z]*\n?|```$/g, "");
  let parts = cleaned.split(TRANSLATE_SEPARATOR);
  // Last resort for a reply that ran the separator onto the same line.
  if (parts.length === 1 && /-{3,}/.test(cleaned)) {
    parts = cleaned.split(/[ \t]*-{3,}[ \t]*/);
  }
  // And for one that left the separator out altogether but still answered in
  // the right shape: characters on the first line, romanization underneath.
  // Without this the romanization is glued to the translation, then stored in
  // the history and read aloud as part of the sentence.
  if (parts.length === 1) {
    const lines = cleaned.split(/\r?\n/).filter((l) => l.trim());
    const firstRoman = lines.findIndex((l, i) => i > 0 && !CJK_CHAR_RE.test(l) && /[a-zA-Z]/.test(l));
    if (firstRoman > 0 && CJK_CHAR_RE.test(lines[0])) {
      parts = [lines.slice(0, firstRoman).join("\n"), ...lines.slice(firstRoman)];
    }
  }
  const translation = (parts[0] ?? "").trim();
  const pinyin = (parts[1] ?? "").trim() || null;
  const gloss = (parts[2] ?? "").trim() || null;
  if (!translation) fail("empty translation");
  return { translation, pinyin, gloss };
}

export const DICTATION_SYSTEM =
  "You create one-sentence Mandarin dictation exercises for an intermediate learner " +
  "working through Integrated Chinese Level 1. Sentences must be natural spoken Mandarin. " +
  JSON_ONLY;

export function buildDictationPrompt(opts: {
  lessons: Lesson[];
  difficulty: number;
  targeted: TargetedWeakness[];
  recentSentences: string[];
}): string {
  const vocabPool = opts.lessons
    .flatMap((l) => l.vocab)
    .map((v) => `${v.hanzi} (${v.english})`)
    .join(", ");

  let targeting = "";
  if (opts.targeted.length > 0) {
    const desc = opts.targeted
      .map((w) => (w.kind === "category" ? `the error category "${w.value}"` : `"${w.value}"`))
      .join(" and ");
    targeting = `\nThe learner has recently struggled with ${desc} — build the sentence so hearing/writing it exercises exactly that.`;
  }

  let avoid = "";
  if (opts.recentSentences.length > 0) {
    avoid = "\nDo not reuse these recent sentences:\n- " + opts.recentSentences.join("\n- ");
  }

  return `Create ONE sentence for a listening dictation exercise (the learner hears it and must
type exactly what they heard).

VOCABULARY POOL (build the sentence from these words plus basic function words):
${vocabPool}

Requirements:
- One natural spoken-Mandarin sentence, simplified characters.
- Difficulty ${opts.difficulty} of 5: at 1-2 use 6-10 characters and very common words; at 3, 10-16
  characters; at 4-5, 16-24 characters with a subordinate clause or time/place phrases.
- No proper names except 北京/上海/中国. Standard punctuation (。？！only).${targeting}${avoid}

Return this JSON shape:
{ "sentence": "...", "pinyin": "...", "english": "..." }`;
}

export function validateDictation(x: unknown): {
  sentence: string;
  pinyin: string;
  english: string;
} {
  const d = x as { sentence?: string; pinyin?: string; english?: string };
  if (!d || typeof d.sentence !== "string" || d.sentence.length < 4) fail("sentence missing");
  return {
    sentence: d.sentence,
    pinyin: typeof d.pinyin === "string" ? d.pinyin : "",
    english: typeof d.english === "string" ? d.english : "",
  };
}

export const MICRO_SYSTEM =
  "You check a single-sentence rewrite by an intermediate Mandarin learner. Be quick and strict. " +
  "Feedback in English; Chinese examples in simplified characters with pinyin. " +
  JSON_ONLY;

export function buildMicroPrompt(opts: {
  instruction: string;
  sourceSentence: string;
  fixExplanation: string;
  myText: string;
}): string {
  return `The learner made an error in this sentence: "${opts.sourceSentence}"
The fix they were taught: ${opts.fixExplanation}
They were told: "${opts.instruction}"

Their rewrite:
"""
${opts.myText}
"""

Did the rewrite apply the fix correctly and is the sentence natural? Use the same rules as full grading (never invent errors; empty errors array if fine). overall_score: 0-100. what_worked: one English sentence. micro_task must be null.

Every Chinese string you return carries its pinyin AND its English meaning.

Return this JSON shape:
{
  "corrected_text": "...",
  "corrected_pinyin": "tone-marked pinyin for corrected_text",
  "corrected_english": "what corrected_text means in English",
  "my_text_pinyin": "tone-marked pinyin for what the learner wrote",
  "my_text_english": "a literal English rendering of what the learner wrote",
  "overall_score": 0,
  "what_worked": "...",
  "errors": [{ "error_category": "...", "target_item": "... or null", "my_fragment": "...", "corrected_fragment": "...", "corrected_fragment_pinyin": "...", "explanation_short": "...", "severity": "..." }],
  "micro_task": null
}`;
}

export const DIAGNOSE_SYSTEM =
  "You analyze a Mandarin learner's error log to find their recurring weaknesses. " +
  "Speak plainly and concretely; the learner is intermediate, so skip beginner explainers. " +
  JSON_ONLY;

export function buildDiagnosePrompt(errors: ErrorRow[]): string {
  const lines = errors
    .map(
      (e) =>
        `[${e.created_at.slice(0, 10)}] ${e.error_category}` +
        (e.target_item ? ` (${e.target_item})` : "") +
        ` ${e.severity}: "${e.my_fragment}" -> "${e.corrected_fragment}" | ${e.explanation_short}`
    )
    .join("\n");

  return `Here are this learner's last ${errors.length} composition errors, newest first:

${lines}

Identify their top 3 recurring patterns (fewer if the log genuinely shows fewer). For each: a plain-English description of the pattern (not just the category name - say what they actually do wrong), and ONE targeted drill suggestion they could do in writing practice.

Return this JSON shape:
{
  "patterns": [{ "pattern_en": "...", "drill_suggestion": "..." }]
}`;
}

/**
 * Examples stream in as plain lines rather than one JSON object, so the first
 * sentence can reach the screen while the rest are still being written. The
 * skeleton used to sit there for the whole generation — and on a bad run, for
 * minutes — because nothing could be shown until the final brace arrived.
 */
export const EXAMPLES_SYSTEM =
  "You write example sentences for a Chinese-English dictionary used by an intermediate " +
  "Mandarin learner. Sentences must be natural, everyday Mandarin in simplified characters. " +
  "Output EXACTLY 5 lines and nothing else: no numbering, no preamble, no code fences, no " +
  "blank lines. Each line is: <sentence> ||| <full pinyin with tone marks> ||| <natural " +
  "English translation>";

export function buildExamplesPrompt(entry: {
  simplified: string;
  pinyin_marks: string;
  definitions: string[];
}): string {
  return `Dictionary entry: ${entry.simplified} (${entry.pinyin_marks}) — ${entry.definitions.join("; ")}

Write 5 example sentences showing how ${entry.simplified} is actually used, as a DIFFICULTY
PROGRESSION for a learner working through Integrated Chinese:
- Line 1: very short beginner sentence (6-10 characters, HSK 1-2 vocabulary only apart
  from the headword itself).
- Line 2: simple everyday sentence (10-16 characters).
- Line 3: a question or common spoken pattern.
- Lines 4-5: natural native-length sentences covering the word's other senses or most
  common collocations.

Five lines, each exactly:
<sentence> ||| <pinyin with tone marks> ||| <English translation>`;
}

/**
 * One streamed line into an example. Difficulty comes from the line's position,
 * never from the model — the prompt already orders them easiest first, and a
 * number the model invents is one more thing that can be wrong.
 */
export function parseExampleLine(
  line: string,
  index: number
): { hanzi: string; pinyin: string; english: string; difficulty: number } | null {
  const cleaned = line
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```$/, "")
    .replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, "")
    .trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s*\|\|\|\s*/);
  const hanzi = (parts[0] ?? "").trim();
  if (!hanzi || !CJK_CHAR_RE.test(hanzi)) return null;
  return {
    hanzi,
    pinyin: (parts[1] ?? "").trim(),
    english: (parts[2] ?? "").trim(),
    difficulty: Math.min(5, index + 1),
  };
}

// ---------- validators (shape checks for model JSON) ----------

function fail(msg: string): never {
  throw new Error(msg);
}

function isVocab(x: unknown): x is VocabItem {
  const v = x as VocabItem;
  return (
    !!v &&
    typeof v.hanzi === "string" &&
    typeof v.pinyin === "string" &&
    typeof v.english === "string"
  );
}

function isGrammar(x: unknown): x is GrammarPattern {
  const g = x as GrammarPattern;
  return !!g && typeof g.pattern === "string" && typeof g.description === "string";
}

export function validateGeneratedTask(
  x: unknown
): Pick<GeneratedTask, "prompt_en" | "target_vocab" | "target_grammar" | "difficulty"> {
  const t = x as GeneratedTask;
  if (!t || typeof t.prompt_en !== "string" || t.prompt_en.length < 10)
    fail("prompt_en missing");
  if (!Array.isArray(t.target_vocab) || t.target_vocab.length < 1 || !t.target_vocab.every(isVocab))
    fail("target_vocab invalid");
  if (
    !Array.isArray(t.target_grammar) ||
    t.target_grammar.length < 1 ||
    !t.target_grammar.every(isGrammar)
  )
    fail("target_grammar invalid");
  const difficulty =
    typeof t.difficulty === "number" && t.difficulty >= 1 && t.difficulty <= 5
      ? Math.round(t.difficulty)
      : 3;
  return {
    prompt_en: t.prompt_en,
    target_vocab: t.target_vocab.slice(0, 6),
    target_grammar: t.target_grammar.slice(0, 2),
    difficulty,
  };
}

export function validateGrading(x: unknown): GradingResult {
  const g = x as GradingResult;
  if (!g || typeof g.corrected_text !== "string") fail("corrected_text missing");
  if (typeof g.overall_score !== "number") fail("overall_score missing");
  if (typeof g.what_worked !== "string") fail("what_worked missing");
  if (!Array.isArray(g.errors)) fail("errors missing");

  const errors: GradedError[] = g.errors.map((e) => {
    const category = (ERROR_CATEGORIES as readonly string[]).includes(e?.error_category)
      ? e.error_category
      : "other";
    const severity = ["critical", "major", "minor"].includes(e?.severity)
      ? e.severity
      : "minor";
    if (typeof e?.my_fragment !== "string" || typeof e?.corrected_fragment !== "string")
      fail("error fragment missing");
    return {
      error_category: category,
      target_item: typeof e.target_item === "string" && e.target_item ? e.target_item : null,
      my_fragment: e.my_fragment,
      corrected_fragment: e.corrected_fragment,
      corrected_fragment_pinyin: str(e.corrected_fragment_pinyin),
      explanation_short:
        typeof e.explanation_short === "string" ? e.explanation_short : "",
      severity,
    };
  });

  let micro = null;
  if (
    g.micro_task &&
    typeof g.micro_task.instruction_en === "string" &&
    typeof g.micro_task.source_sentence === "string"
  ) {
    micro = {
      instruction_en: g.micro_task.instruction_en,
      source_sentence: g.micro_task.source_sentence,
      source_sentence_pinyin: str(g.micro_task.source_sentence_pinyin),
    };
  }
  // Enforce the spec regardless of model mood: micro-task exists iff a
  // major/critical error does.
  const hasMajor = errors.some((e) => e.severity === "major" || e.severity === "critical");
  if (!hasMajor) micro = null;

  return {
    corrected_text: g.corrected_text,
    corrected_pinyin: str(g.corrected_pinyin),
    corrected_english: str(g.corrected_english),
    my_text_pinyin: str(g.my_text_pinyin),
    my_text_english: str(g.my_text_english),
    overall_score: Math.max(0, Math.min(100, Math.round(g.overall_score))),
    what_worked: g.what_worked,
    errors,
    micro_task: micro,
  };
}

/** Optional string field: keep it only if the model actually filled it in. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function validateDiagnosis(x: unknown): DiagnosisPattern[] {
  const d = x as { patterns?: DiagnosisPattern[] };
  if (!d || !Array.isArray(d.patterns)) fail("patterns missing");
  return d.patterns
    .filter(
      (p) => p && typeof p.pattern_en === "string" && typeof p.drill_suggestion === "string"
    )
    .slice(0, 3);
}
