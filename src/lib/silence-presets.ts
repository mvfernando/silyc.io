export type SilencePreset = {
  id: "interview" | "podcast" | "lowvoice" | "aggressive" | "screencast";
  threshold: number;
  minPause: number;
  padding: number;
};

export const SILENCE_PRESETS: SilencePreset[] = [
  { id: "interview", threshold: -35, minPause: 0.6, padding: 0.3 },
  { id: "podcast", threshold: -38, minPause: 0.8, padding: 0.35 },
  { id: "lowvoice", threshold: -45, minPause: 0.7, padding: 0.35 },
  { id: "aggressive", threshold: -30, minPause: 0.35, padding: 0.15 },
  { id: "screencast", threshold: -36, minPause: 0.9, padding: 0.4 },
];

export function matchPreset(
  threshold: number,
  minPause: number,
  padding: number,
): SilencePreset["id"] | "custom" {
  const eq = (a: number, b: number, tol: number) => Math.abs(a - b) < tol;
  for (const p of SILENCE_PRESETS) {
    if (eq(p.threshold, threshold, 0.5) && eq(p.minPause, minPause, 0.03) && eq(p.padding, padding, 0.03)) {
      return p.id;
    }
  }
  return "custom";
}

/* ------------------------------------------------------------------ */
/* User-defined presets — full pipeline config (persisted in browser) */
/* ------------------------------------------------------------------ */

export type CustomPreset = {
  id: string;
  name: string;
  savedAt: number;
  threshold: number;
  minPause: number;
  padding: number;
  removeSilence: boolean;
  enhanceAudio: boolean;
  colorGrade: boolean;
  cloud: boolean;
  exportOpts?: Record<string, unknown>;
};

const STORAGE_KEY = "silyc.custom-presets.v1";

function read(): CustomPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomPreset[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(list: CustomPreset[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota errors */
  }
}

export function listCustomPresets(): CustomPreset[] {
  return read().sort((a, b) => b.savedAt - a.savedAt);
}

export function saveCustomPreset(p: Omit<CustomPreset, "id" | "savedAt">): CustomPreset {
  const list = read();
  // Replace by name (case-insensitive) to avoid dupes
  const filtered = list.filter((x) => x.name.trim().toLowerCase() !== p.name.trim().toLowerCase());
  const next: CustomPreset = {
    ...p,
    id: `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    savedAt: Date.now(),
  };
  filtered.push(next);
  write(filtered);
  return next;
}

export function deleteCustomPreset(id: string) {
  write(read().filter((p) => p.id !== id));
}