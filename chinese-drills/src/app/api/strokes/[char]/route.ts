import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// Exactly one CJK character (the data set covers these ranges).
const CJK_CHAR = /^[㐀-鿿豈-﫿]$/u;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ char: string }> }) {
  const char = decodeURIComponent((await params).char);
  if (!CJK_CHAR.test(char)) {
    return NextResponse.json({ error: "Not a Chinese character" }, { status: 400 });
  }
  const file = path.join(process.cwd(), "node_modules", "hanzi-writer-data", `${char}.json`);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: "No stroke data for this character" }, { status: 404 });
  }
  return new NextResponse(fs.readFileSync(file, "utf-8"), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
