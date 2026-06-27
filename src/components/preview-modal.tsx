import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sourceUrl?: string;
  outputUrl?: string;
  downloadUrl?: string;
  downloadName?: string;
};

export function PreviewModal({
  open,
  onOpenChange,
  sourceUrl,
  outputUrl,
  downloadUrl,
  downloadName,
}: Props) {
  const { t } = useI18n();
  const beforeRef = useRef<HTMLVideoElement>(null);
  const afterRef = useRef<HTMLVideoElement>(null);
  const [synced, setSynced] = useState(true);
  const [mode, setMode] = useState<"split" | "ab">("split");
  const [split, setSplit] = useState(50);

  // Pause both when modal closes
  useEffect(() => {
    if (!open) {
      beforeRef.current?.pause();
      afterRef.current?.pause();
    }
  }, [open]);

  const playBoth = () => {
    beforeRef.current?.play();
    afterRef.current?.play();
  };
  const pauseBoth = () => {
    beforeRef.current?.pause();
    afterRef.current?.pause();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] border-border/80 bg-background p-0 sm:max-w-6xl">
        <DialogTitle className="sr-only">{t.preview_modal_title}</DialogTitle>
        <div className="flex items-center justify-between gap-4 border-b border-border/60 px-6 py-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              {t.preview_modal_title}
            </div>
            <div className="text-sm text-foreground">{t.compare_title}</div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <div className="hidden items-center gap-1 rounded-md border border-border/60 p-0.5 sm:flex">
              <button
                onClick={() => setMode("split")}
                className={`rounded px-2.5 py-1 ${mode === "split" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
              >
                {t.preview_mode_split}
              </button>
              <button
                onClick={() => setMode("ab")}
                className={`rounded px-2.5 py-1 ${mode === "ab" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
              >
                {t.preview_mode_ab}
              </button>
            </div>
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={synced}
                onChange={(e) => setSynced(e.target.checked)}
              />
              sync
            </label>
            <Button variant="ghost" size="sm" onClick={playBoth}>
              Play
            </Button>
            <Button variant="ghost" size="sm" onClick={pauseBoth}>
              Pause
            </Button>
            {downloadUrl && (
              <Button asChild size="sm">
                <a href={downloadUrl} download={downloadName}>
                  {t.status_download_result}
                </a>
              </Button>
            )}
          </div>
        </div>

        {mode === "split" ? (
          <div className="grid gap-4 p-6 md:grid-cols-2">
            <Panel label={t.proj_before} url={sourceUrl} ref={beforeRef}
              onPlay={() => synced && afterRef.current?.play()}
              onPause={() => synced && afterRef.current?.pause()}
              onSeek={(s) => { if (synced && afterRef.current) afterRef.current.currentTime = s; }}
            />
            <Panel label={t.proj_after} url={outputUrl} accent ref={afterRef}
              onPlay={() => synced && beforeRef.current?.play()}
              onPause={() => synced && beforeRef.current?.pause()}
              onSeek={(s) => { if (synced && beforeRef.current) beforeRef.current.currentTime = s; }}
            />
          </div>
        ) : (
          <div className="p-6">
            <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
              {sourceUrl && (
                <video
                  ref={beforeRef}
                  src={sourceUrl}
                  className="absolute inset-0 h-full w-full object-contain"
                  controls={false}
                  onPlay={() => synced && afterRef.current?.play()}
                  onPause={() => synced && afterRef.current?.pause()}
                />
              )}
              {outputUrl && (
                <video
                  ref={afterRef}
                  src={outputUrl}
                  className="absolute inset-0 h-full w-full object-contain"
                  style={{ clipPath: `inset(0 0 0 ${split}%)` }}
                  controls={false}
                  onPlay={() => synced && beforeRef.current?.play()}
                  onPause={() => synced && beforeRef.current?.pause()}
                />
              )}
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary/70"
                style={{ left: `${split}%` }}
              />
              <div className="absolute left-3 top-3 rounded bg-black/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white">
                {t.proj_before}
              </div>
              <div className="absolute right-3 top-3 rounded bg-primary/80 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary-foreground">
                {t.proj_after}
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground">A</span>
              <input
                type="range"
                min={0}
                max={100}
                value={split}
                onChange={(e) => setSplit(Number(e.target.value))}
                className="flex-1 accent-primary"
              />
              <span className="text-[11px] text-muted-foreground">B</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const Panel = ({
  label, url, accent, ref, onPlay, onPause, onSeek,
}: {
  label: string; url?: string; accent?: boolean;
  ref: React.RefObject<HTMLVideoElement | null>;
  onPlay?: () => void; onPause?: () => void; onSeek?: (t: number) => void;
}) => (
  <div className={`rounded-xl border ${accent ? "border-primary/30" : "border-border/80"} bg-card/40 p-3`}>
    <div className={`mb-2 text-[11px] uppercase tracking-wider ${accent ? "text-primary" : "text-muted-foreground"}`}>
      {label}
    </div>
    {url ? (
      <video
        ref={ref}
        src={url}
        controls
        className="aspect-video w-full rounded-md bg-black"
        onPlay={onPlay}
        onPause={onPause}
        onSeeked={(e) => onSeek?.((e.target as HTMLVideoElement).currentTime)}
      />
    ) : (
      <div className="aspect-video w-full rounded-md bg-black/40" />
    )}
  </div>
);