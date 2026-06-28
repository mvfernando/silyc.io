## Áudio sem dependência crítica de cloud — FFmpeg first, DeepFilterNet como Pro

Objetivo: o áudio funciona sempre (offline, grátis), com upgrade real quando o material justifica. O utilizador não escolhe pipeline — o Decision Engine escolhe com base em SNR medido honestamente.

### Arquitetura final do AudioTask

```text
AudioTask
  1. Analyze (FFmpeg, 1 pass)
       ebur128 + astats + janelas de fala do WhisperX (já temos)
       → noiseFloorDb, speechLevelDb, snrDb, integratedLufs
  2. Decide (DecisionEngine)
       SNR > 20dB → "ffmpeg-light"     (highpass + afftdn leve + dynaudnorm + loudnorm)
       SNR 10–20 → "ffmpeg-aggressive" (afftdn nr=12, dynaudnorm g=5)
       SNR < 10  → "cloud-denoise"     (DeepFilterNet3 cloud, Pro)
  3. Run pipeline
       a) Cloud primário: Replicate (já temos audio_jobs, poller, UI)
       b) Fallback automático: fal.ai DeepFilterNet3
       c) Fallback final: ffmpeg-aggressive local
  4. Master (sempre)
       dynaudnorm por segmento de fala + loudnorm 1-pass final sobre o ficheiro inteiro
  5. Report
       Recibo mostra: "Áudio otimizado" + chip do tier (Standard/Pro)
       Métricas internas: SNR antes/depois, LUFS antes/depois, noise floor antes/depois
```

### Tier / packaging

| Tier | Cobertura | Pipeline |
|---|---|---|
| Standard (free) | SNR ≥ 10 dB | FFmpeg light ou aggressive |
| Pro (gated) | SNR < 10 dB | DeepFilterNet3 (Replicate → fal.ai fallback) |
| Premium (futuro) | Voice restoration | Resemble Enhance |

Gating implementado como flag `tier` no perfil do utilizador (default `standard`). Sem cobranças nesta fase — só o toggle e o UI. Quando o Decision Engine escolhe `cloud-denoise` e o tier é `standard`, cai para `ffmpeg-aggressive` e o recibo mostra um banner discreto: *"Áudio com muito ruído — Pro corrige melhor"*.

### Mudanças por ficheiro

**`src/lib/ffmpeg-processor.ts`**
- Nova função `analyzeAudio(file, speechWindows)`: corre uma passagem `-af ebur128,astats=metadata=1:reset=0` e parsea LUFS integrado, RMS por janela. Cruza com `speechWindows` do WhisperX para calcular `speechLevelDb` (p50 dentro de fala) e `noiseFloorDb` (p5 fora de fala). `snrDb = speechLevelDb − noiseFloorDb`.
- Nova função `runAudioPipeline(file, profile, speechWindows)` com `profile ∈ {ffmpeg-light, ffmpeg-aggressive}`. Aplica:
  - `highpass=f=80, afftdn=nr=<6|12>:nf=-25, dynaudnorm=g=<7|5>:m=10` em todo o áudio
  - **Não** divide loudnorm por segmento (evita saltos). Faz `loudnorm=I=-16:TP=-1.5:LRA=11` 1-pass no final.
  - Reaplica este áudio sobre o vídeo já cortado via `-map 0:v -map 1:a -c:v copy`.

**`src/lib/agent/decision-engine.ts`**
- Estende `TaskParams["audio"]` com `profile: "ffmpeg-light" | "ffmpeg-aggressive" | "cloud-denoise" | "skip"` e `snrDb`.
- Função `pickAudioProfile(facts, tier)` aplica as bandas de SNR + downgrade quando tier=standard. Adiciona reasoning legível: *"SNR=8.4dB → recomenda cloud; tier=standard → ffmpeg-aggressive"*.

**`src/lib/agent/tasks/audio.task.ts`** (refactor)
- Etapa 1: `analyzeAudio` (não havia antes) — usa `transcribe.segments` se existir.
- Etapa 2: se `profile === "cloud-denoise"`:
  - tenta Replicate (`thomas-yanxin/deepfilternet`) com timeout 90 s e 1 retry
  - on failure → tenta fal.ai DeepFilterNet3 (timeout 90 s)
  - on failure → degrada para `ffmpeg-aggressive` local + log claro
- Etapa 3: sempre corre o master FFmpeg final (mesmo após cloud denoise — para LUFS consistente).
- Mantém escrita em `audio_jobs` com novo campo `profile_used` e `snr_before`/`snr_after`.

**Integrações novas**
- fal.ai: usar connector `standard_connectors--connect` (provider `fal-ai`) — sem secret manual. Função wrapper `src/lib/fal.functions.ts` (server fn, fetch direto ao gateway). Só usada como fallback.
- Replicate: já configurado.

**`src/components/agent-workspace.tsx` (ReadyStage)**
- Acrescenta painel "Áudio" no recibo com:
  - Linha pública: *"Áudio otimizado — Standard / Pro"*
  - Botão expandível "Ver métricas" → SNR antes→depois, LUFS antes→depois, perfil usado, tempo, fallbacks que correram.
- Quando downgrade Pro→Standard aconteceu, banner discreto com CTA *"Ouvir versão Pro"* (placeholder por agora — abre modal de "Em breve").

**Tabela `pipeline_feedback`** (migration)
- Adicionar colunas `audio_profile_used text` e `audio_snr_db numeric` para alimentar o admin dashboard (já existente) com "qual perfil é escolhido por formato".

### O que **fica de fora deste sprint** (explícito)

- Billing real do Pro — só o gating funcional + UI.
- A/B "ouvir Standard vs Pro" gravados lado a lado — só placeholder.
- Migração da UI de jobs antiga (`AIEnhanceCard`) — fica como modo manual escondido.

### Critério de aceitação

1. Vídeo com ruído leve (SNR≈25 dB) → corre 100% local, recibo mostra Standard, LUFS final entre −15 e −17.
2. Vídeo com ruído pesado (SNR≈8 dB), tier=standard → corre `ffmpeg-aggressive`, banner Pro aparece.
3. Vídeo com ruído pesado, tier=pro, Replicate forçado a falhar → cai em fal.ai; se fal.ai falhar → cai em ffmpeg-aggressive; recibo lista os fallbacks.
4. Em todos os 3 casos: A/B no preview já existente reproduz original vs final em sync.
5. Métricas no recibo coincidem (±0.5 dB) com `ffprobe` manual sobre o output.

### Riscos / decisões assumidas

- **fal.ai como fallback** assume que o connector cobre DeepFilterNet3. Se o modelo não existir no fal.ai catalog hoje, o fallback fica só `Replicate → ffmpeg-aggressive`; mantém-se a arquitetura, removo a etapa intermédia.
- **Master FFmpeg sempre no fim** garante loudness consistente mesmo quando o denoise é cloud — custa ~5–15 s extra mas é a única forma de evitar variação audível entre tiers.
- **Sem migração da `AIEnhanceCard`** evita regressões na UI atual; o agente passa a usar o novo pipeline transparentemente.
