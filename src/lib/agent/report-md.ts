/**
 * Markdown report generator — produces a human-readable audit of the run
 * (silences removed, duration reduced, per-segment metrics, decisions).
 *
 * Consumed by the ReadyStage "Baixar relatório" button. Kept UI-agnostic
 * so it can also be reused by a future CLI or export-all flow.
 */

import { formatDuration } from "@/lib/ffmpeg-processor";
import type { TaskResults, ValueReceipt, AnalysisFacts } from "./types";

type BuildReportInput = {
  facts: AnalysisFacts;
  receipt: ValueReceipt;
  results: TaskResults | null;
  style?: string | null;
  thresholdDb?: number | null;
};

const fmtSec = (s: number) => `${s.toFixed(2)}s`;

export function buildMarkdownReport(input: BuildReportInput): string {
  const { facts, receipt, results, style, thresholdDb } = input;
  const cut = results?.cut;
  const render = results?.render;
  const audio = results?.audio;
  const originalDur = cut?.durationSec ?? facts.durationSec ?? 0;
  const finalDur = Math.max(0, originalDur - (cut?.removedSec ?? receipt.removedSec ?? 0));
  const reductionPct = originalDur > 0 ? (receipt.removedSec / originalDur) * 100 : 0;

  const lines: string[] = [];
  lines.push(`# Silyc — Relatório de corte`);
  lines.push("");
  lines.push(`_Gerado em ${new Date().toISOString()}_`);
  lines.push("");
  lines.push(`## Arquivo`);
  lines.push(`- **Nome:** ${facts.fileName}`);
  lines.push(`- **Tamanho:** ${(facts.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`);
  if (facts.width && facts.height) {
    lines.push(`- **Resolução:** ${facts.width}×${facts.height} (${facts.aspectRatio ?? "?"} · ${facts.orientation ?? "?"})`);
  }
  lines.push(`- **Duração original:** ${formatDuration(originalDur)}`);
  lines.push("");

  lines.push(`## Configuração`);
  if (style) lines.push(`- **Estilo:** ${style}`);
  if (thresholdDb != null) lines.push(`- **Sensibilidade:** ${thresholdDb} dBFS`);
  if (render?.mode) lines.push(`- **Renderização:** ${render.mode}`);
  if (audio?.profileUsed) lines.push(`- **Perfil de áudio:** ${audio.profileUsed}`);
  lines.push("");

  lines.push(`## Resultado`);
  lines.push(`- **Silêncios removidos:** ${receipt.silencesRemoved}`);
  lines.push(`- **Fillers removidos:** ${receipt.fillersRemoved}`);
  lines.push(`- **Tempo cortado:** ${formatDuration(receipt.removedSec)} (${reductionPct.toFixed(1)}%)`);
  lines.push(`- **Duração final:** ${formatDuration(finalDur)}`);
  lines.push(`- **Edição manual equivalente poupada:** ~${receipt.manualEditingMinutesSaved} min`);
  lines.push("");

  if (audio && (audio.snrBeforeDb != null || audio.lufsAfterDb != null)) {
    lines.push(`## Áudio`);
    if (audio.snrBeforeDb != null) lines.push(`- **SNR antes:** ${audio.snrBeforeDb.toFixed(1)} dB`);
    if (audio.snrAfterDb != null) lines.push(`- **SNR depois:** ${audio.snrAfterDb.toFixed(1)} dB`);
    if (audio.lufsBeforeDb != null) lines.push(`- **LUFS antes:** ${audio.lufsBeforeDb.toFixed(1)}`);
    if (audio.lufsAfterDb != null) lines.push(`- **LUFS depois:** ${audio.lufsAfterDb.toFixed(1)}`);
    if (audio.noiseFloorBeforeDb != null) lines.push(`- **Piso de ruído:** ${audio.noiseFloorBeforeDb.toFixed(1)} dB`);
    if (audio.fallbacks?.length) lines.push(`- **Fallbacks:** ${audio.fallbacks.join(" → ")}`);
    lines.push("");
  }

  if (receipt.topExplanations.length > 0) {
    lines.push(`## Por que o agente cortou`);
    for (const e of receipt.topExplanations) {
      lines.push(`- **${e.factor}** — ${e.count}× · ${e.sampleDetail}`);
    }
    lines.push("");
  }

  if (cut?.silences?.length) {
    lines.push(`## Segmentos removidos (${cut.silences.length})`);
    lines.push("");
    lines.push(`| # | Início | Fim | Duração | dBFS |`);
    lines.push(`|---|--------|-----|---------|------|`);
    const rows = cut.silences.slice(0, 200);
    rows.forEach((s, i) => {
      const dur = s.end - s.start;
      const db = (s as unknown as { rmsDb?: number }).rmsDb;
      lines.push(
        `| ${i + 1} | ${fmtSec(s.start)} | ${fmtSec(s.end)} | ${fmtSec(dur)} | ${db != null ? db.toFixed(1) : "—"} |`,
      );
    });
    if (cut.silences.length > rows.length) {
      lines.push(`| … | | | | *(+${cut.silences.length - rows.length} adicionais omitidos)* |`);
    }
    lines.push("");
  }

  if (cut?.plan?.segments?.length) {
    lines.push(`## Segmentos mantidos (${cut.plan.segments.length})`);
    lines.push("");
    lines.push(`| # | Início | Fim | Duração | Encoding |`);
    lines.push(`|---|--------|-----|---------|----------|`);
    cut.plan.segments.slice(0, 200).forEach((seg, i) => {
      const dur = seg.end - seg.start;
      lines.push(
        `| ${i + 1} | ${fmtSec(seg.start)} | ${fmtSec(seg.end)} | ${fmtSec(dur)} | ${seg.encoding ?? "—"} |`,
      );
    });
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`_Silyc · pós-produção automatizada. Compartilhe este relatório para justificar as decisões do corte._`);
  return lines.join("\n");
}

export function downloadMarkdownReport(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}