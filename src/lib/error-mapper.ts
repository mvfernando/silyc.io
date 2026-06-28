import type { Lang } from "./i18n";

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

export function mapError(err: unknown, lang: Lang): MappedError {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const m = raw.toLowerCase();

  // Cloud / network timeouts
  if (m.includes("timeout") || m.includes("timed out") || m.includes("tempo máximo")) {
    return {
      title: pick(lang, "Tempo limite atingido", "Timed out"),
      cause: pick(
        lang,
        "A renderização em nuvem demorou mais do que o esperado — o serviço pode estar sobrecarregado.",
        "Cloud render took longer than expected — the service may be overloaded.",
      ),
      action: pick(
        lang,
        "Tente novamente em alguns minutos ou desative a nuvem para processar localmente.",
        "Try again in a few minutes or turn off cloud rendering to process locally.",
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