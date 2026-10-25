# ADR-002 — Estrutura interna do motor, modelo de mundo e API

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor")
- **Referência:** SPEC §3.3, §3.7, §6; PRD `docs/prd/FASE-1.md` (CT-1, W-1..W-4, F-2, F-6, S-4, Q-3); ADR-001

## Contexto

A fase 1 entrega `packages/engine` com ~30 critérios verificáveis e será implementada em paralelo por várias tarefas `motor`, um PR por tarefa em worktrees separados. Sem um esqueleto fixo de módulos e contratos internos, as tarefas colidem no mesmo arquivo ou esperam umas às outras. O contrato público (SPEC §6) já está fixo; falta decidir tudo o que fica em volta dele.

## Decisão

### 1. Contrato em `src/types.ts`

`packages/engine/src/types.ts` contém só tipos (nenhum código emitido). A seção 1 é cópia literal de SPEC §6 (verificada por CT-1). As seções 2–9 são decisões desta e das ADRs 003–007. Engenheiros não editam `types.ts`; mudança é pedido ao Arquiteto.

### 2. Layout de arquivos

SPEC §6 lista `src/{world,faults,signals,questions,sim}.ts`; aqui cada um vira diretório, para que tarefas paralelas toquem arquivos distintos. QC-1 ("módulos `sim` e `faults`") passa a significar `src/sim/**` e `src/faults/**`.

```
src/types.ts                contrato (Arquiteto)
src/index.ts                API pública: re-exporta seções 1–7 de types.ts + funções públicas
src/errors.ts               class EngineError implements EngineErrorInfo
src/world/default-shop.ts   SystemDefinition 'default-shop' (dado, tabela abaixo)
src/world/build.ts          buildWorld(system, seed) e validação do SystemDefinition
src/sim/rng.ts              PRNG e RngFactory (ADR-003)
src/sim/traffic.ts          GenerateTraffic: requests, árvore de chamadas, spans
src/sim/metrics.ts          DeriveMetrics: métricas derivadas dos spans + modelo de recursos
src/sim/logs.ts             GenerateLogs
src/sim/store.ts            CreateTelemetryStore (TelemetryView indexada)
src/sim/serialize.ts        SerializeRecord / NDJSON canônico (ADR-005)
src/sim/hooks.ts            composição e gating de FaultHooks
src/sim/simulation.ts       createSimulation, simulate (orquestrador do tick)
src/faults/catalog.ts       FaultCatalog: dados da ADR-004 (nomes, padrões, faixas)
src/faults/registry.ts      FaultRegistry: mapeia kind -> módulo
src/faults/resolve.ts       resolveFaults (padrões + validação F-7)
src/faults/<kind>.ts        um arquivo por FaultKind (6)
src/questions/<kind>.ts     um QuestionHandler por kind de Question (6)
src/questions/registry.ts   QuestionRegistry
src/questions/validate.ts   validação de Question (Q-10)
src/questions/ask.ts        dispatcher: valida, chama handler, aplica tickCost, lastWeek
src/cli/                    CLI (fora da fronteira da biblioteca, ADR-007)
test/                       espelha src/
scripts/                    utilitários fora da biblioteca (P-4, smoke de pacote, fixtures)
fixtures/                   telemetria e respostas de referência (ADR-005)
```

Regras anti-conflito: (a) só a tarefa de scaffolding adiciona dependências e scripts ao `package.json` e ao `pnpm-lock.yaml`; (b) o scaffolding pré-cria `catalog.ts`, `registry.ts` e os 6 `faults/<kind>.ts` como módulos no-op (`activate` devolve `{}`), além de `questions/registry.ts`, `questions/ask.ts` e dos 6 `questions/<kind>.ts` como stubs que lançam `Error('not implemented')` (o orquestrador chama `ask.ts` desde o início, então T1.16 só troca o corpo dele); cada tarefa substitui só o corpo do seu arquivo; (c) `src/index.ts` é criado no scaffolding e só a tarefa do orquestrador o edita depois.

### 3. Modelo de execução

- `createSimulation(config)` valida o `SystemDefinition`, constrói o `World` (`tick = 0`), resolve hooks das falhas e simula o tick 0. `advance(n)` simula os ticks seguintes. `simulate(config, ticks)` devolve os registros de `[0, ticks)`.
- Por tick, o orquestrador faz, nesta ordem: (1) `onTick` das falhas ativas → conjunto `down`, eventos e logs de falha; (2) eventos de `noise` do tick; (3) `GenerateTraffic`; (4) `onResources` por instância; (5) `DeriveMetrics`; (6) `GenerateLogs`; (7) monta os registros na ordem canônica (ADR-005) e faz `store.appendTick`.
- **Gating (F-2):** o orquestrador só invoca hooks de uma falha quando `tick >= fault.startTick`. Junto com os streams independentes da ADR-003, isso garante que os registros anteriores a `startTick` são byte-idênticos ao baseline.
- **Noise (S-4):** só gera `EventRecord`; nenhum outro módulo lê `noise`.
- **`ask()` é puro (Q-3):** lê o `TelemetryView`, nunca simula ticks da execução principal nem consome streams dela. O `tickCost` é informado no `Answer`; quem avança o relógio é o chamador (o jogo, na fase 2). A simulação `lastWeek` é outra instância, com seed própria (ADR-003).
- **`Action`:** só tipo nesta fase (fora de escopo do PRD).
- O motor não tem conceito de nível de jogador (Q-1).

### 4. Composição de várias falhas (F-6)

`src/sim/hooks.ts` combina os hooks de todas as falhas, em ordem de índice na lista:

| Hook | Regra de combinação |
| --- | --- |
| `onTick` | `down` = união; `events` e `logs` concatenados na ordem das falhas |
| `onServe` | `addLatencyMs` somado; `fail` = o da primeira falha que falhar |
| `onCall` | `waitMs` somado (`waitOperation` da primeira que definir); `forceCacheMiss` = OU; `fail` = o da primeira |
| `onResources` | `cpuPctAdd`, `memMbAdd`, `connectionsAdd` somados; `connectionsCap` = mínimo |

### 5. Semântica de chamada (usada por `traffic.ts`)

- Balanceamento: round-robin entre todas as instâncias do alvo, com deslocamento inicial por tick sorteado do stream `('lb', tick, component)`. Instância `down` → tentativa falha em 1 ms no chamador (`connection refused`), sem span `server` no alvo.
- Cada tentativa gera um span `client` no chamador (`peer` = alvo) e, se alcançar o alvo, um span `server` filho no alvo. Falha ou timeout de tentativa → nova tentativa até `retries`. Erro final do chamado → o span `server` do chamador fica `error` (propagação), salvo chamadas a cache.
- **Timeout:** o `client` dura no máximo `timeoutMs`; o `server` do alvo (e seus descendentes) é cortado no mesmo instante com status `ok` (cancelamento pelo chamador não é erro do servidor). Isso mantém S-3 (filho ≤ pai).
- **Cache:** miss (pela `cacheHitRatio`, por `forceCacheMiss`, por erro ou timeout da cache) executa `onMiss`. Erro de cache não propaga erro ao chamador.
- `CallEffect.waitMs` vira um span `internal` (`operation = waitOperation`) no chamador antes do `client`; `CallEffect.fail` encerra a tentativa no chamador sem alcançar o alvo.

### 6. Sistema `default-shop` (W-1, W-2; dado em `src/world/default-shop.ts`)

Os números abaixo são fixos nesta fase; as tarefas de falha ajustam seus próprios parâmetros, nunca esta tabela (evita conflito entre PRs paralelos). Mudança = emenda desta ADR pelo Arquiteto.

Serviços (todos com `replicas: 3`, `dbPoolSize: 20`):

| Serviço | ingress (req/tick) | p50/p99 ms | CPU base / por req % | mem MB | Chamadas (`alvo operação ratio timeoutMs retries [onMiss]`) |
| --- | --- | --- | --- | --- | --- |
| gateway | 12, `http.request` | 5 / 20 | 4 / 0.8 | 256 | auth `auth.verify` 1.0 800 1; catalog `catalog.list` 0.6 1000 1; cart `cart.get` 0.3 1000 1; payment `payment.checkout` 0.1 5000 0 |
| auth | — | 8 / 30 | 3 / 0.5 | 192 | redis `session.get` 1.0 100 1 [postgres `db.query` 500 1] |
| catalog | — | 15 / 60 | 5 / 1.0 | 384 | redis `cache.get` 1.0 100 1 [postgres `db.query` 800 1] |
| cart | — | 10 / 40 | 3 / 0.6 | 256 | redis `cart.get` 1.0 100 1 [postgres `db.query` 500 1] |
| payment | — | 40 / 150 | 6 / 2.0 | 320 | postgres `db.insert` 1.0 2000 1; queue `queue.publish` 1.0 500 1 |
| orders-worker | 2, `queue.consume` | 20 / 80 | 4 / 1.5 | 256 | postgres `db.update` 1.0 1000 2 |

Dependências (`replicas: 1`):

| Dependência | kind | p50/p99 ms | CPU base / por req % | mem MB | outros |
| --- | --- | --- | --- | --- | --- |
| postgres | database | 4 / 25 | 10 / 0.3 | 2048 | `maxConnections: 200` |
| redis | cache | 1 / 4 | 2 / 0.05 | 512 | `cacheHitRatio: 0.9`, `maxConnections: 1000` |
| queue | queue | 2 / 8 | 3 / 0.1 | 256 | `maxConnections: 500` |

IDs de instância: `${component}-${index}` (ex.: `payment-0`), estáveis por definição (W-2). Qual instância uma falha afeta vem da seed (ADR-003), não do id.

## Consequências

- Até 12 tarefas da onda 1 rodam em paralelo sem tocar o mesmo arquivo; as 6 falhas também.
- O tráfego é pequeno (≈ 12 req/tick no gateway) para caber no limite de desempenho (CLI-5) e no tamanho dos fixtures (D-3); percentis por tick são calculados sobre poucas amostras, o que é aceitável porque F-3 mede médias na janela de assinatura.
- Um mundo arbitrário (W-3) só precisa de um `SystemDefinition`; nenhum nome de componente aparece em `src/sim/**`.

## Alternativas descartadas

- **Um arquivo por módulo, como em SPEC §6 literal:** seis falhas e seis perguntas no mesmo arquivo gerariam conflitos de merge constantes.
- **Falhas como `if (kind === ...)` dentro do loop de tráfego:** acopla cada falha ao núcleo e impede tarefas paralelas; hooks dão um ponto de extensão estreito.
- **`ask()` avançando o relógio internamente:** misturaria leitura e simulação e quebraria Q-3; o custo em ticks fica no `Answer` e o jogo decide.
