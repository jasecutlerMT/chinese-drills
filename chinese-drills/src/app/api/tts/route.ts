import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getAudio, MAX_TTS_CHARS, type SpeakVoice } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const text = (req.nextUrl.searchParams.get("text") ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "Nothing to speak" }, { status: 400 });
  }
  if (text.length > MAX_TTS_CHARS) {
    return NextResponse.json(
      { error: `Text too long for speech (max ${MAX_TTS_CHARS} characters)` },
      { status: 400 }
    );
  }
  if (text.startsWith("-")) {
    return NextResponse.json({ error: "Nothing speakable" }, { status: 400 });
  }
  // Only languages the app actually speaks; an unknown value is a caller bug
  // rather than something to guess at.
  const voiceParam = req.nextUrl.searchParams.get("voice");
  if (voiceParam !== null && voiceParam !== "cantonese") {
    return NextResponse.json({ error: "Unknown voice" }, { status: 400 });
  }
  const voice: SpeakVoice = voiceParam === "cantonese" ? "cantonese" : undefined;
  try {
    const { file, contentType } = await getAudio(text, voice);
    // no-store: the URL doesn't encode the voice setting, and the server's
    // disk cache already makes repeat requests take milliseconds.
    return new NextResponse(new Uint8Array(await fs.promises.readFile(file)), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Speech synthesis failed" },
      { status: 500 }
    );
  }
}
