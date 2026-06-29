import type { Lang } from "./i18n";
import { InvalidPlanError } from "./agent/cut-planner/validator";
import type { ValidationCode } from "./agent/cut-planner/contracts";

export type MappedError = {
  title: string;
  cause: string;
  action: string;
  raw: string;
  jobId?: string;
};

function pick(lang: Lang, pt: string, en: string): string {
  return lang === "pt" ? pt : en;
}

/**
 * Friendly, code-specific copy for `INVALID_PLAN` failures. Each entry
 * names the *probable cause* in plain language and a concrete workaround
 * the user can act on without reading the validator's source.
 */
const INVALID_PLAN_COPY: Partial<Record<ValidationCode, {
  titlePt: string; titleEn: string;
  causePt: string; causeEn: string;
  actionPt: string; actionEn: string;
}>> = {
  segment_too_short: {
    titlePt: "Trecho mantido ficou curto demais",
    titleEn: "A kept clip is too short",
    causePt:
      "Os cortes ficaram tão agressivos (silêncios longos + remoção de muletas) que sobraria um trecho com menos de 250 ms entre dois cortes — o renderizador rejeitaria isso e geraria um clique.",
    causeEn:
      "Cuts got so aggressive (long silences + filler removal) that a sliver under 250 ms would survive between two cuts — the renderer would reject it and produce a click.",
    actionPt:
      "Use um preset menos agressivo (Natural), aumente o padding em torno da fala (ex.: 150 ms) ou desative a remoção de muletas e reprocesse.",
    actionEn:
      "Switch to a less aggressive preset (Natural), bump padding around speech (e.g. 150 ms) or disable filler removal and reprocess.",
  },
  segment_overlap: {
    titlePt: "Cortes se sobrepõem",
    titleEn: "Overlapping cuts",
    causePt: "Dois segmentos mantidos colidem na timeline — o renderizador pularia frames.",
    causeEn: "Two kept segments collide on the timeline — the renderer would skip frames.",
    actionPt: "Aumente o padding mínimo entre cortes ou rode com preset menos agressivo.",
    actionEn: "Increase the minimum gap between cuts or use a less aggressive preset.",
  },
  cut_out_of_bounds: {
    titlePt: "Corte fora do vídeo",
    titleEn: "Cut out of bounds",
    causePt: "Um silêncio saiu da duração do vídeo — provavelmente a duração foi lida errada.",
    causeEn: "A silence falls outside the video duration — duration was probably read wrong.",
    actionPt: "Reenvie o arquivo (preferencialmente MP4/H.264) para a duração ser remedida.",
    actionEn: "Re-upload the file (ideally MP4/H.264) so the duration is re-probed.",
  },
  filler_in_protected_window: {
    titlePt: "Muleta na zona protegida",
    titleEn: "Filler inside protected window",
    causePt: "Uma muleta caiu no início/fim protegidos do vídeo.",
    causeEn: "A filler word landed inside the protected head/tail window.",
    actionPt: "Desative a remoção de muletas ou reduza a janela protegida e reprocesse.",
    actionEn: "Disable filler removal or shrink the protected window and reprocess.",
  },
  negative_duration: {
    titlePt: "Timestamps corrompidos",
    titleEn: "Corrupted timestamps",
    causePt: "A transcrição produziu um silêncio com duração zero ou negativa.",
    causeEn: "Transcription produced a silence with zero or negative duration.",
    actionPt: "Refaça a transcrição (reprocesse o projeto).",
    actionEn: "Re-run transcription (reprocess the project).",
  },
  snap_outside_window: {
    titlePt: "Snap fora da janela",
    titleEn: "Snap outside window",
    causePt: "O alinhamento ao zero-crossing saiu da janela de ±8 ms.",
    causeEn: "Zero-crossing snap moved beyond the ±8 ms window.",
    actionPt: "Desative o snap por zero-crossing ou reencode o áudio para 48 kHz.",
    actionEn: "Disable zero-crossing snap or re-encode the audio to 48 kHz.",
  },
  missing_explanation: {
    titlePt: "Decisão sem explicação",
    titleEn: "Decision missing explanation",
    causePt: "Decisão sem reason key (apenas debug — não bloqueia o render).",
    causeEn: "Decision without a reason key (debug only — does not block the render).",
    actionPt: "Pode ignorar; reprocesse se quiser auditar a decisão.",
    actionEn: "Safe to ignore; reprocess to audit the decision.",
  },
};

export function mapError(err: unknown, lang: Lang): MappedError {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const m = raw.toLowerCase();

  // Cut planner — structural validation failure (Sprint A).
  if (err instanceof InvalidPlanError) {
    // Dominant code → friendly cause + concrete workaround.
    const dominant = err.errorCodes[0];
    const friendly = dominant ? INVALID_PLAN_COPY[dominant] : undefined;
    if (friendly) {
      return {
        title: pick(lang, friendly.titlePt, friendly.titleEn),
        cause: pick(lang, friendly.causePt, friendly.causeEn),
        action: pick(lang, friendly.actionPt, friendly.actionEn),
        raw,
      };
    }
    return {
      title: pick(lang, "Plano de cortes inválido", "Invalid cut plan"),
      cause: pick(
        lang,
        `O validador rejeitou o plano gerado (${err.errorCodes.join(", ")}). Nada foi enviado para o renderizador.`,
        `The validator rejected the generated plan (${err.errorCodes.join(", ")}). Nothing was sent to the renderer.`,
      ),
      action: err.toActionableMessage(lang),
      raw,
    };
  }

  // Stringified INVALID_PLAN: segment_too_short (common surface in toasts).
  if (m.includes("invalid_plan") && m.includes("segment_too_short")) {
    const c = INVALID_PLAN_COPY.segment_too_short;
    return {
      title: pick(lang, c.titlePt, c.titleEn),
      cause: pick(lang, c.causePt, c.causeEn),
      action: pick(lang, c.actionPt, c.actionEn),
      raw,
    };
  }

  // Fallback: stringified INVALID_PLAN from older callers.
  if (m.startsWith("invalid_plan")) {
    return {
      title: pick(lang, "Plano de cortes inválido", "Invalid cut plan"),
      cause: pick(
        lang,
        "O validador rejeitou o plano antes da renderização.",
        "The validator rejected the plan before rendering.",
      ),
      action: pick(
        lang,
        "Reduza a agressividade do preset, aumente o padding em torno da fala e reprocessse.",
        "Lower the preset aggressiveness, increase padding around speech and reprocess.",
      ),
      raw,
    };
  }

  // Cloud / network timeouts
  if (m.includes("timeout") || m.includes("timed out") || m.includes("tempo máximo")) {
    return {
      title: pick(lang, "Tempo limite atingido", "Timed out"),
      cause: pick(
        lang,
        "A renderização em nuvem demorou mais do que o esperado — arquivos grandes ou pico de uso no Shotstack costumam estourar a janela.",
        "Cloud render took longer than expected — large files or Shotstack peak load usually blow past the window.",
      ),
      action: pick(
        lang,
        "Já caímos automaticamente para renderização local. Se preferir cloud, tente novamente em alguns minutos ou reduza a resolução de saída.",
        "We already fell back to local rendering. To stay on cloud, retry in a few minutes or lower the export resolution.",
      ),
      raw,
    };
  }

  // Codec / decode / unsupported format
  if (
    m.includes("codec") ||
    m.includes("decoder") ||
    m.includes("unsupported") ||
    m.includes("invalid data found") ||
    m.includes("moov atom not found")
  ) {
    return {
      title: pick(lang, "Falha de codec", "Codec failure"),
      cause: pick(
        lang,
        "O arquivo está corrompido ou usa um codec que o motor não consegue decodificar.",
        "The file is corrupted or uses a codec the engine cannot decode.",
      ),
      action: pick(
        lang,
        "Recodifique o vídeo para H.264 (MP4) antes de subir, ou tente outro arquivo.",
        "Re-encode the video to H.264 (MP4) before uploading, or try another file.",
      ),
      raw,
    };
  }

  // Storage / upload
  if (m.includes("storage") || m.includes("upload") || m.includes("bucket")) {
    return {
      title: pick(lang, "Falha ao subir arquivo", "Upload failed"),
      cause: pick(
        lang,
        "Sua conexão caiu ou o serviço de armazenamento recusou o upload.",
        "Your connection dropped or storage rejected the upload.",
      ),
      action: pick(
        lang,
        "Verifique a internet e tente reprocessar — a sessão é retomada de onde parou.",
        "Check your connection and retry — the session resumes where it stopped.",
      ),
      raw,
    };
  }

  // Shotstack quota / auth
  if (m.includes("shotstack") || m.includes("api key") || m.includes("unauthorized") || m.includes("401")) {
    return {
      title: pick(lang, "Renderizador indisponível", "Renderer unavailable"),
      cause: pick(
        lang,
        "O serviço de nuvem recusou a chamada — pode ser chave inválida ou cota esgotada.",
        "The cloud service rejected the call — invalid key or quota exhausted.",
      ),
      action: pick(
        lang,
        "Desative a renderização em nuvem para processar localmente ou revise a chave do serviço.",
        "Disable cloud rendering to process locally or check the service key.",
      ),
      raw,
    };
  }

  // Replicate / AI
  if (m.includes("replicate") || m.includes("prediction")) {
    return {
      title: pick(lang, "Falha na IA", "AI failure"),
      cause: pick(
        lang,
        "O provedor de IA recusou ou demorou na resposta.",
        "The AI provider rejected or timed out.",
      ),
      action: pick(
        lang,
        "Tente novamente; se persistir, prossiga sem a etapa de IA.",
        "Try again; if it persists, continue without the AI step.",
      ),
      raw,
    };
  }

  // No audible content
  if (m.includes("no audible") || m.includes("audible content")) {
    return {
      title: pick(lang, "Nenhum trecho audível", "No audible content"),
      cause: pick(
        lang,
        "O limiar de silêncio está muito alto para o áudio enviado.",
        "The silence threshold is too high for the audio you sent.",
      ),
      action: pick(
        lang,
        "Reduza o limiar (ex.: −40 dB) e processe novamente.",
        "Lower the threshold (e.g. −40 dB) and process again.",
      ),
      raw,
    };
  }

  // Assets / signed URL
  if (m.includes("sign") || m.includes("not found") || m.includes("404")) {
    return {
      title: pick(lang, "Asset inválido", "Invalid asset"),
      cause: pick(
        lang,
        "O arquivo de origem não pôde ser lido — pode ter sido movido ou expirado.",
        "The source asset could not be read — it may have moved or expired.",
      ),
      action: pick(
        lang,
        "Selecione o arquivo novamente e tente reprocessar.",
        "Pick the file again and retry.",
      ),
      raw,
    };
  }

  return {
    title: pick(lang, "Falha no processamento", "Processing failed"),
    cause: pick(
      lang,
      "Algo inesperado interrompeu o job.",
      "Something unexpected interrupted the job.",
    ),
    action: pick(
      lang,
      "Veja o log abaixo, ajuste as opções e tente novamente.",
      "Check the log below, adjust your options and try again.",
    ),
    raw,
  };
}