## Escopo

Oito pedidos agrupados em 4 frentes. Vou executar em sequência, sinalizando quando precisar de aprovação de migração.

---

### Frente 1 — Logo + idioma (frontend, sem schema)

1. **Wordmark unificado `silyc.`**
   - Extrair `<Wordmark size="sm|md|lg">` em `src/components/wordmark.tsx` usando a mesma fonte display do hero (Syne black) com ponto laranja.
   - Substituir no header (desktop + mobile) e na hero de `src/routes/index.tsx` para garantir um único componente fonte da verdade.

2. **Idioma instantâneo e consistente**
   - `useI18n` já dispara `setLang` localmente; vou:
     - Persistir no `localStorage` ANTES do round-trip ao servidor (já faz) e emitir um `CustomEvent("silyc:lang-changed")` para que abas irmãs sincronizem via `storage` listener.
     - No `onAuthStateChange` (SIGNED_IN/OUT) rehidratar `lang` do `profiles.preferred_language` quando autenticado, ou do `localStorage` quando deslogado.
   - Garantir que o toggle desktop só aparece para visitantes (já feito). Confirmar que mobile mostra apenas dentro do Sheet (já feito) e remover qualquer duplicação remanescente.

---

### Frente 2 — Quotas configuráveis + UI (precisa de migração)

3. **`integration_caps` table** (migração 1)
   - Colunas: `integration text PK`, `hour_limit int`, `day_limit int`, `updated_at`.
   - Seed com Replicate/fal 30/200, Shotstack 10/50.
   - RLS: somente `service_role` e admins (via `has_role`) podem `SELECT/UPDATE`.
   - Atualizar `private.check_and_record_usage` para ler limites da tabela quando os parâmetros passados forem `NULL`, mantendo retrocompatibilidade.

4. **Endpoint de quota restante**
   - Novo `getMyQuota({ integration })` server fn (autenticada) que retorna `{ hour: {used, limit}, day: {used, limit} }` lendo `integration_usage` + `integration_caps`.
   - **Header chip**: ao lado do avatar, um pequeno badge "X/Y" para a integração mais recentemente usada (estado via React Query, refetch on focus).
   - **AuthErrorBoundary (429)**: mostrar painel com `hour_used/hour_limit` e `day_used/day_limit` por provedor + tempo até reset (`window_start + 1h/24h`).

---

### Frente 3 — Admin panel `/admin/usage`

5. **Página admin**
   - Lista uso agregado por `user_id × integration` com filtros: `from/to` (date range), `integration` (multi-select).
   - Tabela mostra: usuário (nome via `profiles`), integração, contagens 1h/24h, total no período.
   - Botão **Export CSV** (gerado no cliente a partir dos dados já carregados).
   - Server fn `getIntegrationUsageAdmin` protegida por `has_role(admin)`.

---

### Frente 4 — Testes

6. **Atomicidade/concorrência** (`rate-limit.concurrency.test.ts`)
   - Teste de integração via psql disparando N chamadas paralelas a `private.check_and_record_usage` e validando que `allowed=true` é retornado exatamente `min(N, hour_limit)` vezes (sem ultrapassar o cap).
   - Requer que `check_and_record_usage` use `INSERT ... RETURNING` numa única transação serializável; vou auditar e ajustar o RPC se necessário (migração 2).

7. **Testes de UI do header** (`site-header.test.tsx` com Testing Library)
   - Renderiza deslogado: mostra "Entrar" + toggle PT/EN no desktop.
   - Renderiza logado: avatar + dropdown contém "Preferências → Idioma", toggle desktop ausente.
   - Mobile Sheet: idioma aparece uma única vez.

---

## Ordem de execução

1. Frente 1 (logo + idioma) — 1 turno, sem aprovação.
2. Migração 1 (`integration_caps` + ajuste do RPC para fallback dos limites) — pede aprovação.
3. Frente 2 código (quota fn, header chip, 429 expandido) — 1 turno.
4. Frente 3 (admin panel + export CSV) — 1 turno.
5. Migração 2 (se preciso reforçar atomicidade, ex.: `READ COMMITTED` + `INSERT`+`COUNT` na mesma transação com lock) — pede aprovação só se a auditoria detectar gap.
6. Frente 4 testes — 1 turno final, validando 9 + 4 + novos.

## Detalhes técnicos

- **Atomicidade**: o RPC atual roda `SELECT count` + `INSERT`. Sob concorrência alta dois callers podem ler `count=29` e ambos inserir → cap 30 vira 31. Para garantir atomicidade, vou trocar pelo padrão `INSERT ... ; SELECT count` na mesma transação e comparar APÓS inserir (estilo "insert-then-check, rollback if exceeded"). Isso usa o lock do próprio insert e mantém custo baixo. Migração 2 só se a auditoria confirmar a janela de corrida.
- **Caps configuráveis**: o middleware `rateLimit(provider)` continua chamando o RPC, mas sem passar `_hour_limit/_day_limit` — o RPC faz `coalesce` com `integration_caps`.
- **CSV**: gerado no cliente (`Blob`) para evitar streaming pelo Worker.

## Fora de escopo

- Billing/UI para o admin editar caps direto na tabela (read-only nesta rodada; edição manual via Supabase tools por enquanto). Posso adicionar form de edição como follow-up se quiser.
