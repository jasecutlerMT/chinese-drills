import { NextRequest, NextResponse } from "next/server";
import { readJson, badRequest } from "@/lib/http";
import { nextTask } from "@/lib/tasks";
import { maxLesson } from "@/lib/lessons";
import type { TaskSize } from "@/lib/types";

export const dynamic = "force-dynamic";

const SIZES: TaskSize[] = ["sentence", "three_sentences", "paragraph"];

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    if (!body) return badRequest();
    const lessonStart = Number(body.lessonStart);
    const lessonEnd = Number(body.lessonEnd);
    const taskSize = body.taskSize as TaskSize;

    if (
      !Number.isInteger(lessonStart) ||
      !Number.isInteger(lessonEnd) ||
      lessonStart < 1 ||
      lessonEnd > maxLesson() ||
      lessonStart > lessonEnd
    ) {
      return NextResponse.json({ error: "Invalid lesson range" }, { status: 400 });
    }
    if (!SIZES.includes(taskSize)) {
      return NextResponse.json({ error: "Invalid task size" }, { status: 400 });
    }

    const task = await nextTask({ lessonStart, lessonEnd, taskSize });
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Task generation failed" },
      { status: 500 }
    );
  }
}
