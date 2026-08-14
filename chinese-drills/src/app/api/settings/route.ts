import { NextRequest, NextResponse } from "next/server";
import { readJson, badRequest } from "@/lib/http";
import { getSettings, setSetting } from "@/lib/settings";
import { maxLesson } from "@/lib/lessons";
import { prewarmAudio } from "@/lib/tts";
import { VOICE_SAMPLE } from "@/lib/voice-sample";

export const dynamic = "force-dynamic";

export async function GET() {
  // The voice sample is the first thing anyone presses on this page.
  prewarmAudio([VOICE_SAMPLE]);
  return NextResponse.json(getSettings());
}

export async function PUT(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return badRequest();
  const start = Number(body.default_lesson_start);
  const end = Number(body.default_lesson_end);
  const target = Number(body.daily_rep_target);

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end > maxLesson() ||
    start > end
  ) {
    return NextResponse.json({ error: "Invalid lesson range" }, { status: 400 });
  }
  if (!Number.isInteger(target) || target < 1 || target > 100) {
    return NextResponse.json({ error: "Invalid daily rep target" }, { status: 400 });
  }

  setSetting("default_lesson_start", start);
  setSetting("default_lesson_end", end);
  setSetting("daily_rep_target", target);
  if (body.tts_voice === "xiaoxiao" || body.tts_voice === "yunxi") {
    setSetting("tts_voice", body.tts_voice);
    // A new voice means a new cache key, so the old sample is no help.
    prewarmAudio([VOICE_SAMPLE]);
  }
  const newPerDay = Number(body.srs_new_per_day);
  if (Number.isInteger(newPerDay) && newPerDay >= 0 && newPerDay <= 500) {
    setSetting("srs_new_per_day", newPerDay);
  }
  const maxReviews = Number(body.srs_max_reviews);
  if (Number.isInteger(maxReviews) && maxReviews >= 10 && maxReviews <= 9999) {
    setSetting("srs_max_reviews", maxReviews);
  }
  if (body.srs_directions === "recognize" || body.srs_directions === "both") {
    setSetting("srs_directions", body.srs_directions);
  }
  if (typeof body.srs_include_characters === "boolean") {
    setSetting("srs_include_characters", body.srs_include_characters);
  }
  return NextResponse.json(getSettings());
}
