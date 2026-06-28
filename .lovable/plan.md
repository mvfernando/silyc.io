## Objetivo

Tirar do usuário a tarefa de "adivinhar" threshold, min pause, padding e preset. A IA lê o áudio, transcreve com timestamps por palavra e decide os cortes respeitando o início/fim real da fala. Sliders e presets continuam existindo, mas escondidos atrás de "Avançado" — o fluxo padrão vira **um botão: "Cortar automaticamente"**.

## O que já temos hoje

- **Detecção heurística de silêncio** via FFmpeg.wasm (`silencedetect`) com threshold/min pause/padding configuráveis.
- **Timeline interativa** que mostra cortes (vermelho), kept (verde), overrides manuais (amarelo), com prévia A/B do intervalo selecionado.
- **Replicate integrado** (token + edge function) para o `resemble-ai/resemble-enhance` de otimização de áudio.
- **Presets salvos**, recuperação de sessão, histórico de versões, render local + nuvem (Shotstack), exportação com codec/bitrate.
- **Validação prévia** do arquivo (formato, áudio, duração) e error mapper com causas/ações.

## O que falta para o "Modo Auto" funcionar

### 1. Transcrição com timestamps por palavra (Replicate Whisper)
- Nova server function `transcribeForCuts` que chama `openai/whisper` (ou `vaibhavs10/incredibly-fast-whisper` — 10× mais rápido) no Replicate.
- Saída esperada: `{ words: [{ text, start, end, confidence }], language }`.
- O arquivo de vídeo é enviado via signed URL do Supabase Storage (já fazemos upload hoje), Replicate aceita vídeo direto e extrai o áudio.
- Cache: hash SHA-256 do arquivo → resultado salvo numa nova tabela `transcriptions` para evitar reprocessar o mesmo vídeo.

### 2. Algoritmo "palavra-a-palavra" para decidir cortes
Substituir a derivação atual (gaps de silêncio brutos) por uma que respeita fala:
- Para cada par de palavras consecutivas, calcular `gap = word[i+1].start − word[i].end`.
- Se `gap > 0.4s` → candidato a corte. Padding automático: 80 ms antes/depois do limite da palavra (nunca cortar dentro do som).
- Confiança baixa (`confidence < 0.5`) → não corta nem mesmo em silêncio, é zona de dúvida.
- Início do vídeo: corta tudo antes da primeira palavra menos 200 ms.
- Fim do vídeo: corta tudo depois da última palavra mais 300 ms.
- Resultado entra no mesmo pipeline já existente (`silences[]`), então toda a UI/timeline/render continua funcionando.

### 3. Detecção de fillers (opcional, toggle)
- Whisper devolve as palavras transcritas — comparar contra lista por idioma (PT: "é", "tipo", "né", "ahn", "hum"; EN: "um", "uh", "like", "you know").
- Cada filler vira um silence range adicional. Usuário pode rever na timeline antes de exportar (já temos override por clique).

### 4. UI: "Cortar automaticamente" como caminho padrão
- Botão grande "Cortar automaticamente com IA" no topo do workspace, depois do upload.
- Mostra estado em duas etapas: **Transcrevendo → Decidindo cortes → Pronto para revisar**.
- Estimativa de créditos antes (Whisper ~$0.006/min) e custo real depois.
- Painel "Avançado" colapsado por padrão com os sliders, presets e toggle "preferir silêncio bruto (FFmpeg)" para quem não quiser usar a IA.

### 5. Tabela `transcriptions` (cache + histórico)
```
file_hash text primary key
user_id uuid
duration_seconds numeric
language text
words jsonb          -- [{text, start, end, confidence}]
model text           -- "incredibly-fast-whisper@v1"
created_at timestamptz
```
RLS: usuário só lê/escreve as suas. GRANT padrão para `authenticated`.

### 6. Fallback e robustez
- Se Replicate falhar (timeout, 402, 500) → cai automaticamente para o detector FFmpeg atual, registra no log do job ("Auto-mode indisponível, usando detecção de silêncio").
- Já temos backoff exponencial no Shotstack — reaproveitamos o mesmo helper.
- Vídeos > 30 min: avisa o custo (~$0.18 a $0.30) antes de disparar.

## O que NÃO muda

- Timeline interativa, overrides manuais, prévia de intervalo, render local/cloud, exportação, histórico, audio enhancement e color grading continuam exatamente como estão.
- Sliders e presets ficam — só somem do caminho principal. Quem quiser refinar, abre "Avançado".

## Decisão sobre os outros dois pedidos

Excluir/renomear/duplicar presets continua fazendo sentido para o modo Avançado. **Sugiro pausar** essa parte até decidirmos o modo Auto, porque se 90% dos usuários nunca abrir "Avançado", manter três operações em presets vira ruído. Se quiser, eu implemento depois do Auto Mode.

## Ordem de implementação sugerida

1. Tabela `transcriptions` + RLS + GRANT.
2. Server function `transcribeForCuts` (Replicate + cache).
3. Conversor `words → silences[]` com regras de limite de palavra.
4. Toggle de fillers por idioma.
5. UI "Cortar automaticamente" + colapsar Avançado.
6. Telemetria de custo real e fallback para FFmpeg.

## Pergunta antes de seguir

Confirma 3 coisas:
1. **Modelo Whisper**: posso usar `vaibhavs10/incredibly-fast-whisper` (mais rápido e barato) em vez do `openai/whisper` oficial?
2. **Fillers**: liga por padrão ou deixa como toggle desligado?
3. **Presets**: implemento as três operações (excluir/renomear/duplicar) agora junto, ou só depois que o Modo Auto estiver pronto?