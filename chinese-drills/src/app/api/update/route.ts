import { NextRequest, NextResponse } from "next/server";
import { checkForUpdate, currentVersion, startUpdate, updateLog } from "@/lib/update";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("local") === "1") {
    // Version only — no network round trip.
    return NextResponse.json({ current: currentVersion() });
  }
  if (params.get("log") === "1") {
    return NextResponse.json({ log: updateLog() });
  }
  return NextResponse.json(await checkForUpdate());
}

export async function POST() {
  try {
    const from = currentVersion().version;
    startUpdate();
    return NextResponse.json({ started: true, from });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Update failed to start" },
      { status: 500 }
    );
  }
}
