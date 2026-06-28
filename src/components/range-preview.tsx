import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export type PreviewRange = { start: number; end: number; index: number };

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 10);
  return `${m}:${sec.toString().padStart(2, "0")}.${cs}`;
}

/**
 * Plays a selected timeline range from the local source File.
 * Includes an optional ±1s context so the user can hear how the cut joins.
 */
export function RangePreview({
  file,
  range,
  totalDuration,
  labels,
  onClose,
}: {
  file: File | null;
  range: PreviewRange | null;
  totalDuration: number;
  labels: {
    title: string;
    hint: string;
    play: string;
    playContext: string;
    stop: string;
    close: string;
    range: string;
    context: string;
  };
  onClose: () => void;
}) {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAtRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    // When the selected range changes, jump to its start and pause.
    const v = videoRef.current;
    if (!v || !range) return;
    try {
      v.pause();
      v.currentTime = Math.max(0, range.start);
    } catch {
      /* noop */
    }
    stopAtRef.current = null;
    setPlaying(false);
    setNow(range.start);
  }, [range?.index, range?.start, range?.end]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!range || !url || !file) return null;

  const tick = () => {
    const v = videoRef.current;
    if (!v) return;
    setNow(v.currentTime);
    if (stopAtRef.current !== null && v.currentTime >= stopAtRef.current) {
      v.pause();
      setPlaying(false);
      stopAtRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const playRange = async (withContext: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    const lead = withContext ? 1.0 : 0;
    const tail = withContext ? 1.0 : 0;
    const start = Math.max(0, range.start - lead);
    const end = Math.min(totalDuration, range.end + tail);
    try {
      v.currentTime = start;
      stopAtRef.current = end;
      await v.play();
      setPlaying(true);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setPlaying(false);
    }
  };

  const stop = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    stopAtRef.current = null;
    setPlaying(false);
  };

  const duration = Math.max(0, range.end - range.start);

  return (
    <div className="mt-4 rounded-lg border border-border/70 bg-background/60 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {labels.title}
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">{labels.hint}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {labels.close}
        </button>
      </div>

      <video
        ref={videoRef}
        src={url}
        className="w-full rounded-md bg-black"
        preload="metadata"
        playsInline
        controls={false}
        onEnded={() => setPlaying(false)}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] tabular-nums text-muted-foreground">
          <span className="text-foreground">{fmt(now)}</span>
          <span className="mx-2">·</span>
          {labels.range}: {fmt(range.start)} → {fmt(range.end)} ({fmt(duration)})
        </div>
        <div className="flex gap-2">
          {playing ? (
            <Button size="sm" variant="outline" onClick={stop}>
              {labels.stop}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => playRange(true)}>
                {labels.playContext}
              </Button>
              <Button size="sm" onClick={() => playRange(false)}>
                {labels.play}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}