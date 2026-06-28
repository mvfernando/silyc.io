import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/spinner";
import { supabase } from "@/integrations/supabase/client";
import {
  startTranscription,
  pollTranscription,
  cancelTranscription,
  type TranscriptionJobStatus,
} from "@/lib/replicate.functions";
import { chunksToSilences, estimateTranscriptionCostUsd } from "@/lib/auto-cut";
import { extractAudioForTranscription } from "@/lib/ffmpeg-processor";
import { fingerprintFile } from "@/lib/file-hash";
import type { SilenceRange } from "@/components/silence-timeline";

type Labels = {
  title: string;
  subtitle: string;
  cta: string;
  ctaBusy: string;
  cancel: string;
  extract: string;
  upload: string;
  transcribe: string;
  analyzing: string;
  done: string;
  cache: string;
  cacheHit: string;
  fillers: string;
  estCost: string;
  estimate: string;
  needFile: string;
  errPrefix: string;
  ready: (n: number, dur: string) => string;
};

function fmtMinSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

type Phase = "idle" | "cache" | "extract" | "upload" | "transcribe" | "analyze" | "done";

const TRANSCRIPTION_MODEL = "openai/whisper";

export function AutoCutCard({
  file,
  totalDurationSec,
  language,
  labels,
  disabled,
  onResult,
}: {
  file: File | null;
  totalDurationSec: number;
  language?: string | null;
  labels: Labels;
  disabled?: boolean;
  onResult: (out: {
    silences: SilenceRange[];
    duration: number;
    transcript: string;
    detectedLanguage: string | null;
    fillersRemoved: number;
  }) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [removeFillers, setRemoveFillers] = useState(false);
  const [predictionId, setPredictionId] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const start = useServerFn(startTranscription);
  const poll = useServerFn(pollTranscription);
  const cancel = useServerFn(cancelTranscription);

  const busy = phase !== "idle" && phase !== "done";
  const estCost = estimateTranscriptionCostUsd(totalDurationSec);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const handleRun = async () => {
    if (!file) {
      toast.error(labels.needFile);
      return;
    }
    cancelledRef.current = false;

    // 1) Try cache by file fingerprint to avoid paying Replicate again
    setPhase("cache");
    setProgress(1);
    let fileHash: string | null = null;
    try {
      fileHash = await fingerprintFile(file);
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (uid) {
        const { data: cached } = await supabase
          .from("transcriptions")
          .select("language, text, chunks, duration_sec")
          .eq("user_id", uid)
          .eq("file_hash", fileHash)
          .eq("model", TRANSCRIPTION_MODEL)
          .maybeSingle();
        if (cached && Array.isArray(cached.chunks) && cached.chunks.length > 0) {
          const chunks = cached.chunks as Array<{ start: number; end: number; text: string }>;
          setPhase("analyze");
          setProgress(95);
          const { silences, fillersRemoved } = chunksToSilences(
            chunks,
            totalDurationSec,
            { removeFillers, language: cached.language ?? language ?? null },
          );
          setProgress(100);
          setPhase("done");
          onResult({
            silences,
            duration: totalDurationSec,
            transcript: cached.text ?? "",
            detectedLanguage: cached.language ?? null,
            fillersRemoved,
          });
          toast.success(labels.cacheHit);
          return;
        }
      }
    } catch {
      // Cache lookup is best-effort; on any failure continue with a fresh run.
      fileHash = fileHash ?? null;
    }

    setPhase("extract");
    setProgress(2);
    let audioBlob: Blob;
    try {
      audioBlob = await extractAudioForTranscription(file, (p) => {
        setProgress(Math.max(2, Math.min(25, Math.round(p * 0.25))));
      });
      if (cancelledRef.current) throw new Error("cancelled");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${labels.errPrefix}: ${msg}`);
      setPhase("idle");
      setProgress(0);
      return;
    }
    setPhase("upload");
    setProgress(28);
    let signedUrl: string;
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id ?? "anon";
      const path = `${uid}/auto/${crypto.randomUUID()}.mp3`;
      const { error: upErr } = await supabase.storage
        .from("videos")
        .upload(path, audioBlob, { upsert: false, contentType: "audio/mpeg" });
      if (upErr) throw upErr;
      setProgress(30);

      const { data: signed, error: signErr } = await supabase.storage
        .from("videos")
        .createSignedUrl(path, 60 * 60);
      if (signErr || !signed?.signedUrl) throw signErr ?? new Error("sign failed");
      signedUrl = signed.signedUrl;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${labels.errPrefix}: ${msg}`);
      setPhase("idle");
      setProgress(0);
      return;
    }

    setPhase("transcribe");
    setProgress(40);
    let job: TranscriptionJobStatus;
    try {
      job = await start({ data: { audioUrl: signedUrl, language: language ?? null } });
      setPredictionId(job.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${labels.errPrefix}: ${msg}`);
      setPhase("idle");
      setProgress(0);
      return;
    }

    // Poll
    const started = Date.now();
    const timeoutMs = 15 * 60 * 1000;
    let delay = 2500;
    try {
      while (job.status !== "succeeded" && job.status !== "failed" && job.status !== "canceled") {
        if (cancelledRef.current) throw new Error("cancelled");
        if (Date.now() - started > timeoutMs) throw new Error("transcription timeout");
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 1500, 8000);
        job = await poll({ data: { id: job.id } });
        // Crude progress: animate 40 → 80 while transcribing
        setProgress((p) => Math.min(80, p + 2));
      }
      if (job.status !== "succeeded" || !job.chunks) {
        throw new Error(job.error || `transcription ${job.status}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${labels.errPrefix}: ${msg}`);
      setPhase("idle");
      setProgress(0);
      setPredictionId(null);
      return;
    }

    setPhase("analyze");
    setProgress(90);
    const { silences, fillersRemoved } = chunksToSilences(job.chunks, totalDurationSec, {
      removeFillers,
      language: job.language ?? language ?? null,
    });
    setProgress(100);
    setPhase("done");
    setPredictionId(null);

    // Persist to cache (best-effort; ignore RLS / unique-violation errors)
    if (fileHash) {
      try {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (uid) {
          await supabase.from("transcriptions").upsert(
            {
              user_id: uid,
              file_hash: fileHash,
              model: TRANSCRIPTION_MODEL,
              language: job.language,
              duration_sec: totalDurationSec,
              text: job.text,
              chunks: job.chunks,
              prediction_id: job.id,
            },
            { onConflict: "user_id,file_hash,model" },
          );
        }
      } catch {
        /* ignore */
      }
    }

    onResult({
      silences,
      duration: totalDurationSec,
      transcript: job.text ?? "",
      detectedLanguage: job.language,
      fillersRemoved,
    });
    toast.success(labels.ready(silences.length, fmtMinSec(totalDurationSec)));
  };

  const handleCancel = async () => {
    cancelledRef.current = true;
    if (predictionId) {
      try {
        await cancel({ data: { id: predictionId } });
      } catch {
        /* noop */
      }
    }
    setPhase("idle");
    setProgress(0);
    setPredictionId(null);
  };

  const phaseLabel =
    phase === "cache"
      ? labels.cache
      : phase === "extract"
      ? labels.extract
      : phase === "upload"
        ? labels.upload
        : phase === "transcribe"
        ? labels.transcribe
        : phase === "analyze"
          ? labels.analyzing
          : phase === "done"
            ? labels.done
            : "";

  return (
    <section className="mt-6 rounded-xl border border-border bg-gradient-to-br from-primary/5 to-transparent p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="text-base font-semibold">{labels.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{labels.subtitle}</p>
          <label className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={removeFillers}
              disabled={busy}
              onChange={(e) => setRemoveFillers(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {labels.fillers}
          </label>
          {totalDurationSec > 0 && (
            <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
              {labels.estimate}: {fmtMinSec(totalDurationSec)} · {labels.estCost} ~$
              {estCost.toFixed(3)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {busy ? (
            <Button variant="outline" onClick={handleCancel}>
              {labels.cancel}
            </Button>
          ) : null}
          <Button onClick={handleRun} disabled={busy || disabled || !file} aria-busy={busy}>
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Spinner /> {labels.ctaBusy}
              </span>
            ) : (
              labels.cta
            )}
          </Button>
        </div>
      </div>
      {(busy || phase === "done") && (
        <div className="mt-4 space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{phaseLabel}</span>
            <span className="tabular-nums text-foreground">{progress}%</span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>
      )}
    </section>
  );
}