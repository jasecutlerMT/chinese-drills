import { NextRequest, NextResponse } from "next/server";
import { searchDict, recentLookups } from "@/lib/dict";
import { wordOfTheDay, lessonPicks } from "@/lib/wotd";
import { prewarmAudio } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    if (!q.trim()) {
      const wotd = wordOfTheDay();
      const picks = lessonPicks();
      // The landing screen shows these with speaker buttons, so warm the ones
      // most likely to be pressed while the page is still rendering.
      prewarmAudio([wotd?.simplified, ...picks.slice(0, 3).map((p) => p.hanzi)]);
      return NextResponse.json({
        results: [],
        recent: recentLookups(),
        wotd,
        lessonPicks: picks,
      });
    }
    return NextResponse.json({ results: searchDict(q), recent: [] });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
