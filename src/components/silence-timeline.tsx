import { useMemo } from "react";

export type SilenceRange = { start: number; end: number };

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Read-only timeline showing kept (green) vs removed-silence (red) ranges.
 * Pure presentation; no audio/video coupling.
 */
export function SilenceTimeline({
  silences,
  totalDuration,
  removedSeconds,
  labels,
}: {
  silences: SilenceRange[];
  totalDuration: number;
  removedSeconds?: number;
  labels: { kept: string; removed: string; total: string; cuts: string };
}) {
  const { segments, ticks } = useMemo(() => {
    const dur = Math.max(0.001, totalDuration);
    const sorted = [...silences]
      .filter((s) => s.end > s.start && s.start >= 0)
      .sort((a, b) => a.start - b.start);
    const segs: { kind: "keep" | "cut"; start: number; end: number }[] = [];
    let cursor = 0;
    for (const s of sorted) {
      if (s.start > cursor) segs.push({ kind: "keep", start: cursor, end: Math.min(s.start, dur) });
      segs.push({ kind: "cut", start: Math.max(0, s.start), end: Math.min(s.end, dur) });
      cursor = Math.min(s.end, dur);
    }
    if (cursor < dur) segs.push({ kind: "keep", start: cursor, end: dur });

    const tickCount = 6;
    const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (dur * i) / tickCount);
    return { segments: segs, ticks };
  }, [silences, totalDuration]);

  const dur = Math.max(0.001, totalDuration);
  const cutCount = silences.filter((s) => s.end > s.start).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-emerald-500/70" />
            {labels.kept}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-red-500/70" />
            {labels.removed}
          </span>
        </div>
        <span className="tabular-nums">
          {cutCount} {labels.cuts} · {labels.total} {fmt(dur)}
          {typeof removedSeconds === "number" ? ` · −${fmt(removedSeconds)}` : ""}
        </span>
      </div>

      <div
        role="img"
        aria-label={`${cutCount} ${labels.cuts}`}
        className="relative h-6 w-full overflow-hidden rounded-md border border-border/60 bg-muted/30"
      >
        {segments.map((seg, i) => {
          const left = (seg.start / dur) * 100;
          const width = Math.max(0.15, ((seg.end - seg.start) / dur) * 100);
          return (
            <div
              key={i}
              title={`${seg.kind === "cut" ? labels.removed : labels.kept}: ${fmt(seg.start)} → ${fmt(seg.end)}`}
              className={
                seg.kind === "cut"
                  ? "absolute top-0 h-full bg-red-500/55"
                  : "absolute top-0 h-full bg-emerald-500/45"
              }
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
      </div>

      <div className="relative h-3 w-full">
        {ticks.map((time, i) => (
          <div
            key={i}
            className="absolute top-0 -translate-x-1/2 text-[10px] tabular-nums text-muted-foreground"
            style={{ left: `${(time / dur) * 100}%` }}
          >
            {fmt(time)}
          </div>
        ))}
      </div>
    </div>
  );
}