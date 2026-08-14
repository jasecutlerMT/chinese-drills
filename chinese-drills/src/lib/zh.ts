import * as OpenCC from "opencc-js";

// Traditional → Simplified normalizer, applied to every model-produced
// Chinese string at the server boundary so the app never shows traditional
// characters even if the model slips.
let converter: ((text: string) => string) | null = null;

export function toSimplified(text: string): string {
  if (!text) return text;
  if (!converter) {
    converter = OpenCC.Converter({ from: "t", to: "cn" });
  }
  try {
    return converter(text);
  } catch {
    return text;
  }
}

// The reverse, for speech only. Microsoft's Cantonese voices are trained on
// Hong Kong traditional text and stumble over simplified input, so Cantonese
// is converted on its way to the synthesiser. Nothing on screen goes through
// here — the learner reads simplified everywhere, by his own choice.
let hkConverter: ((text: string) => string) | null = null;

export function toTraditionalHK(text: string): string {
  if (!text) return text;
  if (!hkConverter) {
    hkConverter = OpenCC.Converter({ from: "cn", to: "hk" });
  }
  try {
    return hkConverter(text);
  } catch {
    return text;
  }
}
