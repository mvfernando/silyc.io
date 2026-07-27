import { useMemo } from "react";

export type SilenceRange = { start: number; end: number; rmsDb?: number };

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
  keepOverrides,
  onToggle,
  onPreview,
  previewIndex,
}: {
  silences: SilenceRange[];
  totalDuration: number;
  removedSeconds?: number;
  labels: { kept: string; removed: string; total: string; cuts: string; manualKept?: string; preview?: string };
  keepOverrides?: Set<number>;
  onToggle?: (index: number) => void;
  onPreview?: (range: { start: number; end: number; index: number }) => void;
  previewIndex?: number | null;
}) {
  const { segments, ticks } = useMemo(() => {
    const dur = Math.max(0.001, totalDuration);
    const indexed = silences
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.end > s.start && s.start >= 0)
      .sort((a, b) => a.s.start - b.s.start);
    const segs: { kind: "keep" | "cut" | "manual-keep"; start: number; end: number; index?: number }[] = [];
    let cursor = 0;
    for (const { s, i } of indexed) {
      if (s.start > cursor) segs.push({ kind: "keep", start: cursor, end: Math.min(s.start, dur) });
      const overridden = keepOverrides?.has(i) ?? false;
      segs.push({
        kind: overridden ? "manual-keep" : "cut",
        start: Math.max(0, s.start),
        end: Math.min(s.end, dur),
        index: i,
      });
      cursor = Math.min(s.end, dur);
    }
    if (cursor < dur) segs.push({ kind: "keep", start: cursor, end: dur });

    const tickCount = 6;
    const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (dur * i) / tickCount);
    return { segments: segs, ticks };
  }, [silences, totalDuration, keepOverrides]);

  const dur = Math.max(0.001, totalDuration);
  const cutCount = silences.filter((s, i) => s.end > s.start && !(keepOverrides?.has(i))).length;

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
          {labels.manualKept && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-amber-400/80" />
              {labels.manualKept}
            </span>
          )}
        </div>
        <span className="tabular-nums">
          {cutCount} {labels.cuts} · {labels.total} {fmt(dur)}
          {typeof removedSeconds === "number" ? ` · −${fmt(removedSeconds)}` : ""}
        </span>
      </div>

      <div
        role="img"
        aria-label={`${cutCount} ${labels.cuts}`}
        className="relative h-7 w-full overflow-hidden rounded-md border border-border/60 bg-muted/30"
      >
        {segments.map((seg, i) => {
          const left = (seg.start / dur) * 100;
          const width = Math.max(0.15, ((seg.end - seg.start) / dur) * 100);
          const isInteractive = !!onToggle && (seg.kind === "cut" || seg.kind === "manual-keep") && seg.index !== undefined;
          const isSelected = onPreview && seg.index !== undefined && seg.index === previewIndex;
          const baseClass =
            seg.kind === "cut"
              ? "bg-red-500/55 hover:bg-red-500/75"
              : seg.kind === "manual-keep"
                ? "bg-amber-400/70 hover:bg-amber-400/90"
                : "bg-emerald-500/45";
          const label =
            seg.kind === "cut"
              ? labels.removed
              : seg.kind === "manual-keep"
                ? (labels.manualKept ?? labels.kept)
                : labels.kept;
          const title = `${label}: ${fmt(seg.start)} → ${fmt(seg.end)}`;
          const rangeIndex = seg.index;
          const rms =
            rangeIndex !== undefined && silences[rangeIndex]?.rmsDb !== undefined
              ? silences[rangeIndex].rmsDb
              : undefined;
          const dur = Math.max(0, seg.end - seg.start);
          const fullTitle =
            seg.kind === "cut" && rms !== undefined
              ? `${title} · ${rms.toFixed(0)} dBFS · ${Math.round(dur * 1000)} ms`
              : title;
          const previewBtn = onPreview && seg.index !== undefined && labels.preview ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPreview({ start: seg.start, end: seg.end, index: seg.index! });
              }}
              title={labels.preview}
              className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-background/85 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
            >
              {labels.preview}
            </button>
          ) : null;
          const selectionRing = isSelected ? "ring-2 ring-foreground/70 ring-inset" : "";
          if (isInteractive) {
            return (
              <div
                key={i}
                className={`group absolute top-0 h-full ${selectionRing}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                <button
                  type="button"
                  title={fullTitle}
                  aria-label={fullTitle}
                  onClick={() => onToggle!(seg.index!)}
                  className={`h-full w-full cursor-pointer border-l border-r border-background/40 transition-colors ${baseClass}`}
                />
                {previewBtn}
              </div>
            );
          }
          return (
            <div
              key={i}
              title={fullTitle}
              className={`group absolute top-0 h-full ${baseClass} ${selectionRing}`}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              {previewBtn}
            </div>
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