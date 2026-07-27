
# Waveform-first silence detection + threshold slider

## Diagnóstico (por que hoje corta mal)

Os cortes vêm de `word.end → nextWord.start` (Whisper). Isso é bom para *entender* fala, ruim para *cortar áudio*: word timestamps têm ±100–250ms de jitter, não veem respiração/plosivas, e o padding fixo (0.25s/0.15s) tenta compensar cegamente. O SilentCut ganha porque mede o **envelope de RMS** direto do PCM — o silêncio é uma propriedade do sinal, não do texto.

Além disso o pipeline atual re-encoda tudo (`libx264` no FFmpeg.wasm) mesmo quando o corte cai perto de keyframe. SilentCut faz **stream-copy** — daí "sem perda de qualidade" que o user notou. Já temos `encoding-strategy.ts` para decidir isso, mas o renderer ignora.

## Objetivo

Detectar silêncio pelo **envelope de áudio**, não pelo transcript. Whisper continua rodando **apenas** para: (a) detectar fillers ("uhm", "então"), (b) resolver intent/estilo. Os *timestamps* de corte saem do waveform.

Meta mensurável: em 10 vídeos de teste, ≥ 90% dos cortes caem dentro de ±40ms de um zero-crossing real, sem sílaba cortada.

## Escopo

### 1. Novo módulo: `waveform-silence.ts`
`src/lib/agent/cut-planner/waveform-silence.ts` — pure function:

```ts
detectSilencesFromWaveform(samples: Float32Array, sampleRate: number, opts: {
  thresholdDb: number;        // default -40dB (slider: -50..-25)
  minSilenceSec: number;      // default 0.35
  paddingSec: number;         // default 0.08 (bem menor que hoje)
  hopMs: number;              // default 10
  windowMs: number;           // default 25
}): { start: number; end: number; rmsDb: number }[]
```
Algoritmo: RMS por janela → binariza (< threshold), fecha gaps < 100ms, expande com padding, **snap** cada borda ao zero-crossing mais próximo via `snap.ts` que já temos.

### 2. Planner passa a consumir waveform, não words
`planner.ts`:
- Sempre que `audioSamples` disponível → `detectSilencesFromWaveform` vira **fonte primária** dos gaps.
- Whisper words continuam entrando só para: marcar filler-only gaps (`isFillerWord`) e alimentar `intent`.
- `chunksToSilences` (path legado word-based) só é usado como fallback quando o decode de áudio falha.

### 3. Threshold slider na UI
`agent-workspace.tsx` — na `UploadStage`, ao lado do style picker:
- Slider `Sensibilidade`: -50dB (agressivo) ↔ -25dB (conservador), default -40dB.
- Persistir em `localStorage: silyc:agent:threshold`.
- Passa `thresholdDb` em `TaskParams["cut"]`.
- Chip explicativo: "Detecta pausas ≥ 350ms abaixo de −40dB".

### 4. Padding menor por default
Reduzir `paddingSec` default de 0.25/0.15 para 0.08/0.08. Padding grande foi remédio para timestamps ruins — agora que a borda é acústica, não precisa.

### 5. Renderer honra `encoding-strategy`
`ffmpeg-adapter.ts` + `ffmpeg-processor.ts`:
- Já temos `planSegments()` decidindo `copy` vs `encode`. O renderer atual descarta essa decisão.
- Emitir dois filter graphs: segmentos `copy` via `-c copy` concat demuxer, segmentos `encode` via filter_complex. Concat final com `concat` protocol.
- **Não** aplicar `-c:v libx264` global. Preserva bitrate/qualidade original nos trechos intactos.

### 6. Timeline mostra dBFS
`silence-timeline.tsx` — tooltip do segmento removido passa a mostrar `−42 dB · 480 ms` em vez de só o range. User entende *por que* foi cortado.

## O que remover / simplificar (o que "faz não funcionar")

- **`chunksToSilences` como caminho primário** em `auto-cut.ts` — vira fallback puro. Toda a lógica de "coalesce filler windows across words" some do caminho quente.
- **`headPaddingSec` / `tailPaddingSec` diferenciados** em `TaskParams["cut"]` — colapsar num `paddingSec` só; head/tail viravam patch para jitter de Whisper.
- **Fade-in de 20ms hard-coded** no filter chain — mover para opção do intent preset (`cinematic` mantém, `natural`/`dynamic` removem: fade em corte de silêncio real gera "chupada" audível).
- **Re-encode global** no ffmpeg-adapter — substituído por decisão per-segment.
- **`minGapSec` no cut params** — redundante com `minSilenceSec` do waveform.

## Fora do escopo

- Waveform analysis server-side. Fica browser (AudioContext já existe em `tryDecodeAudio`).
- Loudness normalization / EQ / de-esser (queixa "áudio sofreu modificações" — trato em plano separado depois; suspeito que seja o fade + re-encode).
- VAD (Silero) — waveform + threshold resolve 90% sem custo de modelo.
- Auto-tuning do threshold por vídeo — v2.

## Arquivos que mudam

- **novo** `src/lib/agent/cut-planner/waveform-silence.ts`
- **novo** `src/lib/agent/cut-planner/__tests__/waveform-silence.test.ts`
- `src/lib/agent/cut-planner/planner.ts` — usar waveform quando `audioSamples` presente
- `src/lib/agent/cut-planner/contracts.ts` — `thresholdDb` em `TaskParams["cut"]`, remover `head/tailPaddingSec` e `minGapSec`
- `src/lib/agent/tasks/cut.task.ts` — repassar `thresholdDb`
- `src/lib/agent/renderers/ffmpeg-adapter.ts` — honrar `EncodingStrategy` por segmento
- `src/lib/ffmpeg-processor.ts` — split concat (copy vs encode), remover fade default
- `src/components/agent-workspace.tsx` — slider + persist + chip
- `src/components/silence-timeline.tsx` — tooltip com dBFS
- `src/lib/i18n.tsx` — strings pt/en para slider e chip
- **remover uso primário** `src/lib/auto-cut.ts::chunksToSilences` (fica exportado como fallback)

## Fases (para eu executar sequencial, cada uma verificável)

1. **Detector puro + testes** — `waveform-silence.ts` + 6 testes com fixtures sintéticas (silêncio DC, ruído branco, tom + silêncio, borda em zero-cross, gap curto colapsado, threshold sweep).
2. **Wire no planner** — waveform vira fonte primária, word-based vira fallback. Rodar `planner.integration.test.ts` para garantir 0 regressão.
3. **UI slider + params** — threshold no `TaskParams`, slider persistido, chip.
4. **Renderer per-segment** — split copy/encode, remover fade default, remover re-encode global.
5. **Timeline dBFS** — cosmético, último.
6. **Smoke E2E** — script Playwright com 1 vídeo real 9:16 e 1 vídeo 16:9, medir % de segmentos `copy` no log e conferir que output player renderiza som limpo.

## Validação

- `bunx vitest run waveform-silence` verde.
- `bunx vitest run planner.integration` continua verde (0 regressão).
- Log estruturado: `[cut] waveform: 12 silences, mean −44dB, 8 snapped to ZC (Δ<2ms), 4 segments copy / 3 encode`.
- Smoke manual: user faz upload, ajusta slider, vê chip com threshold, output player toca sem fade estranho no corte.

## Estimativa

Fase 1–2: meio dia. Fase 3–5: meio dia. Fase 6 e polish: meio dia. Total ~1.5 dia.

## Risco / mitigação

- **Vídeo com música de fundo baixa** → threshold −40dB pode não achar silêncio. Mitigação: slider expõe o controle, e chip explica.
- **Áudio muito clipado / ruído constante** → tudo acima do threshold, nada cortado. Fallback: se waveform devolver 0 gaps mas Whisper vê gaps > 500ms, cair no path legado com aviso no log.
- **AudioContext falha em Safari mobile** → já temos `tryDecodeAudio` retornando null; nesse caso path legado assume automaticamente.
