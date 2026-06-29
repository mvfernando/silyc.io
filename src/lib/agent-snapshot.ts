/**
 * Local snapshot of an in-flight agent run.
 *
 * We can't truly resume a browser-side FFmpeg run, but we can remember
 * that one was interrupted and tell the user honestly what happened
 * instead of silently dropping them back on an empty upload screen.
 */

export type AgentSnapshot = {
  fileName: string;
  fileSize: number;
  stage: "working";
  currentTask: string | null;
  progress: number; // 0..1
  startedAt: number;
  updatedAt: number;
};

const KEY = "silyc.agent.lastRun";

export function writeSnapshot(s: AgentSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode */
  }
}

export function readSnapshot(): AgentSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentSnapshot;
    if (!parsed || typeof parsed.fileName !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSnapshot() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function isRecent(s: AgentSnapshot, withinMs = 60 * 60 * 1000): boolean {
  return Date.now() - s.updatedAt < withinMs;
}