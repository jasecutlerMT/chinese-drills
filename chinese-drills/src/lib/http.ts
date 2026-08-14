import { NextRequest, NextResponse } from "next/server";

/**
 * Read a JSON body, or null if it is not JSON.
 *
 * `req.json()` throws a parser error whose message is about tokens and
 * positions. Left uncaught it becomes a 500 — the app reporting a fault of its
 * own for what is really a malformed request — and in one route it produced a
 * 500 with an empty body, which surfaces in the UI as nothing at all.
 */
export async function readJson<T = Record<string, unknown>>(
  req: NextRequest
): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** The response for a body the server could not read. */
export function badRequest(message = "That request wasn't valid JSON."): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}
