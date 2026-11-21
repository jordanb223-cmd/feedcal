// How likely a page of text is to hold a schedule. Cheap and explainable: counts of dates,
// weekdays, months, times and event words, per 1,000 characters, with a floor for short pages.

const MONTH = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\b/gi;
const WEEKDAY = /\b(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?|lunes|martes|miércoles|jueves|viernes|sábado|domingo|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi;
const NUMERIC_DATE = /\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g;
const TIME = /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}h\d{0,2}\b|\bnoon\b|\bmidnight\b/gi;
const EVENT_WORD = /\b(schedule|calendar|event|events|practice|game|games|match|tournament|meet|concert|recital|rehearsal|field trip|no school|holiday|break|deadline|due|conference|meeting|party|festival|fair|picture day|early (release|dismissal)|kickoff|tryouts?|registration|ceremony|graduation)\b/gi;

export interface PageScore { index: number; score: number; chars: number; hits: Record<string, number> }

export const KEEP_THRESHOLD = 3;

export function scorePage(index: number, text: string): PageScore {
  const t = text ?? "";
  const count = (re: RegExp) => (t.match(re) ?? []).length;
  const hits = { month: count(MONTH), weekday: count(WEEKDAY), date: count(NUMERIC_DATE), time: count(TIME), event: count(EVENT_WORD) };
  const raw = hits.month * 1 + hits.weekday * 1 + hits.date * 1.5 + hits.time * 2 + hits.event * 1;
  // Long pages of prose shouldn't win on volume alone: scale by density, but never below the raw
  // count of strong signals (times and dates) on a short page.
  const density = raw / Math.max(1, t.length / 1000);
  const score = Math.round(Math.min(raw, Math.max(density, (hits.time + hits.date) * 1.5)) * 10) / 10;
  return { index, score, chars: t.length, hits };
}
