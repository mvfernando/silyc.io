# SilentCut — Assistente de Pós-Produção (MVP)

App web bilíngue (PT/EN) que automatiza limpeza de timeline, áudio e cor. Estética **dark cinematográfica** (fundo `#0A0A0B`, painéis `#16161A`, texto `#E5E5E5`, acento ember `#FF4D2E`).

## Arquitetura de processamento (híbrida)


| Tarefa                                               | Onde roda                   | Por quê                                                                                                                         |
| ---------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Remoção de silêncio/pausas                           | **FFmpeg.wasm no browser**  | Funciona sem API, sem custo, ideal para vídeos ≤ ~200 MB. Detecta silêncio com `silencedetect`, monta lista de cortes e remuxa. |
| Normalização de volume + redução básica de ruído     | **FFmpeg.wasm no browser**  | Filtros `loudnorm` e `afftdn` rodam direto no wasm.                                                                             |
| Otimização de áudio com IA (denoise + clareza vocal) | **API externa (Replicate)** | Modelo `resemble-ai/resemble-enhance` para limpeza profissional de voz.                                                         |
| Correção de cor cinematográfica                      | **API externa (Replicate)** | Pipeline com LUT + auto-exposição via modelo de color grading.                                                                  |
| Login + histórico de projetos                        | **Lovable Cloud**           | Auth (email/senha + Google), tabela `projects`, storage para arquivos processados.                                              |


> A primeira fase de cada job sempre passa pelo FFmpeg.wasm local (corte de silêncio). As etapas de IA são opcionais — usuário ativa via switches antes de enviar.

## Estrutura de páginas

```text
src/routes/
├── __root.tsx                          # shell + provider de i18n + listener auth
├── index.tsx                           # landing pública (hero, antes/depois, features, CTA)
├── auth.tsx                            # login/cadastro (email+senha, Google)
└── _authenticated/
    ├── route.tsx                       # gate gerenciado (já existe na integração)
    ├── app.tsx                         # workspace: upload + opções + barra de progresso
    ├── projects.tsx                    # lista de projetos do usuário
    └── projects.$id.tsx                # detalhe: player antes/depois, download, logs
```

## Banco de dados (Lovable Cloud)

```sql
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  status text not null default 'pending',     -- pending|processing|done|error
  source_path text,                            -- storage path do original
  output_path text,                            -- storage path do resultado
  settings jsonb not null default '{}'::jsonb, -- {removeSilence, enhanceAudio, colorGrade, silenceThreshold...}
  stats jsonb default '{}'::jsonb,             -- {originalDuration, finalDuration, secondsSaved}
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

grant select, insert, update, delete on public.projects to authenticated;
grant all on public.projects to service_role;
alter table public.projects enable row level security;

create policy "users read own projects" on public.projects
  for select to authenticated using (auth.uid() = user_id);
create policy "users insert own projects" on public.projects
  for insert to authenticated with check (auth.uid() = user_id);
create policy "users update own projects" on public.projects
  for update to authenticated using (auth.uid() = user_id);
create policy "users delete own projects" on public.projects
  for delete to authenticated using (auth.uid() = user_id);
```

Mais um bucket de storage `videos/` privado, com policies escopadas por `auth.uid()` na primeira parte do path.

## Server functions

- `createProject({ name, settings })` — cria registro `projects` (autenticado).
- `getUploadUrl({ projectId, kind })` — assina URL para upload do original ou do resultado.
- `enhanceAudio({ projectId, audioUrl })` — chama Replicate `resemble-enhance`, salva no storage, atualiza `output_path`.
- `colorGrade({ projectId, frameUrl })` — chama Replicate modelo de color, retorna LUT/preset aplicado pelo browser via FFmpeg.wasm.
- `listProjects()` / `getProject({ id })` / `deleteProject({ id })`.

`REPLICATE_API_TOKEN` é guardado via `add_secret` depois que o usuário confirmar que quer ativar as opções de IA.

## Fluxo do usuário

1. Landing → CTA "Começar grátis" → `/auth`.
2. Após login, vai pra `/app`: dropzone, switches (Remover silêncio, Otimizar áudio, Color grading cinematográfico), sliders avançados (limiar de silêncio em dB, pausa mínima em ms).
3. Ao clicar **Processar**:
  - cria projeto, sobe original pro storage,
  - FFmpeg.wasm extrai áudio, roda `silencedetect`, calcula cortes, remuxa vídeo limpo,
  - se "otimizar áudio" ativo: server fn → Replicate → áudio limpo retorna e é mesclado,
  - se "color grading" ativo: server fn pega frame de referência, gera LUT, FFmpeg.wasm aplica,
  - resultado vai pro storage, `projects.status='done'`, `stats` preenchida.
4. Tela do projeto mostra player A/B (antes/depois), tempo economizado, botão de download e botão de excluir.

## i18n (PT/EN)

`src/lib/i18n.tsx` — context simples com dicionários `pt` / `en` em JSON, toggle no header, persistência em `localStorage`, idioma padrão detectado por `navigator.language`. Sem libs pesadas.

## Design system

- Adiciona tokens em `src/styles.css`: `--background: oklch(0.14 0 0)`, `--card: oklch(0.18 0 0)`, `--foreground: oklch(0.92 0 0)`, `--primary: oklch(0.66 0.22 35)` (ember), `--muted-foreground: oklch(0.6 0 0)`, `--border: oklch(1 0 0 / 8%)`.
- Tipografia: **Space Grotesk** (display) + **Inter** (texto) carregados via `<link>` no `__root.tsx`.
- Componentes shadcn em variantes escuras; cards com leve grão/ruído via SVG; gradientes radiais sutis no hero.
- Microanimações com Motion (entradas, contador de "tempo economizado", waveform animada na landing).
- Sobre design
  Aqui eu discordo parcialmente do plan do Lovable: **dark cinematográfica + Space Grotesk + gradientes radiais + grão + waveform animada** pode ficar visualmente apelativo, mas também corre o risco de cair numa estética muito parecida com templates AI/SaaS. Além disso, o próprio guidance de design que tenho carregado recomenda evitar padrões visuais genéricos como gradientes chamativos, estética excessivamente “AI” e fontes muito polarizantes; Space Grotesk aparece explicitamente na lista de fontes a evitar para web generalista.[shotstack](https://shotstack.io)
  Eu manteria o dark, mas mais contido:
  - Fundo escuro sim.
  - Acento ember sim.
  - Menos gradiente radial decorativo.
  - Menos “cinematic vibe” abstrata.
  - Tipografia mais segura, como Satoshi/Inter ou General Sans/Inter.[shotstack](https://shotstack.io)

## Detalhes técnicos

- FFmpeg.wasm: pacote `@ffmpeg/ffmpeg` + `@ffmpeg/util`, core servido como asset estático em `public/ffmpeg/` (single-thread; multi-thread requer COOP/COEP que não temos garantido).
- Processamento em Web Worker para não travar a UI; progresso reportado via `postMessage`.
- Uploads diretos browser → Storage (sem passar pelo Worker do servidor, que tem limites de payload).
- Validação Zod em todos os inputs (nome do projeto, settings).
- Rotas `index` e `auth` são públicas; tudo de usuário fica sob `_authenticated/`.

## Fora de escopo (MVP)

- Edição manual da timeline.
- Legendas/transcrição automática.
- Exportação para formatos além de MP4 H.264.
- Pagamento/planos.

## Ordem de implementação

1. Ativar Lovable Cloud + habilitar auth (email+senha, Google) + criar tabela `projects` + bucket storage.
2. Design system (tokens, fontes, componentes base) + landing pública bilíngue.
3. Página `/auth` + i18n + listener de auth no `__root`.
4. Workspace `/app` com upload e FFmpeg.wasm rodando remoção de silêncio (caminho feliz local primeiro).
5. Storage de resultados + lista `/projects` + detalhe `/projects/$id`.
6. Pedir `REPLICATE_API_TOKEN`, implementar server functions de IA, ligar switches.
7. Polimento: animações, estados de erro, copy bilíngue, vídeo demo na landing.

Quando aprovar, começo pelo passo 1.