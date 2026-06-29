---
name: Silyc Editing Engine v1 — Domain Contracts
description: Contratos canônicos (MediaFacts, EditingIntent, Decision com explanations[], CutPlan versionado, RenderPlan, ValidationReport) que orientam toda a Editing Engine v1. Fonte única para implementação dos sprints A→F.
type: feature
---

# Silyc Editing Engine v1 — Domain Contracts

Este documento define os contratos de domínio que toda a Engine v1 deve respeitar.
Vale como **fonte única** — qualquer divergência em `src/lib/agent/cut-planner/*`
deve ser ajustada para casar com o que está aqui antes de novas features entrarem.

Convenções:
- Tempos em **segundos** (`number`, float). Durações terminam em `Sec`.
- IDs textuais estáveis (`snake_case`) — viram chaves i18n e tags de log.
- Nenhum contrato carrega blobs/arquivos — só metadados + URLs.
- Toda estrutura serializável (JSON puro) para caber em DB, snapshot e recibo.

---

## 1. MediaFacts

Fatos probados sobre o arquivo de entrada. Produzido por `validateUpload` +
FFprobe; consumido por `planCuts`, `RenderPlanner` e `Validator`.

```ts
type MediaFacts = {
  source: {
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
    fingerprint: string;            // sha-256 do arquivo (cache key)
  };
  container: {
    format: string;                 // "mp4", "mov", "webm"…
    durationSec: number;
    bitrateBps: number | null;
  };
  video: {
    codec: string;                  // "h264", "hevc", "vp9"…
    width: number;
    height: number;
    fps: number;
    /** Lido do bitstream quando possível; null = desconhecido (assume 2s). */
    keyframeIntervalSec: number | null;
    colorSpace?: string;
  } | null;
  audio: {
    codec: string;                  // "aac", "opus"…
    sampleRateHz: number;
    channels: number;
    /** Diarização opcional; null quando não rodou. */
    speakerCount: number | null;
  } | null;
  language: string | null;          // BCP-47 short ("pt", "en", "es")
};
```

Regras:
- `keyframeIntervalSec` deve ser real quando o probe rodar; o planner só pode
  assumir 2s se este campo for `null` e DEVE marcar isso no log.
- `speakerCount` só preenche quando WhisperX/pyannote rodou.

---

## 2. EditingIntent

O **input do usuário** sem expor parâmetros crus. O DecisionEngine traduz
`style` em overrides de score/padding via presets (Sprint D).

```ts
type EditingIntent = {
  style: "natural" | "dynamic" | "cinematic";
  /** Cap de cortes; 0..1 (1 = corta tudo que puder). Default depende do style. */
  aggressiveness?: number;
  /** Remover fillers do idioma detectado. Default true para dynamic. */
  removeFillers?: boolean;
  /** Preservar pausas dramáticas (>1.2s após .!?). Default true para cinematic. */
  preserveDramaticPauses?: boolean;
  /** Janela protegida no head/tail em segundos. Default depende do style. */
  protectedHeadSec?: number;
  protectedTailSec?: number;
};
```

Presets default (Sprint D):

| style       | aggressiveness | removeFillers | preserveDramatic | head/tail |
|-------------|----------------|---------------|------------------|-----------|
| natural     | 0.45           | false         | true             | 0.50 / 0.50 |
| dynamic     | 0.75           | true          | false            | 0.25 / 0.25 |
| cinematic   | 0.35           | false         | true             | 0.75 / 0.75 |

---

## 3. Decision (com `explanations[]`)

Cada candidato a corte carrega o **porquê** estruturado. Substitui o atual
`CutCandidate.score` opaco por uma soma auditável de fatores.

```ts
type DecisionFactor =
  | "silence_duration"
  | "filler_word"
  | "low_energy"
  | "sentence_boundary"
  | "soft_boundary"
  | "dramatic_pause"
  | "speaking_rate"
  | "rel_position"
  | "speaker_change"
  | "intent_preset";

type DecisionExplanation = {
  factor: DecisionFactor;
  /** Peso configurado pelo ruleset (0..1, pode ser negativo). */
  weight: number;
  /** Contribuição final (weight * sinal observado). Soma → score. */
  contribution: number;
  /** Texto curto, i18n-ready ("gap 2.4s sem boundary"). */
  detail: string;
};

type Decision = {
  kind: "gap" | "filler" | "head" | "tail";
  action: "keep" | "shorten" | "remove";
  score: number;                          // clamp 0..1, soma das contribuições
  explanations: DecisionExplanation[];    // ≥1 quando action !== "keep"
  source: { start: number; end: number };
  cut: { start: number; end: number; snapped: boolean } | null;
};
```

---

## 4. CutPlan (versionado)

```ts
type CutPlanVersion = {
  schema: number;             // atual: 1 — bump = breaking change
  ruleset: string;            // ex: "cuts.v1.0.0" — bump = mudou heurística
  intentHash: string;         // hash do EditingIntent efetivo
};

type CutPlan = {
  version: CutPlanVersion;
  intent: EditingIntent;
  facts: MediaFacts;
  decisions: Decision[];
  segments: Array<{ index: number; keepStart: number; keepEnd: number }>;
  totals: {
    durationSec: number;
    removedSec: number;
    fillersRemoved: number;
    keptSegments: number;
  };
  log: Array<{ level: "info" | "debug"; tag: string; message: string }>;
};
```

Regras de versionamento:
- `schema` bump → migração no `agent-snapshot` e em `project_versions`.
- `ruleset` bump → manter pesos antigos disponíveis para replay; nunca
  re-pontuar planos antigos implicitamente.
- `RenderPlan` é derivado — nunca persistido, sempre regerado.

---

## 5. ValidationReport

```ts
type ValidationIssue = {
  code:
    | "segment_overlap"
    | "segment_too_short"
    | "cut_out_of_bounds"
    | "filler_in_protected_window"
    | "negative_duration"
    | "snap_outside_window"
    | "missing_explanation";
  severity: "error" | "warning";
  message: string;
  ref?: { kind: "decision" | "segment"; index: number };
};

type ValidationReport = {
  ok: boolean;                            // false ⇒ qualquer "error" presente
  issues: ValidationIssue[];
  sanitized?: CutPlan;                    // só quando issues são apenas warnings
};
```

Constantes default: `minClipMs = 250`, `snapWindowMs = 8`, `minGapMs = 80`.

---

## 6. RenderPlan (desacoplado)

```ts
type RenderTarget = "shotstack" | "ffmpeg-local";

type RenderPlan = {
  target: RenderTarget;
  ops: Array<
    | { op: "trim"; sourceStart: number; sourceEnd: number; encoding: "stream-copy" | "re-encode" }
    | { op: "concat"; segmentIndices: number[] }
    | { op: "audio-fade"; at: number; durationSec: number; direction: "in" | "out" }
    | { op: "overlay-audio"; url: string; mixDb?: number }
  >;
  hints: Partial<{
    forceKeyFrames: number[];        // ffmpeg-local
    shotstackOutputFormat: string;   // shotstack
  }>;
};
```

---

# Plano de Sprints (A → F)

Cada sprint entrega um conjunto coeso, testável e mergeable sozinho.
Critério "done" = código + tests verdes + log/recibo refletindo a mudança.

## Sprint A — Contracts & Validator (1 semana)

Objetivo: alinhar domínio ao spec e travar com Validator.

- A1. Criar `src/lib/agent/cut-planner/contracts.ts` com `MediaFacts`,
  `EditingIntent`, `Decision`, `DecisionExplanation`, `CutPlan` (com `version`),
  `RenderPlan`, `ValidationReport`. Re-exportar de `types.ts` (compat temporária).
- A2. Stampar `version: { schema: 1, ruleset: "cuts.v1.0.0", intentHash }` em
  todo plano de `planCuts`.
- A3. Implementar `validatePlan(plan, facts)` em `cut-planner/validator.ts`
  cobrindo todos os `code` listados.
- A4. `cut.task.ts`: se `report.ok === false` → falhar task com
  `error.code = "INVALID_PLAN"` e logar `issues[]` no `JobLogsPanel`.
- A5. Testes (8 fixtures): overlap, short clip, OOB, filler em head, snap
  fora da janela, missing explanation, plano válido, sanitized warnings.

## Sprint B — Explanations & MediaFacts (1 semana)

Objetivo: receipt transparente + facts reais (acabar com "assume 2s").

- B1. Refatorar `score.ts` para emitir `DecisionExplanation[]` por candidato.
- B2. Atualizar `CutPlan.decisions` com `explanations` + invariante
  "no-keep ⇒ explanations≥1" (checado pelo Validator).
- B3. Expandir `validateUpload` + criar `probeMediaFacts.server.ts`
  (`createServerFn` + `requireSupabaseAuth`) retornando `MediaFacts` real.
- B4. Cachear `MediaFacts` por `fingerprint` em tabela `media_facts` (jsonb).
- B5. Receipt UI: seção "Por quê" com top-3 explanations agregadas
  ("removeu 18 fillers", "encurtou 7 pausas longas"…) — chips apenas.
- B6. Testes: snapshot do receipt (3 transcripts sintéticos); probe contra
  MP4 com GOP=4s garante `keyframeIntervalSec === 4`.

## Sprint C — RenderPlan desacoplado (3–4 dias)

Objetivo: matar acoplamento direto `CutPlan → Shotstack/FFmpeg`.

- C1. `cut-planner/render-plan.ts` com `toRenderPlan(plan, target)`.
- C2. Adapters `renderers/shotstack-adapter.ts` (payload Shotstack) e
  `renderers/ffmpeg-adapter.ts` (`filter_complex` + `-force_key_frames`).
- C3. Refatorar `render.task.ts` para consumir `RenderPlan`.
- C4. Testes: mock Shotstack (golden payload) + dry-run FFmpeg (assert argv)
  cobrindo `stream-copy`, `re-encode` e mix com `enhancedAudioUrl`.

## Sprint D — Intent presets (2–3 dias)

Objetivo: UI passa a expor `style` em vez de sliders crus.

- D1. `cut-planner/intent-presets.ts` mapeia `style → overrides`.
- D2. DecisionEngine consome preset e aplica overrides ANTES do score;
  registra `factor: "intent_preset"` em explanations impactadas.
- D3. UI: trocar refinement antigo por 3 cards (`natural | dynamic | cinematic`).
- D4. Testes: mesmo input + 3 styles → 3 planos distintos com `intentHash` ≠.

## Sprint E — Speaker-aware + keyframe probe real (1 semana)

- E1. Ativar diarização opcional do WhisperX (flag `VITE_DIARIZATION_V1`).
- E2. Score: adicionar `factor: "speaker_change"` protegendo gaps entre
  speakers diferentes quando `gap < 600ms`.
- E3. Substituir `keyframeIntervalSec` assumido pelo lido em `MediaFacts.video`.
- E4. Encoding strategy: recalcular distância real (não múltiplo de 2)
  quando keyframe real existe.
- E5. Testes: fixture multi-speaker (proteção); MP4 GOP=1s vs GOP=4s →
  splits distintos de `stream-copy`.

## Sprint F — Hardening (1 semana)

- F1. Fuzz tests com 100 transcripts sintéticos — assert: 0 overlaps,
  0 OOB, 0 missing explanations.
- F2. Golden files: 5 vídeos reais (podcast clean, talking-head ruidoso,
  entrevista 2-speakers, PT com fillers densos, pausas dramáticas) —
  snapshot do `CutPlan` versionado no repo.
- F3. Benchmark CI: `planCuts` p95 < 200 ms para 1800 chunks.
- F4. Telemetria: `pipeline_feedback` carrega `version.ruleset`,
  `decisions.length`, `removedSec`, top-3 factors agregados.

---

## Critérios de aceite v1 (gates de release)

- Todo plano carrega `version` completo e passa `validatePlan` zero-errors.
- Receipt mostra `explanations[]` para 100% das ações `shorten`/`remove`.
- `RenderPlan` é a única superfície que Shotstack/FFmpeg adapters consomem.
- 3 styles produzem `intentHash` distintos e planos auditavelmente diferentes.
- `keyframeIntervalSec` real é usado quando o probe retorna ≠ null.
- Fuzz + golden suite verdes; p95 do planner < 200 ms em CI.

## Fora de escopo desta v1

- LLM classifier para "dramatic pause" em casos ambíguos.
- Reframe / auto-zoom / b-roll inserts.
- Color grading automático.
- Background jobs server-side (vive em `mem://roadmap/background-jobs.md`).
