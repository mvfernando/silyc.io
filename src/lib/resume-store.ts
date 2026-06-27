import type { SilenceRange, ExportOptions } from "./ffmpeg-processor";

export type ResumeState = {
  projectId: string;
  projectName: string;
  fingerprint: string; // name|size|lastModified
  fileName: string;
  fileSize: number;
  settings: {
    threshold: number;
    minPause: number;
    removeSilence: boolean;
  };
  exportOpts: ExportOptions;
  silences?: SilenceRange[];
  totalDuration?: number;
  lastPhase: string;
  cloud: boolean;
  savedAt: number;
};

const KEY = "silentcut.resume";

export function fingerprintFile(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

export function listResume(): ResumeState[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ResumeState[]) : [];
  } catch {
    return [];
  }
}

export function saveResume(s: ResumeState) {
  const items = listResume().filter((x) => x.projectId !== s.projectId);
  items.unshift(s);
  while (items.length > 8) items.pop();
  window.localStorage.setItem(KEY, JSON.stringify(items));
}

export function getResume(projectId: string): ResumeState | undefined {
  return listResume().find((r) => r.projectId === projectId);
}

export function clearResume(projectId: string) {
  const items = listResume().filter((r) => r.projectId !== projectId);
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(items));
}