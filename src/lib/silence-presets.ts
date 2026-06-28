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