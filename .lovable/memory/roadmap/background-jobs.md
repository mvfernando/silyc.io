---
name: Background jobs / resume from anywhere
description: Mover pipeline do navegador para jobs server-side persistidos para permitir sair e voltar
type: feature
---
# Background jobs (sair e voltar)

## Problema
Hoje o AgentWorkspace roda 100% no browser via FFmpeg.wasm. Sair da aba cancela o trabalho — não dá para retomar do 79%. A mensagem "pode fechar esta página" foi corrigida para refletir isso ("mantenha a aba aberta").

## Objetivo
Permitir que o usuário inicie um projeto, feche a aba e volte depois para baixar o resultado, com notificação opcional.

## Esboço de arquitetura
- Tabela `jobs` (id, project_id, user_id, status: queued|running|done|failed|cancelled, phase, progress, result_url, error, created_at, updated_at).
- Upload do source para storage `videos/` antes de enfileirar.
- Worker server-side: caminho cloud já existe (Shotstack via `submitShotstackRender` + `pollShotstackRender`); estender para fluxo completo (transcribe → cut → audio → render) usando Replicate/fal.ai + Shotstack, sem FFmpeg.wasm.
- `pg_cron` + `/api/public/hooks/jobs-tick` para fazer polling dos providers e atualizar `jobs`.
- Realtime subscription em `jobs` (já temos infra) para atualizar UI ao voltar.
- Toast/badge "Job pronto" no header quando `status=done` for detectado em outra sessão.

## Decisões pendentes
- Manter FFmpeg.wasm como fast-path para vídeos pequenos (<200MB) ou descontinuar?
- Notificação por e-mail quando terminar (opt-in)?
- Cota: 1 job ativo por usuário no free, N no pro?

## Status
Pendente. Retomar junto com a reestruturação de rotas (`mem://roadmap/routes-restructure.md`) — faz sentido lançar com `/projects/:id` como hub que mostra jobs em andamento.