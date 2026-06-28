## Princípio guia

**"O utilizador nunca toma decisões técnicas."**

Toda a feature passa por este filtro. Se obriga o utilizador a perceber de edição de vídeo, vai para o agente ou para o modo avançado.

---

## Arquitectura (passo 1 — antes de qualquer UI)

Substituir a ideia de `runPipeline()` por uma estrutura modular já preparada para a Fase 3/4:

```text
src/lib/agent/
  ├── post-production-agent.ts   ← entry point: agent.run(file, ctx)
  ├── decision-engine.ts         ← decide quais tasks correr e com que parâmetros
  ├── task-runner.ts             ← orquestra execução, progresso, cancel/resume
  ├── tasks/
  │   ├── transcribe.task.ts     ← Whisper + cache (transcriptions table)
  │   ├── cut.task.ts            ← auto-cut (parâmetros vêm do Decision Engine)
  │   ├── audio.task.ts          ← Resemble Enhance (skipped se sem áudio)
  │   └── render.task.ts         ← cloud ou local (Decision Engine decide)
  └── receipt-builder.ts         ← constrói value-receipt a partir dos resultados
```

Decision Engine na Fase 1+2 é `if/else` simples mas a interface (`decide(context) → TaskPlan`) já está pronta para receber heurísticas reais na Fase 3.

Exemplos de decisões já na primeira versão:
- Sem áudio detectável → salta `AudioTask`.
- Duração < 30s ou ficheiro < 50MB → render local (mais barato/rápido).
- Cache hit em `transcriptions` → salta `TranscribeTask`, vai direto a `CutTask`.
- Já existe versão "Auto" deste ficheiro → segunda corrida usa preset "cut_more".

Cancel/resume continuam a funcionar via `resume-store` (já existe).

---

## Fluxo do utilizador (3 estados)

```text
UPLOAD  →  ✓ Vídeo recebido. A IA começou a trabalhar...  →  WORKING  →  READY
```

### Upload
Dropzone grande. Copy: **"Upload. Volte quando estiver pronto."** Zero opções visíveis.

### Working
Frases humanas, nunca nomes técnicos:
- A compreender o vídeo...
- A preparar os melhores cortes...
- A otimizar para publicação...
- Quase pronto...

Barra global ponderada, ETA, botão único: cancelar. Não menciona Whisper, Replicate, Shotstack, FFmpeg.

### Ready — value-receipt
Peça central do produto:

```text
A IA encontrou:
✓ Podcast · Português · Um orador · Ritmo lento · Muito silêncio

✓ 37 silêncios removidos
✓ 18 fillers removidos
✓ 2m 43s eliminados
≈ Poupou cerca de 1h 12 de edição manual

[ ▶ Pré-visualizar ]   [ ⬇ Download ]

Como ficou?    😍 Excelente    🙂 Bom    😕 Precisa melhorar

[ ✨ Refinar com IA ]
```

Regras:
- "Análise" só mostra atributos com confiança alta (idioma e contagem de fala, sim; ritmo, só se houver sinal claro). Se incerto, omite — nunca arrisca um falso "Podcast detectado".
- Tempo poupado de edição manual via heurística conservadora:
  `(silêncios × 8s) + (fillers × 5s) + (segundos_eliminados × 1.4)`.
- Três reacções (sem 👎 absoluto — esse caso resolve-se com "Refinar com IA").

### Refinar com IA — opções intermédias antes de sliders
Ao clicar abre um picker:

```text
Como quer melhorar?
○ Mais dinâmico        (cortes mais rápidos, menos respiração)
○ Mais natural         (preservar pausas dramáticas)
○ Cortar ainda mais    (segunda passada agressiva, fillers extras)
○ Ajustar manualmente  (timeline + sliders — escape honesto)
```

As três primeiras correm o agente outra vez com parâmetros do Decision Engine — sem sliders, sem terminologia técnica. A escolha vai para `pipeline_feedback.refinement_choice` para alimentar a Fase 3. A quarta abre o painel "avançado" actual (sliders, timeline interativa, presets internos) como escape.

---

## Histórico como jornada

Em vez de `Versão 1 / 2 / 3`:

```text
Original  →  Auto  →  Refinado (Mais dinâmico)  →  Manual
```

Os labels são derivados de `refinement_choice` + tipo de execução. Comunicam o posicionamento: Auto é o produto, Manual é a excepção.

---

## Auto-start sem perguntar

Logo após upload + validação:
1. Mostra confirmação curta "✓ Vídeo recebido. A IA começou a trabalhar..."
2. Agent corre. Tudo ligado por defeito, mas o Decision Engine decide o que realmente executa.
3. Estimativa de custo aparece discreta no canto durante o Working (não pede confirmação — Whisper é cêntimos).

---

## O que esconde mas não apaga

Mantém intacto, fora do caminho principal:
- `AutoCutCard`, `AIEnhanceCard` como cards separados → integrados como tasks invisíveis
- `PresetPicker`, sliders, `ImpactPreview`, custom presets → só dentro de "Ajustar manualmente"
- Opções de export (codec/bitrate/resolução) → IA escolhe MP4 1080p H.264 a partir da fonte
- Timeline interativa, override manual, range preview → ficam no caminho "Ajustar manualmente"

Remoção de código só após 30 dias sem regressões reportadas.

---

## Migration

```sql
create table public.pipeline_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  version_id uuid references public.project_versions(id) on delete cascade not null,
  rating smallint not null check (rating in (1, 2, 3)),  -- 3=😍 2=🙂 1=😕
  refinement_choice text check (refinement_choice in (
    'none','more_dynamic','more_natural','cut_more','manual'
  )),
  created_at timestamptz not null default now(),
  unique (user_id, version_id)
);

grant select, insert, update on public.pipeline_feedback to authenticated;
grant all on public.pipeline_feedback to service_role;
alter table public.pipeline_feedback enable row level security;

create policy "own feedback read" on public.pipeline_feedback
  for select to authenticated using (user_id = auth.uid());
create policy "own feedback write" on public.pipeline_feedback
  for insert to authenticated with check (user_id = auth.uid());
create policy "own feedback update" on public.pipeline_feedback
  for update to authenticated using (user_id = auth.uid());
```

---

## Ordem de implementação

1. **Arquitectura interna do agente** — criar `src/lib/agent/*` com Decision Engine + TaskRunner + 4 tasks que envolvem o código existente. Sem UI nova ainda. Workspace actual passa a chamar `agent.run()` internamente. **Critério de sucesso**: comportamento idêntico ao actual, mas com a nova estrutura por baixo.
2. **UI dos 3 estados** — Upload / Working com copy humano / Ready básico. Esconder presets, sliders, AICards, opções de export. Auto-start activo.
3. **Value-receipt** — componente `value-receipt.tsx` com análise inteligente + métricas + tempo poupado + 3 reacções. Migration `pipeline_feedback`.
4. **Refinar com IA** — picker de 4 opções, segunda passada via agent com presets internos diferentes, escape para painel manual.
5. **Histórico como jornada** — labels derivados em vez de "Versão N".

---

## O que NÃO faço agora

- Editing Engine heurístico complexo (Fase 3) — esperar por sinal de `pipeline_feedback`.
- Perfil por utilizador (Fase 4).
- Linguagem natural (Fase 5).
- Apagar código de presets / sliders / AICards.

---

Vou seguir esta ordem assim que aprovares: arquitectura primeiro (sem mudança visível), depois os 3 estados, depois o recibo, depois o refinamento. Confirmas que posso começar pelo passo 1?