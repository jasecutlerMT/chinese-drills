import { NextRequest, NextResponse } from "next/server";
import { checkHealth } from "@/lib/health";
import { getProvider } from "@/lib/llm/cli-provider";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("speed") === "1") {
    // A real, timed round trip so slowness reports come with data. Queue
    // wait (the app being busy with its own background work) is separated
    // out so the verdict blames the right thing.
    const started = Date.now();
    let queuedMs = 0;
    try {
      await getProvider().complete({
        prompt: "Reply with exactly: ok",
        system: "Reply with exactly what is asked, nothing else.",
        tier: "fast",
        timeoutMs: 90_000,
        onQueued: (ms) => {
          queuedMs = ms;
        },
      });
      const totalMs = Date.now() - started;
      const modelMs = totalMs - queuedMs;
      let verdict =
        modelMs < 8_000
          ? "healthy"
          : modelMs < 25_000
            ? "slower than usual — fine, but expect short waits"
            : "unusually slow — try closing other apps, or check your internet";
      if (queuedMs > 2_000) {
        verdict += ` (the app was busy with background work for ${Math.round(queuedMs / 1000)}s of this — run the test again in a moment)`;
      }
      return NextResponse.json({ ok: true, ms: modelMs, totalMs, queuedMs, verdict });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : "Speed test failed",
        },
        { status: 500 }
      );
    }
  }
  return NextResponse.json(await checkHealth());
}
