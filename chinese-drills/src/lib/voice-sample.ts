/**
 * The sentence the Settings page speaks when you try a voice.
 *
 * Shared so the page and the server-side prewarm can never drift apart: if
 * they did, the sample would be generated on demand and the button a user
 * presses right after switching voice would be the slow one.
 */
export const VOICE_SAMPLE = "你好！我是你的发音老师。";
