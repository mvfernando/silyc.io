---
name: Speech structure via LLM
description: Futuro — usar LLM sobre o transcript para entender estrutura da fala (repetições, tangentes, ideias fracas) e complementar o cut-planner heurístico
type: feature
---
# Speech structure via LLM (futuro)

## Motivação
Feedback de user (editor profissional) pediu "sistema que entenda a estrutura da fala, não só silêncio". O cut-planner atual pontua *gaps* (score 0..1 com fatores auditáveis), mas não entende **conteúdo**: não deteta "eu acho, eu acho que...", tangentes, correções ("na verdade, o que eu quero dizer é..."), ou frases redundantes.

DaVinci "Scene Cut Detection" é visual (histograma frame-a-frame) — não aplicável a áudio-first. O equivalente real é análise semântica do transcript, território de Descript/Opus Clip.

## Por que ainda NÃO
- **Custo por vídeo**: LLM sobre transcript de 10 min ≈ 3–8k tokens input + saída estruturada. A cada retry/refine multiplica. Quebra a margem no tier atual.
- **Latência**: +5–15s de espera antes do render. Piora TTFV (time-to-first-video), que é a métrica que segura a retenção.
- **Risco de regressão silenciosa**: LLM decide "cortar esta frase" sem explicação auditável como a que temos hoje (`explanations[]` com peso/contribuição). Perde-se transparência.
- **User provavelmente não paga o extra**: nenhum sinal de willingness-to-pay para "edição semântica" no tier free/pro atual.

## Quando reconsiderar
Retomar quando pelo menos 2 destas 3 forem verdade:
1. Tier Pro pago existe e tem >50 users ativos.
2. Modelo Gemini Flash / Haiku custa <$0.10 por vídeo de 10 min com prompt caching.
3. Feedback explícito de ≥5 users pedindo "corta as partes onde eu me repito / me perco".

## Escopo mínimo quando fizer sentido
- **Deteção de repetições literais**: comparar embeddings de frases adjacentes do Whisper (barato, roda local, sem LLM). Pode vir antes do resto.
- **Deteção de auto-correção**: LLM classifica pares de frases como `{original, correção}` e sugere manter só a correção. Opt-in por segmento, com preview.
- **Sumário-guiado**: user descreve em 1 linha o objetivo do vídeo ("tutorial de 3 min sobre X") e LLM marca frases fora-de-tópico como candidatas a corte com score próprio.

Nunca substituir o cut-planner heurístico — sempre camada *aditiva* com explicações auditáveis no receipt.

## Referências relacionadas
- `.lovable/memory/roadmap/ai-cuts-autonomous.md` — waveform snap (já roadmap, escopo menor).
- `src/lib/agent/cut-planner/score.ts` — motor de scoring atual que serve de baseline.