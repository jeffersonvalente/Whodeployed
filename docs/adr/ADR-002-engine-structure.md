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

## Emenda 1 — 2026-10-25 (issue #24, QA da onda 1 e da T1.14)

Registra regras que as tarefas T1.3, T1.8 e T1.14 implementaram e que nenhuma ADR fixava. Nenhuma muda o comportamento de `main`.

### 6.1 Validação do `SystemDefinition` (`buildWorld`, `invalid_system`)

Além das regras da T1.3 (nome duplicado, alvo de chamada inexistente, `onMiss` fora de cache, `replicas < 1`):

- **Nome de componente** casa com `^[A-Za-z0-9][A-Za-z0-9_.-]*$`. A regra exclui `:`, `,`, `=` e espaço, que são separadores do `--fault` (ADR-007), e vale também para os cenários e sistemas das fases 3–4 (o JSON Schema de `packages/scenarios` deve repetir a mesma regex).
- **`cacheHitRatio`** é obrigatório em dependências `kind: 'cache'` (em `[0, 1]`) e proibido nas demais. O tipo em `types.ts` continua opcional; a regra é de validação.
- **Ciclos de chamada são proibidos**, inclusive os que passam por `onMiss` (o grafo considera `calls[].target` e `calls[].onMiss.target`). O tráfego de §5 não termina num ciclo.

### 3.1 Imutabilidade

Registros entregues à store e o `World` exposto são imutáveis (ADR-010). O orquestrador não altera registro depois de `appendTick`, nem `world.services`/`world.deps` depois de `buildWorld`.

### 5.1 Pontos da T1.14 (tráfego)

- **Ingress em instância `down`:** a request de ingress roteada a uma instância fora se perde na borda, sem span, log nem erro; o sinal é a queda do RPS servido (F-3 linha 1). Fica assim nesta fase: o motor não tem telemetria do lado do usuário, e um `service_crash_loop` com alvo `gateway` se manifesta fora do alvo pela queda de RPS dos chamados (F-4). A borda não tenta a próxima instância.
- **Ingress exato:** `ratePerTick` requests por tick, sem jitter (o RPS do gateway no baseline é uma linha de 1.2). Fica exato na fase 1, porque as assinaturas F-3/F-4 e o tamanho dos fixtures (D-3) foram dimensionados com ele. O risco de padrão decorável (SPEC §11) é real quando houver jogador: fica registrado como ponto para o PRD da fase 2 (PM), que decide se o ingress ganha variação seedada antes do protótipo. Mudar exige emenda desta ADR e regeneração de fixtures.
- **Sorteio de hit da cache é feito mesmo quando a chamada não acontece** (por `ratio`): número fixo de sorteios por span server, intencional (ADR-003 §8). Sem efeito no `default-shop` (toda chamada a cache tem `ratio: 1`).

### 7. Erros: `EngineError` × invariantes internas

- `EngineError` (com `EngineErrorCode`) é **só** para entrada vinda de fora do motor: `SystemDefinition`, seed, `FaultInput`, `NoiseEvent`, `Question`, argv do CLI. É o que o CLI mapeia para exit 2 (ADR-007).
- Violação de invariante entre módulos do motor (ex.: `appendTick` fora de ordem, `ErrorDetail` ausente ou órfão, tick negativo vindo do orquestrador) é bug, não entrada inválida: lança `Error` ou `RangeError` nativo, com mensagem prefixada pelo módulo (`TelemetryStore: ...`). Não ganha `EngineErrorCode`. O CLI trata como erro interno (exit 1).
- O que já está em `main` (T1.2, T1.7, T1.8) segue esta regra; nada a mudar.

## Emenda 2 — 2026-10-26 (fase 2; issue #24 itens 1, 2, 3 e 5; PRD FASE-2 I24-1..I24-4)

Registra o que a fase 2 consome e acrescenta. Os itens 2.1–2.3 só registram o comportamento de `main` em `4fe9dce`; o item 2.4 decide uma mudança (tarefa T2.1).

### 2.1 API pública de `src/index.ts` (I24-1; contrato SemVer a partir de `engine-v0.1.0`)

Exportações de **runtime** (a lista que o teste da T2.1 compara com `Object.keys(await import('../src/index.js'))`, em ordem alfabética):

| Nome | Desde | Origem |
| --- | --- | --- |
| `accumulatedImpact` | fase 2 (T2.5) | `sim/impact.ts`, ADR-013 |
| `createSimulation` | 0.1.0 | `sim/simulation.ts` |
| `defaultShop` | 0.1.0 | `world/default-shop.ts` |
| `EngineError` | 0.1.0 | `errors.ts` |
| `faultCatalog` | 0.1.0 | `faults/catalog.ts` |
| `faultKinds` | 0.1.0 | `faults/catalog.ts` |
| `impactOfTick` | fase 2 (T2.5) | `sim/impact.ts`, ADR-013 |
| `isEngineError` | 0.1.0 | `errors.ts` |
| `resolveFaults` | 0.1.0 | `faults/resolve.ts` |
| `serializeRecord` | 0.1.0 | `sim/serialize.ts` |
| `simulate` | 0.1.0 | `sim/simulation.ts` |
| `toNdjson` | 0.1.0 | `sim/serialize.ts` |

Exportações de **tipo**: as seções 1 a 7 de `types.ts`, nomeadas em `index.ts` (seção 1: `World`, `Fault`, `Question`, `Answer`, `Action`; seções 2 a 7 como estão em `index.ts`), mais, desde a fase 2, `SupportedActionKind`, `ActionCostTable`, `ActionResult`, `ImpactTick`, `ImpactOfTick` e `AccumulatedImpact` (ADR-012, ADR-013). As seções 8 (SPI interna) e 9 (CLI) continuam privadas. O método `Simulation.act` (ADR-012) entra pela interface `Simulation`, que já é pública.

Regra: acrescentar nome é mudança *minor*; remover ou mudar assinatura é *major* e pede emenda desta seção. Quem acrescenta uma exportação atualiza esta tabela e o teste no mesmo PR.

### 2.2 `createSimulation` revalida `faults` (I24-2)

`createSimulation` passa `config.faults` por `resolveFaults` mesmo quando já resolvidos: para `Fault` válido é identidade (o QA da T1.15 conferiu, e `resolveFaults` é idempotente sobre a própria saída, inclusive depois da T1.30 com `null`); para entrada inválida, lança o `EngineError` de F-7. É o comportamento desejado: o loader de cenários (ADR-014) entrega `faults` vindos de YAML e conta com esse erro. O comentário de `SimulationConfig.faults` em `types.ts` passou a dizer "resolved or resolvable" (2026-10-26, PR do `FASE-2.tasks.md`).

### 2.3 Limite de ticks da biblioteca (I24-3)

`MAX_TICKS = 100000` (`src/sim/simulation.ts`), o mesmo do CLI (ADR-007). `advance(n)` aceita inteiro em `0..100000`; `simulate(config, n)` aceita inteiro em `1..100000`. Fora disso: `EngineError` com `code: 'invalid_ticks'`, `field: 'ticks'`, `validValues: ['<min>..100000']`. `impactOfTick`/`accumulatedImpact` usam o mesmo código para tick fora de `[0, now]` (ADR-013). O limite é de validação, não de memória: a biblioteca guarda toda a telemetria em memória (ADR-010), e o protótipo nunca passa de 360 ticks (PRD FASE-2 PR-8). O estouro de memória do CLI com `--ticks` alto (#24 item 8) continua fora da fase 2 (PRD).

### 2.4 Ciclo ESM `questions/ask.ts` ↔ `sim/simulation.ts` (I24-4): remover

Decisão: **remover o ciclo**, não só registrar a regra. A fase 2 empacota o motor num bundle de navegador (Vite/Rollup), onde a ordem de avaliação de um ciclo depende do bundler e um uso de nível de módulo vira TDZ em runtime, não em teste.

- `AskEnvironment` (interno, `src/questions/ask.ts`) ganha `createLastWeek: (config: SimulationConfig) => Simulation`. O orquestrador passa `createSimulation` ao montar o ambiente. `ask.ts` deixa de importar `sim/simulation.ts`.
- O comportamento de `lastWeek` (ADR-006 Emenda 1: memoizado por ambiente, avançado até `now`) não muda; os testes de `ask` continuam iguais.
- Regra nova, verificada por teste em `test/boundaries.test.ts`: o grafo de imports relativos de `src/` (exceto `import type`) não tem ciclo.
