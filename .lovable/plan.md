# Background jobs + aviso de saída

Divido em duas fases porque o custo é muito assimétrico. Fase 1 é entregável em uma rodada; Fase 2 é o sprint que está no roadmap (`mem://roadmap/background-jobs.md`).

## Fase 1 — Proteções imediatas (entrega agora)

Funciona dentro da arquitetura atual (FFmpeg.wasm no browser). Não permite sair de verdade, mas evita que o usuário perca trabalho por engano e melhora a percepção de progresso.

1. **Aviso ao sair/atualizar durante processamento**
   - `beforeunload` listener no `AgentWorkspace` enquanto `stage === "working"`.
   - Mensagem nativa do browser ("Sair desta página? O trabalho em andamento será cancelado.").
   - Bloqueio também em navegação interna via `useBlocker` do TanStack Router → modal customizado em PT/EN ("Cancelar e sair" / "Continuar processando").

2. **Snapshot de progresso local (recovery parcial)**
   - Gravar a cada `phase`/`progress` em `localStorage` (`silentcut.agent.lastRun`): `{ fileName, fileSize, stage, currentTask, progress, perTask, plan, startedAt }`.
   - Ao voltar para `/app` sem job ativo, se houver snapshot recente (<1h) e `stage !== "ready"`, mostrar banner: "Você tinha um processamento de `IMG_3300.mp4` em 79% que foi interrompido. Reenvie o arquivo para retomar." + botão "Limpar".
   - Não é retomada real — é só feedback honesto sobre o que aconteceu.

3. **Mensagens de progresso mais claras**
   - Já existem labels por task; adicionar sub-status com tempo decorrido por fase (ex.: "Cortando silêncios… 1m 23s") e ETA estimado quando `progress > 10%`.

## Fase 2 — Background jobs reais (sprint, requer aprovação)

Mover o pipeline inteiro do browser para o servidor. Único caminho que permite literalmente fechar a aba e voltar depois.

### Mudanças de arquitetura

- **Tabela `jobs`** (nova): `id, project_id, user_id, status (queued|running|done|failed|cancelled), current_phase, progress, source_path, output_path, error, provider_refs jsonb, created_at, updated_at`. RLS por `user_id`. Realtime habilitado.
- **Upload obrigatório antes de enfileirar**: arquivo vai pro bucket `videos/` (já existe) com signed URL.
- **Pipeline server-side**:
  - `transcribe` → já é Replicate (whisperx). Mantém.
  - `cut` → migrar de FFmpeg.wasm para Shotstack (já temos `submitShotstackRender` com keeps/cuts).
  - `audio` → cloud-denoise quando necessário (já temos Replicate + fal.ai); mastering leve via Shotstack audio filters ou pular nesta fase.
  - `render` → Shotstack (já existe).
- **Orquestrador**: `pg_cron` a cada 30s chama `/api/public/hooks/jobs-tick` (route nova) que: pega jobs `running`, faz polling nos providers (Replicate prediction id, Shotstack render id), atualiza `progress`/`status`, encadeia próxima task.
- **Frontend**:
  - Submeter cria row em `jobs`, navega para `/projects/:id` que assina realtime.
  - Polling fallback (10s) quando realtime falha — já temos padrão.
  - Header mostra badge "1 job em andamento" cross-page; toast quando completa em outra aba.
  - Botão "Cancelar" marca `status=cancelled` e o tick para de avançar.

### O que muda para o usuário

- Vídeos < 200 MB: pode escolher "modo rápido" (browser) ou "modo background" (cloud).
- Vídeos > 200 MB: sempre background.
- Custo em créditos sobe (mais uso de Shotstack/Replicate).

### Pré-requisitos / decisões pendentes

- Confirmar que tudo passa por Shotstack (cut + render) é aceitável vs manter FFmpeg.wasm como caminho rápido.
- Cota: 1 job ativo por usuário no plano free?
- Notificação por e-mail ao concluir é desejada nesta fase ou v2?

### Estimativa

Fase 2 = ~6-10 arquivos novos/modificados (migration, route api, orquestrador, AgentWorkspace, página `/projects/:id`, hooks de realtime, testes). Não cabe nesta rodada sem riscar regressão no fluxo atual.

## Recomendação

Faço **Fase 1 agora** (aviso + snapshot + mensagens) — resolve a dor imediata de perder trabalho. Confirme se quer que eu siga direto para **Fase 2** depois, respondendo as 3 decisões pendentes acima.
