import { NextRequest, NextResponse } from "next/server";
import { getDb, localDate } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const db = getDb();
  const today = localDate();
  const extended = req.nextUrl.searchParams.get("extended") === "1";

  const todayReps = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM attempts WHERE kind IN ('task','dictation') AND local_date = ?"
      )
      .get(today) as { n: number }
  ).n;

  // Streak: consecutive practice days ending today (or yesterday, so the
  // streak isn't shown as broken before today's first rep).
  const days = db
    .prepare("SELECT DISTINCT local_date FROM attempts ORDER BY local_date DESC LIMIT 366")
    .all() as { local_date: string }[];
  const daySet = new Set(days.map((d) => d.local_date));

  let streak = 0;
  const cursor = new Date();
  if (!daySet.has(localDate(cursor))) {
    cursor.setDate(cursor.getDate() - 1); // allow streak to be alive before today's first rep
  }
  while (daySet.has(localDate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const settings = getSettings();
  const base = {
    todayReps,
    streak,
    dailyTarget: settings.daily_rep_target,
  };
  if (!extended) return NextResponse.json(base);

  // Last 14 days of reps for the activity sparkline.
  const perDay = new Map<string, number>();
  (
    db
      .prepare(
        `SELECT local_date, COUNT(*) AS n FROM attempts
         WHERE kind IN ('task','dictation') GROUP BY local_date
         ORDER BY local_date DESC LIMIT 60`
      )
      .all() as { local_date: string; n: number }[]
  ).forEach((r) => perDay.set(r.local_date, r.n));
  const daily: { date: string; reps: number }[] = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = localDate(d);
    daily.push({ date: key, reps: perDay.get(key) ?? 0 });
  }

  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM attempts WHERE kind IN ('task','dictation')) AS totalReps,
         (SELECT ROUND(AVG(overall_score)) FROM (
            SELECT overall_score FROM attempts WHERE kind IN ('task','dictation')
            ORDER BY id DESC LIMIT 10)) AS avgScoreLast10,
         (SELECT COUNT(*) FROM errors WHERE resolved_count > 0) AS errorsResolved,
         (SELECT COUNT(*) FROM errors) AS errorsTotal`
    )
    .get();

  return NextResponse.json({ ...base, daily, totals });
}
