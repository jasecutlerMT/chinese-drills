import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProvider } from "@/lib/llm/cli-provider";
import { completeJSON } from "@/lib/llm/json";
import { DIAGNOSE_SYSTEM, buildDiagnosePrompt, validateDiagnosis } from "@/lib/prompts";
import type { ErrorRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const db = getDb();
    const errors = db
      .prepare("SELECT * FROM errors ORDER BY id DESC LIMIT 50")
      .all() as ErrorRow[];

    if (errors.length < 5) {
      return NextResponse.json(
        { error: `Only ${errors.length} errors logged so far. Do a few more reps first.` },
        { status: 400 }
      );
    }

    const patterns = await completeJSON(
      getProvider(),
      { prompt: buildDiagnosePrompt(errors), system: DIAGNOSE_SYSTEM, tier: "smart" },
      validateDiagnosis
    );

    return NextResponse.json({ patterns, errorCount: errors.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Diagnosis failed" },
      { status: 500 }
    );
  }
}
