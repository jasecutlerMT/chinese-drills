import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Shuts the app down. The launcher script's loop sees no .restart sentinel
 * and exits cleanly, leaving the Terminal window with a "press Enter to
 * close" prompt.
 */
export async function POST() {
  setTimeout(() => process.exit(0), 400).unref();
  return NextResponse.json({ bye: true });
}
