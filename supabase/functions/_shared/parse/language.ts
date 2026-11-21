// A small language guess for routing and display, not translation. Returns an ISO 639-1 code
// or "und" (undetermined).
const SCRIPTS: [RegExp, string][] = [
  [/[֐-׿]/g, "he"], [/[؀-ۿ]/g, "ar"], [/[぀-ヿ]/g, "ja"], [/[가-힯]/g, "ko"],
  [/[一-鿿]/g, "zh"], [/[Ѐ-ӿ]/g, "ru"], [/[Ͱ-Ͽ]/g, "el"],
];
const WORDS: Record<string, string[]> = {
  en: ["the", "and", "for", "you", "with", "will", "please", "from", "this", "are", "our", "your", "on", "at", "is"],
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "para", "por", "con", "una", "del", "su", "es"],
  fr: ["le", "la", "les", "des", "et", "est", "pour", "dans", "une", "vous", "nous", "avec", "du", "au", "sur"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "für", "ein", "eine", "sie", "wir", "den", "zu", "am"],
  pt: ["o", "os", "as", "de", "que", "e", "para", "com", "uma", "não", "em", "do", "da", "por", "seu"],
  it: ["il", "la", "di", "che", "e", "per", "con", "una", "sono", "gli", "del", "della", "non", "ci", "alle"],
  nl: ["de", "het", "een", "en", "van", "is", "op", "voor", "met", "niet", "zijn", "wij", "u", "aan", "ook"],
};

export function detectLanguage(text: string): string {
  const sample = text.slice(0, 5000);
  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  if (letters < 20) return "und";
  for (const [re, code] of SCRIPTS) {
    if ((sample.match(re) ?? []).length / letters > 0.3) return code === "zh" && /[぀-ヿ]/.test(sample) ? "ja" : code;
  }
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best = "und";
  let bestScore = 0;
  for (const [code, list] of Object.entries(WORDS)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length / words.length;
    if (score > bestScore) { best = code; bestScore = score; }
  }
  return bestScore >= 0.05 ? best : "und";
}
