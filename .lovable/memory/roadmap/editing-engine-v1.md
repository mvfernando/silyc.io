---
name: Silyc Editing Engine v1 — roadmap
description: Fonte única do que falta para entregar a Editing Engine v1 (spec técnico) e a sequência sugerida de sprints. Estado atual ≈55%.
type: feature
---

# Silyc Editing Engine v1 — Roadmap

Status: ~55% do spec implementado. Pipeline determinístico (`planCuts`) com
score → classify → snap → segment → log já roda atrás de `VITE_CUT_PLANNER_V1`
(default ON), com 13 testes verdes (`src/lib/agent/cut-planner/__tests__`).

## O que já temos
- `planCuts` orquestra 7 passos: detect → features → score → classify → snap → segment → log.
- 3-way decision (`keep | shorten | remove`) com regras hard + score ponderado.
- Snap a zero-crossing ±8 ms (browser-side decode em `cut.task.ts`).
- Encoding strategy GOP-aware (`stream-copy` vs `re-encode`).
- Remoção de fillers PT/EN/ES com guarda de head/tail.
- Log humano por decisão + integração com `JobLogsPanel` e receipt.

## O que falta (gaps vs spec)
1. **Contracts & Versioning** — adicionar `schemaVersion` e `rulesetVersion`
   no `CutPlan`, e tipar `EditingIntent` (style: `dynamic | natural | cinematic`).
2. **Validator Module** — camada de segurança que rejeita planos impossíveis
   (overlaps, segmentos < `minClipMs`, cortes além de `durationSec`,
   filler dentro de janela protegida).
3. **MediaFacts completo** — expor `codec`, `fps`, `width`, `height`,
   `audioChannels`, `keyframeIntervalSec` real (não assumido) e
   `speakerCount` (quando WhisperX dá).
4. **Explanations[] por decisão** — array estruturado `{ factor, weight, contribution }`
   no `CutCandidate`, para o "recibo" mostrar porquê com transparência total.
5. **RenderPlan desacoplado** — tradutor `CutPlan → RendererInstructions`
   (Shotstack ops vs FFmpeg filter_complex) num módulo separado.
6. **EditingIntent → presets** — mapear estilo para overrides de score/padding
   sem o usuário tocar em parâmetros crus.
7. **Speaker-aware cuts** — usar diarization para nunca cortar entre o fim
   da fala de um speaker e o início do próximo se a sobreposição for natural.
8. **Keyframe probe real** — substituir o GOP assumido de 2 s por leitura via
   FFprobe (`-show_frames`) para acertar o `stream-copy` na borda.

## Sprints sugeridos
- **A. Contracts & Validator** — `schemaVersion`, `EditingIntent`, `validatePlan()`.
- **B. Explanations & MediaFacts** — `CutCandidate.explanations[]` + facts
  expandidos via `validateUpload` + FFprobe.
- **C. RenderPlan desacoplado** — extrai `toShotstackOps` / `toFfmpegPlan`.
- **D. Intent presets** — `dynamic` / `natural` / `cinematic` ajustam score.
- **E. Speaker-aware + keyframe probe** — diarization + GOP real.
- **F. Hardening** — fuzz tests com transcripts sintéticos, golden files,
  benchmark de tempo de planejamento p95 < 200 ms para 30 min de áudio.

## Critérios de aceite v1
- `planCuts` retorna `version: { schema, ruleset }` e `validatePlan` zero-issues.
- Receipt mostra ao menos 1 `explanation` por decisão não trivial.
- RenderPlan testado contra Shotstack mock + FFmpeg dry-run.
- p95 do planner < 200 ms para 1800 chunks; 0 cortes sobrepostos em 100 fixtures.
