# Preservar formato original do vídeo (9:16 / 16:9 / 1:1)

## Problema
Vídeos verticais (Reels/TikTok/Shorts) saem tratados como horizontais. Causa raiz provável: dois pontos frágeis no pipeline atual:

1. **Rotação ignorada**: `src/lib/validate-upload.ts` lê `video.videoWidth/videoHeight` do `<video>` do browser. Isso *geralmente* já vem rotacionado, mas em vídeos MP4 de câmera móvel com `rotation=90` metadata, o FFmpeg.wasm no render **não** aplica autorotate por defeito — sai com dimensões trocadas.
2. **Concat sem normalização de SAR/DAR**: quando o plano gera vários segmentos e faz concat, se algum segmento tiver SAR (sample aspect ratio) diferente, o FFmpeg pode forçar as dimensões do primeiro segmento em todos.

Não há hoje: probe de `rotation`, propagação de aspect ratio para o renderer, nem teste de regressão por proporção.

## Objetivo
O output preserva **exatamente** as dimensões visuais do input em 100% dos casos, sem crop, sem letterbox, sem stretch. User vê confirmação visual antes do processamento.

## Escopo

### 1. Detecção robusta no upload
- Estender `validate-upload.ts` para calcular `aspectRatio` (`"9:16" | "16:9" | "1:1" | "4:5" | "other"`) e `orientation` (`"portrait" | "landscape" | "square"`).
- Manter `videoWidth/Height` do browser como fonte principal (já respeita rotação na maioria dos casos).
- Adicionar `displayWidth/displayHeight` em `MediaFacts.video` (`contracts.ts`).

### 2. Propagação no plano
- `RenderPlan.hints` passa a incluir `preserveAspectRatio: true` e `sourceDimensions: { width, height }`.
- Renderer nunca aplica scale/pad/crop implícito. Só transforma quando o user pediu resolution downscale explícito — e mesmo aí usa `scale=-2:h` (já usa) ou `scale=w:-2` conforme orientação.

### 3. FFmpeg — flags corretas
- Adicionar `-noautorotate` **não**; ao contrário: garantir que o autorotate acontece (é o default do FFmpeg desde 5.x, mas confirmar via log).
- No concat/select filter chain, adicionar `setsar=1` antes do concat para normalizar SAR e evitar reescala implícita.
- Log estruturado: `[render] source ${w}x${h} (${aspectRatio}) → output ${w}x${h}`.

### 4. Shotstack adapter
- Passar `output.resolution` como `"preview" | "sd" | "hd" | "1080"` conforme orientação: para 9:16, Shotstack requer `output.aspectRatio: "9:16"` explícito. Hoje o adapter não envia isso — corrigir.

### 5. UI — confirmação visual
- Em `agent-workspace.tsx`, após validate-upload, mostrar chip pequeno: **"9:16 vertical detectado — vamos manter"** (ou 16:9 / 1:1 / custom).
- i18n: pt + en.

### 6. Testes de regressão
- Adicionar 3 fixtures pequenas em `src/lib/agent/cut-planner/__tests__/fixtures/`:
  - `sample-9x16.mp4` (720x1280)
  - `sample-16x9.mp4` (1280x720)
  - `sample-1x1.mp4` (720x720)
- Teste unitário `aspect-ratio-preservation.test.ts` que:
  - Roda cada fixture pelo `planCuts` + `toRenderPlan`.
  - Assert: `plan.hints.sourceDimensions` bate com a fixture.
  - Assert: `RenderOp` gerados não contêm `scale`/`crop`/`pad` filters.
- Teste de integração no adapter Shotstack verificando `output.aspectRatio` correto por fixture.

## Fora do escopo (não fazer agora)
- Auto-crop inteligente (transformar 16:9 em 9:16 com face tracking) — feature grande, roadmap separado.
- Letterbox opcional (adicionar barras pretas). Se user quiser, oferecer em iteração futura.
- Custom aspect ratios não-standard (2.35:1, etc.) — apenas detectar como `"other"` e preservar.

## Arquivos que mudam
- `src/lib/validate-upload.ts` — cálculo de aspect ratio + orientation.
- `src/lib/agent/cut-planner/contracts.ts` — `MediaFacts.video.aspectRatio` + `orientation`.
- `src/lib/agent/cut-planner/render-plan.ts` — hints com `preserveAspectRatio` + `sourceDimensions`.
- `src/lib/agent/renderers/ffmpeg-adapter.ts` — `setsar=1` no filter chain.
- `src/lib/agent/renderers/shotstack-adapter.ts` — `output.aspectRatio` explícito.
- `src/components/agent-workspace.tsx` — chip de confirmação visual.
- `src/lib/i18n.tsx` — strings pt/en.
- `src/lib/agent/cut-planner/__tests__/aspect-ratio-preservation.test.ts` — novo.
- Fixtures em `src/lib/agent/cut-planner/__tests__/fixtures/`.

## Detalhes técnicos

Cálculo de aspect ratio:

```ts
function classifyAspect(w: number, h: number) {
  if (w === 0 || h === 0) return { ratio: "unknown", orientation: "unknown" };
  const r = w / h;
  if (Math.abs(r - 9/16) < 0.02) return { ratio: "9:16", orientation: "portrait" };
  if (Math.abs(r - 16/9) < 0.02) return { ratio: "16:9", orientation: "landscape" };
  if (Math.abs(r - 1)    < 0.02) return { ratio: "1:1",  orientation: "square"   };
  if (Math.abs(r - 4/5)  < 0.02) return { ratio: "4:5",  orientation: "portrait" };
  return { ratio: "other", orientation: r < 1 ? "portrait" : "landscape" };
}
```

Filter chain atual (linha 327 do ffmpeg-processor.ts):
```
[0:v]select='...',setpts=N/FRAME_RATE/TB${scaleChain}${fpsChain}[v]
```
Novo:
```
[0:v]select='...',setpts=N/FRAME_RATE/TB,setsar=1${scaleChain}${fpsChain}[v]
```

## Validação final
1. Rodar `bunx vitest run aspect-ratio-preservation`.
2. Smoke manual: upload de 1 vídeo real 9:16 gravado no telemóvel, confirmar output vertical no player.
3. Verificar no console log: `[render] source 720x1280 (9:16 portrait) → output 720x1280`.

## Estimativa
1–2 dias. Bug P0.
