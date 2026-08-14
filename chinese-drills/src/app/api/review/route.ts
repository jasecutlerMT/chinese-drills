import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { pinyinFor } from "@/lib/dict";
import type { ErrorRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return doGet();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Review query failed" },
      { status: 500 }
    );
  }
}

function doGet() {
  const db = getDb();

  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM attempts) AS attempts,
         (SELECT COUNT(*) FROM attempts WHERE kind = 'task') AS taskAttempts,
         (SELECT COUNT(*) FROM attempts WHERE targeted = 1) AS targetedAttempts,
         (SELECT COUNT(*) FROM errors) AS errors`
    )
    .get() as {
    attempts: number;
    taskAttempts: number;
    targetedAttempts: number;
    errors: number;
  };

  const byCategory = db
    .prepare(
      `SELECT error_category AS category,
              COUNT(*) AS count,
              SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
              SUM(CASE WHEN severity = 'major' THEN 1 ELSE 0 END) AS major,
              SUM(CASE WHEN severity = 'minor' THEN 1 ELSE 0 END) AS minor,
              SUM(resolved_count) AS resolved,
              MAX(created_at) AS last_seen
       FROM errors
       GROUP BY error_category
       ORDER BY count DESC, last_seen DESC`
    )
    .all();

  const byItem = (
    db
      .prepare(
        `SELECT target_item AS item,
                COUNT(*) AS count,
                SUM(resolved_count) AS resolved,
                MAX(created_at) AS last_seen,
                GROUP_CONCAT(DISTINCT error_category) AS categories
         FROM errors
         WHERE target_item IS NOT NULL
         GROUP BY target_item
         ORDER BY count DESC, last_seen DESC
         LIMIT 30`
      )
      .all() as { item: string }[]
  ).map((r) => ({
    ...r,
    // Three-part rule: weakness items carry their reading too.
    pinyin: /[㐀-鿿]/u.test(r.item) ? pinyinFor(r.item) : "",
  }));

  const recentErrors = (
    db
      .prepare(
        `SELECT e.*, a.targeted AS attempt_targeted
         FROM errors e JOIN attempts a ON a.id = e.attempt_id
         ORDER BY e.id DESC LIMIT 100`
      )
      .all() as (ErrorRow & { attempt_targeted: number })[]
  ).map((e) => ({
    ...e,
    // Three-part rule: both halves of the correction carry their reading —
    // what you wrote as much as what you should have written.
    corrected_pinyin: pinyinFor(e.corrected_fragment),
    my_pinyin: pinyinFor(e.my_fragment),
  }));

  return NextResponse.json({ totals, byCategory, byItem, recentErrors });
}
