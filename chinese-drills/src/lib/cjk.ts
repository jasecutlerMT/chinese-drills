// Client-safe Chinese-text helpers (no heavy dependencies — this module is
// imported by browser bundles as well as server code).

export const CJK_CHAR_RE = /[㐀-鿿]/u;

/** Heuristic language detection: is this text predominantly Chinese? */
export function isMostlyChinese(text: string): boolean {
  const cjkCount = (text.match(/[㐀-鿿]/gu) ?? []).length;
  return cjkCount > text.length * 0.15;
}
