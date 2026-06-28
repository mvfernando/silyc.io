
# Validação do AudioTask — FFmpeg first + DeepFilterNet Pro

Objetivo: provar com números que os 3 cenários do critério de aceitação se comportam como o spec descreve, sem mexer em código de produção.

## Abordagem

Validação em duas camadas:

1. **Unit/integration nos módulos puros** (rápido, determinístico) — `analyzeAudio`, `pickAudioProfile`, master pipeline. Roda em Node via Vitest com `ffmpeg` nativo do sandbox (não ffmpeg.wasm), reusando os mesmos comandos.
2. **E2E no browser** com Playwright contra `localhost:8080` — sobe 3 vídeos preparados, deixa o agente correr, lê o recibo do DOM, compara com `ffprobe` manual sobre o blob exportado.

## Fixtures

Gerar 3 clipes curtos (10 s, 720p, voz sintética via `espeak` + `ffmpeg`) em `/tmp/silyc-fixtures/`:

- `clean.mp4` — voz limpa, SNR alvo ≈ 25 dB
- `noisy.mp4` — voz + ruído branco a −20 dBFS, SNR alvo ≈ 8 dB
- `noisy-pro.mp4` — igual ao anterior, marcado para correr no tier `pro`

Receita ffmpeg (sem editar projeto):

```text
ffmpeg -f lavfi -i "sine=...,anoisesrc" + overlay de voz TTS
ffprobe -af ebur128,astats valida SNR/LUFS gerado vs alvo (±1 dB)
```

## Cenários e asserções

| # | Fixture | Tier | Pipeline esperado | Asserções no recibo | Asserções no output |
|---|---|---|---|---|---|
| 1 | clean.mp4 | standard | `ffmpeg-light` | chip "Standard", sem banner Pro, reasoning cita SNR>20 | LUFS final ∈ [−17, −15], SNR depois ≥ antes |
| 2 | noisy.mp4 | standard | `ffmpeg-aggressive` + banner Pro | chip "Standard", banner "muito ruído — Pro corrige melhor" | noise floor cai ≥ 6 dB, LUFS ∈ [−17, −15] |
| 3 | noisy-pro.mp4 | pro | Replicate (forçado fail) → fal.ai (forçado fail) → `ffmpeg-aggressive` | recibo lista os 2 fallbacks, chip "Pro" downgraded | igual ao #2 |

Falhas forçadas no cenário 3 via `MSW`/intercept de fetch para `replicate.com` e `fal.ai` retornarem 503.

## Execução

1. **Unit** — `bunx vitest run src/lib/agent/__tests__/audio.task.test.ts` (novo ficheiro só com mocks de ffmpeg + fixtures pequenas).
2. **Decision engine** — `bunx vitest run src/lib/agent/__tests__/decision-engine.audio.test.ts` cobrindo bandas SNR e downgrade tier.
3. **E2E Playwright** — script único `/tmp/browser/audio-validation/run.py` que:
   - injeta sessão Supabase (LOVABLE_BROWSER_*),
   - faz upload de cada fixture,
   - espera estado "Ready",
   - lê painel "Áudio" via `get_by_test_id`,
   - baixa blob final, corre `ffprobe -af ebur128,astats` localmente, compara com métricas do recibo (±0.5 dB).
4. **Relatório** — tabela markdown com SNR antes/depois, LUFS antes/depois, perfil escolhido, fallbacks, pass/fail por cenário. Salva em `/mnt/documents/audio-validation-report.md` + 3 screenshots do recibo.

## Sem alterações de produção

Só serão adicionados:

- `src/lib/agent/__tests__/audio.task.test.ts`
- `src/lib/agent/__tests__/decision-engine.audio.test.ts`
- `data-testid` mínimos no painel Áudio do `ReadyStage` (apenas atributos, sem mudança visual) se não existirem ainda

Nenhum ficheiro de pipeline (`ffmpeg-processor.ts`, `audio.task.ts`, `decision-engine.ts`) é tocado.

## Saída para o utilizador

- Relatório markdown com a tabela acima
- Screenshots dos 3 recibos
- Lista clara de qualquer desvio entre métricas exibidas e `ffprobe` real, com fix proposto caso falhe

## Riscos

- TTS sintético pode dar SNR diferente do alvo → fixtures recalibradas até `ffprobe` confirmar antes de correr os testes.
- fal.ai pode não estar ligado como connector ainda; nesse caso cenário 3 valida só Replicate→ffmpeg e marca fal.ai como "não testado" no relatório (não falha o sprint, conforme o próprio plano original assumiu).
