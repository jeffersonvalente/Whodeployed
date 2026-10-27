# ADR-013 — Função de impacto: impacto por tick derivado da telemetria

- **Status:** aceita (valores iniciais; calibração final pela tarefa T2.6, registrada como emenda desta ADR no mesmo PR)
- **Data:** 2026-10-26
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor"; PRD FASE-2 "Impacto = contador por tick definido em ADR pelo Arquiteto, com as restrições de EN-6")
- **Referência:** SPEC §3.3, §3.4, §3.5, §4 ("relógio de impacto"), §7 (`impactBudget`: "ticks até incidente grave"); PRD FASE-2 EN-6, EN-8, PR-5, PR-8, PR-11, R-4, "Mitigação eficaz"; ADR-002, ADR-005, ADR-012

## Contexto

O relógio de impacto (SPEC §4) e o orçamento (`impactBudget`, em ticks, SPEC §7) precisam de uma medida. O PRD exige que ela seja função pura da telemetria, sem conhecer cenário (EN-6), que fique quase sempre parada no baseline (EN-6a: ≤ 1% dos ticks em 10 seeds × 360 ticks), que chegue ao orçamento sem ação em cada YAML da fase (EN-6b) e que noise sozinho não a mova (EN-6c).

## Decisão

### 1. Definição

Impacto é medido do lado de quem usa o sistema: as requests que entram pelos serviços com `ingress` (no `default-shop`: `gateway` e `orders-worker`). Para um tick `t`:

- `expected(t)` = Σ `ingress.ratePerTick` dos serviços com `ingress` (dado do `World`, não do cenário).
- Para cada serviço de entrada `E`: `roots(E, t)` = spans `server` de `E` sem `parentId` com tick `t` (as raízes de trace, ADR-005); `lost(E, t)` = `max(0, ratePerTick(E) − |roots(E, t)|)` (requests perdidas na borda, ADR-002 Emenda 1 §5.1); `bad(E, t)` = `lost(E, t)` + raízes com `status: 'error'` ou `durationMs > SLOW_MS`.
- `bad(t)` = Σ `bad(E, t)`; **o tick é impactado** quando `bad(t) / expected(t) ≥ THETA`. Mundo sem ingress: `expected = 0` e nenhum tick é impactado.
- **Impacto acumulado** até `u` = número de ticks impactados em `[0, u]`. É o número que o protótipo mostra (`impact 4 / 60`) e compara com `impactBudget`. Inteiro, na mesma unidade de `impactBudget` (ticks).

Valores iniciais: `SLOW_MS = 1000`, `THETA = 0,05`.

### 2. API (`types.ts` §6; lista pública na ADR-002 Emenda 2)

- `impactOfTick(view, tick): ImpactTick` — `{ tick, expected, bad, impacted }`; `tick` fora de `[0, view.now]` lança `EngineError` `invalid_ticks`.
- `accumulatedImpact(view, upTo): number` — Σ de `impacted` em `[0, upTo]`.
- Módulo `src/sim/impact.ts` (coberto pelo threshold de `src/sim/**`, EN-8). Só lê a `TelemetryView` (`world`, `spansOf`). Não importa nada de cenário, não tem nível, não usa `Math.random` nem relógio (D-4).
- Desempenho: `accumulatedImpact` sobre 360 ticks percorre os spans de 2 componentes por tick; quem chama a cada passo (o protótipo) pode memoizar por tick, porque um tick passado nunca muda (ADR-010).

### 3. Calibração (tarefa T2.6)

Grade, nesta ordem de preferência: `(SLOW_MS, THETA)` ∈ (1000, 0,05), (1000, 0,10), (2000, 0,05), (2000, 0,10). A tarefa escolhe o primeiro par que cumpre, com as listas de seeds de `test/support/signature.ts`:

1. EN-6(a): baseline, 10 seeds × 360 ticks, impactado em ≤ 1% dos ticks de cada seed.
2. EN-6(c): baseline + noise (≥ 3 eventos `deploy`/`config` em componentes diferentes) dá a mesma série de impacto do baseline, tick a tick.
3. Sanidade por kind (não é EN-6b, que é por YAML e fica com o Eng. Conteúdo): com os defaults da ADR-004, cada kind exceto `cache_cold_start` tem ≥ 1 tick impactado em `startTick..startTick+49` em cada seed.

Medição do Arquiteto com o par inicial (10 seeds `imp-0..9`, defaults, ticks 10–59 = 50 ticks): baseline 0/360 em todas as seeds; `service_crash_loop` 50/50; `disk_full` 45–47; `connection_pool_exhaustion` 28–38; `bad_deploy` 49–50; `slow_dependency` 50/50; `cache_cold_start` 0/50. Se o par inicial cumprir 1–3, fica; o PR registra a medição como "Emenda 1 — calibração".

### 4. Leitura das definições do PRD

- **Grave** (PR-8): acumulado ≥ `impactBudget`.
- **Mitigação eficaz** (PRD, Convenções; R-4; CN-3; CN-5): para uma ação no tick `t` (efeito em `t + 1`, ADR-012), nenhum tick impactado em `[t + 4, t + 33]` simulando sem outra ação. Ou seja, o impacto "para de acumular em até 3 ticks" e "não acumula em nenhum dos 30 ticks seguintes". A janela nunca é truncada: para ação depois do tick 327, a verificação simula além do 360 (o limite 360 é da sessão, ADR-015 §5, não do motor, que aceita até 100 000 ticks).
- **Impacto na mitigação** (PR-11 frase 3, CN-9f, R-4): acumulado em `[0, t]`, `t` = tick da ação eficaz.

## Consequências

- `cache_cold_start` com defaults não gera impacto (o p50 sobe pouco; nenhuma request passa de 1 s nem falha). Não afeta a fase 2 (nenhum cenário usa esse kind; ADR-012 mostra que ele não serve para `TA`/`TB`). O cenário 7 da fase 3 precisa de parâmetros ou de uma emenda desta ADR (por exemplo, um critério de latência relativa).
- Um tick com uma request ruim entre ~14 já passa de 5%. Com tráfego baixo, o impacto de falhas parciais (pool esgotado, `payment` com 10% das requests) acumula em parte dos ticks, não em todos; o `impactBudget` de cada YAML é calibrado pelo Eng. Conteúdo com EN-6(b).
- O `restart` (ADR-012) de um serviço de entrada derruba todas as requests de um tick: conta 1 tick de impacto, o custo de reiniciar às cegas.
- A função não lê métricas, só spans: P-1/P-2 garantem que as métricas dizem o mesmo, e a regra fica auditável a partir do NDJSON.

## Alternativas descartadas

- **Impacto pelo erro % agregado do `gateway` (métrica):** ignora `orders-worker`, ignora a perda na borda (crash loop no `gateway` não gera erro) e ignora lentidão.
- **Impacto ponderado (soma de frações em vez de 0/1 por tick):** o orçamento do SPEC §7 é em ticks; contar ticks deixa a regra e o número da tela legíveis para o júnior.
- **Limiar relativo ao `lastWeek`:** mais robusto, mas dobra o custo de simulação a cada passo no navegador e acopla o impacto a uma segunda execução; os valores absolutos já dão 0% no baseline.
- **Impacto declarado no cenário (YAML diz quando dói):** fere EN-6 e SPEC §3.3.
