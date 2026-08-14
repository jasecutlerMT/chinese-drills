import { NextRequest, NextResponse } from "next/server";
import { srsStats, deckCounts, strugglingWords, ensureSrs } from "@/lib/srs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureSrs();
  const params = req.nextUrl.searchParams;
  const start = Number(params.get("lessonStart"));
  const end = Number(params.get("lessonEnd"));

  // Asked about a lesson range, the flashcard deck also reports what it owes
  // you today and which words it can see you wobbling on — that is what the
  // Practice page needs to tie the two halves of the app together.
  if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
    return NextResponse.json({
      ...srsStats(),
      scoped: deckCounts({ books: [], lessonStart: start, lessonEnd: end }),
      focus: strugglingWords(start, end, 6),
    });
  }

  return NextResponse.json(srsStats());
}
