/** Filler tokens per language (lowercased, punctuation stripped). */
export const FILLERS: Record<string, string[]> = {
  pt: ["é", "éé", "ééé", "tipo", "né", "hum", "humm", "ahn", "ah", "uh", "uhm", "então"],
  en: ["um", "uh", "uhm", "umm", "er", "ah", "like"],
  es: ["eh", "este", "pues", "bueno"],
};

export function normalizeWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:"'¡¿…\-–—]/g, "")
    .trim();
}

export function endsWithSentence(text: string): boolean {
  return /[.?!…]\s*$/.test(text);
}

export function endsWithSoftBoundary(text: string): boolean {
  return /[,;:]\s*$/.test(text);
}

export function isFiller(text: string, lang: string | null | undefined): boolean {
  const list = new Set((FILLERS[(lang ?? "").slice(0, 2)] ?? []).map(normalizeWord));
  return list.has(normalizeWord(text));
}