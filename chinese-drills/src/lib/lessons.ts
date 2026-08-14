import fs from "fs";
import path from "path";
import type { Lesson, VocabItem } from "./types";

interface LessonsFile {
  _note?: string;
  lessons: Lesson[];
}

// Re-read on every call in dev so hand-edits to lessons.json show up
// without a server restart; cached in production.
let cache: Lesson[] | null = null;

export function getLessons(): Lesson[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const file = path.join(process.cwd(), "data", "lessons.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as LessonsFile;
  cache = parsed.lessons;
  return cache;
}

export function getLessonRange(start: number, end: number): Lesson[] {
  return getLessons().filter((l) => l.lesson >= start && l.lesson <= end);
}

export function getLessonsForBooks(books: string[]): Lesson[] {
  if (books.length === 0) return getLessons();
  return getLessons().filter((l) => l.book && books.includes(l.book));
}

/** Highest lesson number present in the data (20 for Level 1 only, 40 with Level 2). */
export function maxLesson(): number {
  return getLessons().reduce((n, l) => Math.max(n, l.lesson), 0);
}

export interface BookSummary {
  book: string;
  lessons: number;
  words: number;
  lessonStart: number;
  lessonEnd: number;
}

export function bookSummaries(): BookSummary[] {
  const byBook = new Map<string, Lesson[]>();
  for (const l of getLessons()) {
    const key = l.book ?? "L1P1";
    const list = byBook.get(key) ?? [];
    list.push(l);
    byBook.set(key, list);
  }
  return [...byBook.entries()]
    .map(([book, list]) => ({
      book,
      lessons: list.length,
      words: list.reduce((n, l) => n + l.vocab.length, 0),
      lessonStart: Math.min(...list.map((l) => l.lesson)),
      lessonEnd: Math.max(...list.map((l) => l.lesson)),
    }))
    .sort((a, b) => a.lessonStart - b.lessonStart);
}

/** Every vocabulary item, tagged with the lesson and book it belongs to. */
export function allVocab(): (VocabItem & { book: string; lesson: number })[] {
  return getLessons().flatMap((l) =>
    l.vocab.map((v) => ({ ...v, book: l.book ?? "L1P1", lesson: l.lesson }))
  );
}
