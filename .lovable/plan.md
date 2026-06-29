# AI Cuts Autônoma — v1

## Por que esta arquitetura

A pesquisa do estado da arte (2025–2026) confirmou o que descrevi antes: **nenhuma ferramenta isolada resolve "cortar sem soar robótico"**. O que funciona é uma pipeline de 5 estágios — VAD → ASR word-level → classificador de pausa → snap por waveform → render com decisão re-encode/copy. WhisperX já entrega timestamps em ±20–50ms; falta a *camada de planejamento* entre detectar e cortar.

Custo cabe no teu cap de **$0.02/min**: WhisperX (já temos) custa $0.006/min, Silero VAD é open-source (Worker server-side, $0), librosa snap é CPU local, Shotstack render já está pago no fluxo. Sobra orçamento para iterar.

## Escopo da sprint (as 4 escolhas que confirmaste)

```text
WhisperX (existente)
   │ words + timestamps
   ▼
┌─────────────────────────────────────────────────┐
│  CUT-PLANNER (novo, src/lib/agent/cut-planner/) │
│                                                  │
│  1. detectCandidates()  — gaps, fillers         │
│  2. extractGapFeatures() — duração, energia,    │
│       pontuação, speaking rate, posição         │
│  3. scoreCandidates()   — score 0..1 ponderado  │
│  4. classify3way()      — KEEP / SHORTEN / CUT  │
│  5. snapCutPoints()     — zero-crossing ±8ms    │
│  6. decideEncoding()    — copy vs re-encode     │
│  7. buildPlan()         — EDL + logs            │
└─────────────────────────────────────────────────┘
   │ CutPlan + DecisionLog[]
   ▼
Render (Shotstack cloud OU FFmpeg local com
        -force_key_frames quando precisar)
```

## Entregáveis

### 1. Tipos e modelo de dados — `src/lib/agent/cut-planner/types.ts`
`Word`, `SpeechChunk`, `SilenceGap`, `CutCandidate`, `CutDecision` (`keep` | `shorten` | `remove`), `CutPlan`, `DecisionLog`. Substitui as `SilenceRange[]` cruas que hoje saem direto do `chunksToSilences`.

### 2. Detect + features — `cut-planner/features.ts`
Para cada gap entre palavras: duração, dB médio (amostra do `AudioBuffer` no browser quando disponível), pontuação da palavra anterior (`.`, `?`, `!`, `,`), speaking rate local (palavras/s nos últimos 3s), posição no vídeo (início/meio/fim), flag de filler.

### 3. Score 3-vias — `cut-planner/score.ts`
Soma ponderada conforme tua proposta original (`silence + filler + low_energy + context − dramatic_pause`), traduzida em três faixas:

```text
score ≥ 0.70 → remove
0.40 ≤ score < 0.70 → shorten (encurta para 250ms se gap > 800ms, senão 400ms)
score < 0.40 → keep
```

Regras de pausa semântica (do paper review):
- gap < 300ms → sempre keep
- 300–1200ms após `.`/`?`/`!` → keep (pausa semântica)
- 1200–2500ms sem boundary → shorten
- \> 2500ms → remove até 400ms

### 4. Snap por waveform — `cut-planner/snap.ts`
Browser: extrai `AudioBuffer` via `decodeAudioData` (já temos o blob), procura zero-crossing mais próximo em janela de ±8ms (≈ 128 samples @ 16kHz). Função pura: `snapToZeroCrossing(samples, targetSec, sampleRate) → number`. Fallback: se não houver ZC na janela, mantém o ponto original e marca `snapped: false` no log.

### 5. Decisão re-encode/copy — `cut-planner/encoding-strategy.ts`
Para cada segmento do plano:
- distância ao keyframe mais próximo (GOP típico ≈ 2s — estimamos via `mediaFacts.fps` e `keyframeInterval` quando o probe trouxer, senão assume 2s)
- se cut cai a ≤ 40ms de keyframe → `stream-copy`
- senão → marca o segmento para `re-encode` (Shotstack faz isso automático; FFmpeg.wasm local usa `-c:v libx264 -preset veryfast` só no segmento afetado)

### 6. Logs estruturados — `cut-planner/decision-log.ts`
Cada decisão vira uma linha legível **e** um objeto serializável que vai pro `DecisionEngine.reasoning`, pro receipt e pro Activity panel:

```text
[keep]    0:12.30–0:12.95 dramatic pause after "?"
[shorten] 0:34.10–0:35.80 → kept 0.40s  (long gap, no boundary)
[remove]  1:02.14–1:02.81 filler "tipo"
[remove]  1:45.00–1:46.12 dead air (>2.5s)
[snap]    cut @ 0:34.10 → 0:34.094 (ZC, -6ms)
[encode]  segment 7  re-encode (cut 380ms from keyframe)
```

Aparecem no `JobLogsPanel` (já existe) com nível `info`. Ficam no `pipeline_feedback` para tuning futuro.

### 7. Integração — substituir `chunksToSilences`
`src/lib/agent/tasks/cut.task.ts` passa a chamar `planCuts(chunks, mediaFacts, audioBuffer?)` em vez de `chunksToSilences`. Output adapta para `SilenceRange[]` (compatível com timeline e renderer atuais) **e** carrega o `DecisionLog[]` no `TaskResults["cut"]` (novo campo opcional).

### 8. Testes — `src/lib/agent/cut-planner/__tests__/`
- `score.test.ts` — fixtures sintéticas: pausa após ponto, filler isolado, dead air, pausa dramática pós-pergunta
- `snap.test.ts` — `Float32Array` sintético com senóide, garante snap em ZC dentro da janela
- `encoding-strategy.test.ts` — cuts em e fora de keyframe
- `planner.integration.test.ts` — chunks reais + fixture de áudio → plano esperado

### 9. Feature flag (sem UI no MVP)
Variável `import.meta.env.VITE_CUT_PLANNER_V1` (default ON em dev, OFF em prod até validar com 5–10 vídeos). Se OFF, cai no `chunksToSilences` antigo. Nada na UI muda — o usuário não escolhe nada (premissa: "IA decide tudo").

## Fora de escopo (vão pro roadmap `ai-cuts-autonomous.md`)

- Silero VAD ONNX server-side (Fase B — pega breaths e silêncios mascarados por ruído)
- Diarização pyannote para proteger backchannels em multi-speaker
- CrisperWhisper (resolve filler detection sem prompt) — pendente review de licença
- LLM classifier para "dramatic pause" em casos ambíguos

## Notas técnicas

- `AudioBuffer` no browser: precisa do `AudioContext` que já existe no `agent-workspace` para o waveform/preview; reaproveita. Server-side a função de snap recebe `Float32Array` extraído via FFmpeg.wasm OU é pulada (snap fica como `null` e o render cuida).
- Compatibilidade: a `SilenceRange[]` que sai do planner é idêntica em formato ao output atual → `SilenceTimeline`, `submitShotstackRender` e `assembleVideoWithRanges` não mudam.
- Custo no cap: planner é 100% local (CPU). Único custo cloud continua sendo WhisperX ($0.006/min) — bem abaixo de $0.02/min.

## Critério de sucesso

Em 5 vídeos de validação (1 podcast clean, 1 talking head com ruído, 1 entrevista 2 speakers, 1 vídeo PT com fillers densos, 1 com pausas dramáticas):
- 0 cliques/pops audíveis nos cortes (vs ~30% hoje quando o cut cai longe de ZC)
- 0 pausas dramáticas removidas indevidamente (hoje removemos qualquer gap > 0.4s sem contexto)
- drift áudio/vídeo < 40ms em todos os cortes (hoje pode chegar a 200ms quando o cut cai longe de keyframe sem re-encode)
- logs de decisão visíveis no `JobLogsPanel` para cada corte

## Estimativa
~10–12 dias de engenharia (Architecture A da pesquisa). Risco de regressão **baixo** — feature flag + fallback para o caminho atual.
