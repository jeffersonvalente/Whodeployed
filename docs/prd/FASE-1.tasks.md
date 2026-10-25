# FASE-1 — Tarefas (Motor)

- **Autor:** Arquiteto
- **Entrada:** `docs/prd/FASE-1.md`; SPEC §3, §4, §6; ADR-001
- **Contrato:** `packages/engine/src/types.ts` (compila com `tsc --noEmit`, `strict: true`)
- **ADRs desta fase:** ADR-002 (estrutura e mundo), ADR-003 (determinismo), ADR-004 (FaultKind), ADR-005 (telemetria/NDJSON/fixtures), ADR-006 (perguntas), ADR-007 (CLI e pacote), ADR-008 (qualidade e CI)

Regras para todas as tarefas:

- Dono `motor`, pacote `packages/engine` (abreviado `engine`), branch `engine/T1.n-slug`, um PR por tarefa.
- **Determinismo por seed (SPEC §3.3) é critério de toda tarefa**: o PR inclui teste em que a mesma seed/entrada produz saída idêntica (byte a byte quando há serialização), e nenhum uso de `Math.random`/relógio (D-4). Na tabela isso aparece como `DET`.
- Nenhuma tarefa introduz backend, rede ou I/O em runtime na biblioteca (SPEC §3.6, D-5, CT-3).
- Só T1.1 adiciona dependências e scripts ao `package.json` e ao `pnpm-lock.yaml`. Só T1.1 e T1.15 editam `src/index.ts`. Ninguém edita `src/types.ts` (pedido ao Arquiteto). Ninguém edita `src/world/default-shop.ts` depois de T1.3 (números fixos em ADR-002 §6).
- Cobertura ≥ 80% em `src/sim/**` e `src/faults/**` vale em todo PR a partir de T1.1 (QC-1).

## Tabela de tarefas

| ID | Tarefa | Pacote | Dono | Depende de | Critério do PRD que atende |
| --- | --- | --- | --- | --- | --- |
| T1.1 | Scaffolding do pacote: package.json (bin, files, scripts, devDeps), lockfile, tsconfig/tsconfig.build, Vitest com thresholds, ESLint com regras de determinismo, `src/index.ts`, `src/faults/catalog.ts` (dados ADR-004), registry + 6 módulos de falha no-op, registry + stub do dispatcher `ask` + 6 stubs de pergunta, README stub, testes de contrato e de fronteira, LICENSE, CI com typecheck | engine | motor | — | CT-1, CT-2, CT-3, F-1, D-4, QC-1, PUB-2 (campos), DET |
| T1.2 | PRNG `mulberry32` + `xmur3` e `createRngFactory` com streams por chave | engine | motor | T1.1 | D-1, D-2, D-4, DET |
| T1.3 | `SystemDefinition` `default-shop` (ADR-002 §6), `buildWorld(system, seed)` e validação de sistema | engine | motor | T1.1 | W-1, W-2, W-3 (dado de entrada), DET |
| T1.4 | `EngineError` e `resolveFaults` (padrões do catálogo + validação de kind, alvo, params, startTick) | engine | motor | T1.1 | F-7, Q-10 (classe de erro), CLI-2 (sobrescrita), DET |
| T1.5 | Serializador NDJSON canônico (ordem de chaves, omissão de opcionais) | engine | motor | T1.1 | CLI-1 (formato), W-4, D-1, D-2, DET |
| T1.6 | `deriveMetrics`: métricas de request derivadas de spans server (instância e agregado), nearest-rank, modelo de recursos com `ResourceEffect` | engine | motor | T1.1 | S-1, P-1, P-2, W-4, DET |
| T1.7 | `generateLogs`: um log `error` por span com erro, logs de falha, logs info amostrados, vocabulário de nível | engine | motor | T1.1 | S-2, P-3, DET |
| T1.8 | `createTelemetryStore`: `TelemetryView` indexado por componente/tick/trace | engine | motor | T1.1 | Q-3 (leitura pura), Q-4, Q-5, Q-7 (base), DET |
| T1.9 | Handlers `dashboard`, `logs` (com filtro) e `whatChanged` contra `TelemetryView` | engine | motor | T1.1 | Q-4, Q-5, Q-7, DET |
| T1.10 | Handlers `trace` (nearest-rank, foco + árvore) e `compare` (`instance`, `lastWeek`) | engine | motor | T1.1 | Q-6, Q-8, DET |
| T1.11 | Handler `askNpc` (hints estruturados por papel, sem prosa) | engine | motor | T1.1 | Q-9, DET |
| T1.12 | CLI: parser de argv sobre `node:util.parseArgs`, sintaxe de `--fault`, texto de help gerado do catálogo | engine | motor | T1.1 | CLI-2, CLI-3 (erros de parse), CLI-4, D-5, DET |
| T1.13 | Script verificador independente `scripts/verify-coherence.mjs` (P-1, P-2, P-3, S-3 a partir do NDJSON) | engine | motor | T1.1 | P-4, DET |
| T1.14 | `generateTraffic`: ingress, balanceamento, árvore de chamadas, timeouts, retries, cache/onMiss, waits, hooks `onServe`/`onCall`, spans + `ErrorDetail` | engine | motor | T1.2, T1.3 | S-3, P-1 (spans completos), H4 (propagação), DET |
| T1.15 | Orquestrador: `createSimulation`/`advance`/`simulate`, gating e composição de hooks, noise, ordem canônica, `src/index.ts` público | engine | motor | T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8, T1.14 | W-3 (execução), W-4, F-2 (genérico), S-4, D-1 (biblioteca), DET |
| T1.16 | `ask()`: validação de Question, dispatcher, tabela de `tickCost`, simulação `lastWeek` lazy; fixtures `fixtures/answers/*.json` | engine | motor | T1.9, T1.10, T1.11, T1.15 | Q-1, Q-2, Q-3, Q-10, Q-8 (seed derivada), DET |
| T1.17 | Falha `service_crash_loop` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 1), F-4, DET |
| T1.18 | Falha `disk_full` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 2), F-4, DET |
| T1.19 | Falha `connection_pool_exhaustion` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 3), F-4, DET |
| T1.20 | Falha `bad_deploy` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 4), F-4, F-5, S-4 (evento de falha), DET |
| T1.21 | Falha `slow_dependency` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 5), F-4, DET |
| T1.22 | Falha `cache_cold_start` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 7), F-4, DET |
| T1.23 | CLI `main`: comando `simulate`, NDJSON no stdout, códigos de saída, help | engine | motor | T1.5, T1.12, T1.15 | CLI-1, CLI-2, CLI-3, CLI-4, D-1, D-5, DET |
| T1.24 | Suíte de propriedades de coerência (≥ 100 seeds × baseline + 6 kinds × 30 ticks) | engine | motor | T1.15 | P-1, P-2, P-3, S-1, S-2, S-3, W-4, DET |
| T1.25 | Suíte multi-falha e variação de seed | engine | motor | T1.17, T1.19 | F-6, S-5, D-1, DET |
| T1.26 | CI do engine: `scripts/ci-engine.sh` (D-1, D-2, CLI-3, CLI-4, CLI-5, P-4) + `scripts/pack-smoke.sh` (PUB-1) + workflow | engine | motor | T1.13, T1.23 | QC-2, D-1, D-2, CLI-3, CLI-4, CLI-5, PUB-1, PUB-2 (checagem), P-4, DET |
| T1.27 | Fixtures de telemetria: 7 NDJSON de 60 ticks, `scripts/gen-fixtures.mjs`, teste de regeneração | engine | motor | T1.17, T1.18, T1.19, T1.20, T1.21, T1.22, T1.23 | D-3, DET |
| T1.28 | `packages/engine/README.md`: instalação, CLI com os 6 kinds, exemplo de biblioteca com `ask()`, seed e tick | engine | motor | T1.16, T1.23 | PUB-3, DET |
| T1.29 | Publicação no canal decidido pelo Diretor | engine | motor | T1.26, T1.27, T1.28, **B-1 (Diretor)** | PUB-4, DET |

Não são tarefas de engenharia (registrados para o gate): **QC-3** (proteção de branch, Diretor configura), **G-1** (leitores do GATE-0, Diretor), **B-1** (canal de publicação, Diretor).

## Ondas de paralelismo

| Onda | Tarefas (rodam em paralelo) | Liberada quando |
| --- | --- | --- |
| 0 | T1.1 | — |
| 1 | T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8, T1.9, T1.10, T1.11, T1.12, T1.13 | T1.1 mergeada |
| 2 | T1.14 | T1.2 e T1.3 |
| 3 | T1.15 | onda 1 (T1.4–T1.8) e T1.14 |
| 4 | T1.16, T1.17, T1.18, T1.19, T1.20, T1.21, T1.22, T1.23, T1.24 | T1.15 (T1.16 também precisa de T1.9–T1.11; T1.23 de T1.5 e T1.12) |
| 5 | T1.25, T1.26, T1.27, T1.28 | dependências da tabela |
| 6 | T1.29 | B-1 resolvido pelo Diretor |

Caminho crítico: T1.1 → T1.2/T1.3 → T1.14 → T1.15 → T1.17..T1.22 → T1.27. As tarefas de pergunta (T1.9–T1.11), CLI (T1.12), verificador (T1.13) e os módulos de suporte (T1.4–T1.8) ficam fora dele.

## Arquivos tocados por tarefa

Arquivos "novo" não existem antes; "substitui corpo" é um stub criado por T1.1 que só aquela tarefa reescreve.

| ID | Arquivos |
| --- | --- |
| T1.1 | `packages/engine/{package.json, tsconfig.json (edita), tsconfig.build.json, vitest.config.ts, eslint.config.js, LICENSE, README.md (stub)}`, `pnpm-lock.yaml`, `packages/engine/src/index.ts`, `src/faults/{catalog,registry}.ts`, `src/faults/{service_crash_loop,disk_full,connection_pool_exhaustion,bad_deploy,slow_dependency,cache_cold_start}.ts` (stubs no-op), `src/questions/{registry,ask,dashboard,logs,whatChanged,trace,compare,askNpc}.ts` (stubs), `test/{contract.types,boundaries,catalog}.test.ts`, `.github/workflows/ci.yml` (passo `typecheck`) |
| T1.2 | novo `src/sim/rng.ts`, `test/sim/rng.test.ts` |
| T1.3 | novo `src/world/{default-shop,build}.ts`, `test/world/*.test.ts` |
| T1.4 | novo `src/errors.ts`, `src/faults/resolve.ts`, `test/faults/resolve.test.ts`, `test/errors.test.ts` |
| T1.5 | novo `src/sim/serialize.ts`, `test/sim/serialize.test.ts` |
| T1.6 | novo `src/sim/metrics.ts`, `test/sim/metrics.test.ts` |
| T1.7 | novo `src/sim/logs.ts`, `test/sim/logs.test.ts` |
| T1.8 | novo `src/sim/store.ts`, `test/sim/store.test.ts` |
| T1.9 | substitui corpo `src/questions/{dashboard,logs,whatChanged}.ts`; novo `test/questions/{dashboard,logs,whatChanged}.test.ts` |
| T1.10 | substitui corpo `src/questions/{trace,compare}.ts`; novo `test/questions/{trace,compare}.test.ts` |
| T1.11 | substitui corpo `src/questions/askNpc.ts`; novo `test/questions/askNpc.test.ts` |
| T1.12 | novo `src/cli/{args,help}.ts`, `test/cli/args.test.ts` |
| T1.13 | novo `scripts/verify-coherence.mjs`, `test/scripts/verify-coherence.test.ts`, `test/scripts/samples/*.ndjson` (pequenos, feitos à mão) |
| T1.14 | novo `src/sim/traffic.ts`, `test/sim/traffic.test.ts` |
| T1.15 | novo `src/sim/{hooks,simulation}.ts`, `test/sim/{hooks,simulation}.test.ts`; edita `src/index.ts` |
| T1.16 | substitui corpo `src/questions/ask.ts`; novo `src/questions/validate.ts`, `test/questions/{ask,validate}.test.ts`, `fixtures/answers/*.json` |
| T1.17–T1.22 | substitui corpo `src/faults/<kind>.ts`; novo `test/faults/<kind>.test.ts`; pode editar só a linha do seu kind em `src/faults/catalog.ts` e a linha correspondente na tabela de ADR-004 se ajustar default/faixa |
| T1.23 | novo `src/cli/main.ts`, `test/cli/main.test.ts` |
| T1.24 | novo `test/properties/coherence.test.ts` |
| T1.25 | novo `test/properties/{multi-fault,seed-variation}.test.ts` |
| T1.26 | novo `scripts/{ci-engine,pack-smoke}.sh`; edita `.github/workflows/ci.yml` |
| T1.27 | novo `fixtures/{baseline,service_crash_loop,disk_full,connection_pool_exhaustion,bad_deploy,slow_dependency,cache_cold_start}.ndjson`, `scripts/gen-fixtures.mjs`, `test/fixtures.test.ts` |
| T1.28 | edita `packages/engine/README.md` (stub criado em T1.1) |
| T1.29 | edita `packages/engine/package.json` (só `name`/`publishConfig`, conforme B-1) |

Conflitos residuais conhecidos: T1.15 já chama o stub `src/questions/ask.ts` (criado em T1.1), então T1.16 não toca `simulation.ts`; T1.17–T1.22 em `catalog.ts`/ADR-004 só se ajustarem padrões, cada uma na sua linha (merge textual trivial).

## Critérios de aceite por tarefa

Todas: lint, typecheck e testes verdes; cobertura de `sim`/`faults` ≥ 80%; checklist de PR preenchido; `DET` provado.

- **T1.1** — `pnpm install --frozen-lockfile` funciona na raiz; `pnpm --filter ./packages/engine {lint,typecheck,test,build}` saem 0. `test/contract.types.test.ts` faz `expectTypeOf<X>().toEqualTypeOf<CópiaLiteralDoSpec>()` para `World`, `Fault`, `Question`, `Answer`, `Action` e afirma os 6 membros de `FaultKind` (CT-1, F-1). `test/boundaries.test.ts` cobre CT-3, D-4, S-5 (grep) e Q-1 (grep). `vitest.config.ts` tem thresholds 80/80/80/80 em `src/sim/**` e `src/faults/**` (QC-1). `package.json`: `license`, `bin.whodeployed-engine`, `files`, versão `0.1.0-alpha.0`, `dependencies` vazio, sem `private` (PUB-2, ADR-007). `catalog.ts` transcreve ADR-004 e `test/catalog.test.ts` confere defaults dentro das faixas. DET: lint rejeita `Math.random` em `src/` (teste com arquivo-amostra) e o teste de fronteira roda em CI.
- **T1.2** — Mesma seed+chave ⇒ mesma sequência; chaves diferentes ⇒ sequências diferentes; consumir um stream não altera outro; `int`/`chance`/`pick` nos limites; vetor de referência fixo (primeiros 5 valores de `('s', 'k')`) versionado no teste. DET: o próprio módulo.
- **T1.3** — W-1 (conjuntos exatos), W-2 (≥ 3 instâncias por serviço; ids iguais em duas construções), números idênticos à ADR-002 §6; `buildWorld` rejeita sistema inválido (`invalid_system`: nome duplicado, alvo de chamada inexistente, `onMiss` fora de cache, `replicas < 1`); W-3: mundo de 2 serviços + 1 dependência é aceito. DET: duas construções com a mesma seed são `toStrictEqual`.
- **T1.4** — Cada caso de F-7 (alvo inexistente, alvo de tipo não aceito pelo `targetRule`, kind desconhecido, param desconhecido, fora de faixa, não inteiro, `startTick` negativo ou não inteiro) lança `EngineError` com `code`, `field` e `validValues`, mensagem citando o campo. Defaults preenchidos; `affectedInstances.max` efetivo = réplicas − 1. DET: mesma entrada ⇒ mesmo `Fault[]`.
- **T1.5** — Ordem de chaves da ADR-005 por tipo; opcionais ausentes omitidos; números via `JSON.stringify`; teste de golden string por tipo. DET: serialização igual sob `TZ`/`LANG` diferentes (teste muda `process.env.TZ` e compara).
- **T1.6** — P-1/P-2 por construção em testes com spans sintéticos (inclui n = 0, empates, um só span); só os 8 nomes de S-1; recursos conforme ADR-005, `connectionsCap` aplicado; instância down zerada. DET: mesma entrada + mesma factory ⇒ mesmos registros.
- **T1.7** — P-3 (um log `error` por `ErrorDetail`, mesmo componente/instância/tick/`traceId`); logs de falha preservados na ordem; formato de S-2 validado; níveis ⊂ vocabulário. DET: mesma entrada ⇒ mesma lista.
- **T1.8** — Consultas devolvem exatamente os registros esperados na ordem de inserção; janelas fechadas; `traceOf` completo; `appendTick` rejeita tick fora de ordem. DET: duas lojas com os mesmos appends dão `all()` igual.
- **T1.9** — Q-4 (registros agregados iguais aos da view, janela 30 ticks clampada), Q-5 (window em ticks, filtro por campo de topo e `attrs`, filtro vazio), Q-7 (dentro/fora da janela, deploy e config). DET: mesma view + pergunta ⇒ `Signal` igual.
- **T1.10** — Q-6 nos 3 percentis (foco = nearest-rank; `spans` = trace inteiro; vazio ⇒ `focusSpanId: null`); Q-8 `instance` (uma série por instância) e `lastWeek` (séries `current` e `lastWeek` da view injetada). DET: idem.
- **T1.11** — Q-9: hints mudam entre view baseline e view com anomalia; só identificadores e números; escopo por papel e limiar 0,25 conforme ADR-006; ≤ 3 hints, ordem estável. DET: idem.
- **T1.12** — `parseCliArgs` cobre a sintaxe de `--fault` da ADR-007 (kind puro, com target/startTick/params, repetido); erros de uso (`--seed` ausente, `--ticks` não inteiro/≤ 0/> 100000, par mal formado) lançam `EngineError('usage')`; help contém `--seed`, `--fault`, `--ticks` e os 6 kinds com padrões (CLI-4); só importa `node:util`. DET: mesma argv ⇒ mesmo `CliCommand`.
- **T1.13** — Script sem imports de `src/` nem de pacotes; aprova amostra coerente, reprova amostras com métrica errada, percentil errado, span de erro sem log, filho maior que o pai; exit 0/1 e mensagem no stderr. DET: mesma entrada ⇒ mesma saída do script.
- **T1.14** — Num mundo mínimo e no `default-shop`: uma raiz por trace, filho ≤ pai (S-3), retries até `retries`, timeout corta o servidor com `ok`, miss de cache segue `onMiss`, instância down ⇒ `client` com erro e sem `server`, hooks aplicados (teste com hooks falsos), um `ErrorDetail` por span com erro; ingress do `default-shop` gera ≈ 12 traces/tick. DET: mesma `RngFactory` ⇒ mesmos spans; hooks falsos não alteram streams de tráfego que não usam.
- **T1.15** — `createSimulation` simula o tick 0; `advance` acumula; `simulate(cfg, n)` = ticks `[0, n)`; ordem canônica de ADR-005; W-3 (mundo mínimo, 30 ticks, só seus componentes na telemetria); F-2 com um `FaultModule` de teste; S-4 (2 noises: telemetria sem eventos é byte-idêntica à sem noise); composição de hooks pelas regras de ADR-002 §4. DET: duas execuções em processo ⇒ NDJSON idêntico.
- **T1.16** — Q-1 (6 kinds num mundo recém-criado, nenhum parâmetro de nível), Q-2 (eco profundo da `question`, `tickCost` = tabela da ADR-006), Q-3 (20 perguntas de PRNG de teste intercaladas em 60 ticks: NDJSON idêntico ao sem perguntas; mesma pergunta no mesmo tick ⇒ `Answer` igual), Q-10 (um caso por erro). `lastWeek` = `simulate` com seed `${seed}:lastWeek` (Q-8). Fixtures `fixtures/answers/<kind>.json` (baseline, seed `fixture`, tick 30) com teste de regeneração. DET: os testes acima.
- **T1.17–T1.22** (cada uma no seu kind) — Linha correspondente da tabela "Assinaturas de falha" do PRD (F-3) sobre ≥ 10 seeds, na janela de assinatura, com defaults; F-4 (componente ≠ alvo desvia ≥ 25%) sobre ≥ 10 seeds; F-2 (ticks < `startTick` byte-idênticos ao baseline); semântica da ADR-004; T1.20 também F-5 sobre ≥ 10 seeds e evento `deploy` com `instance` no `startTick`; T1.22 evento `config` com `restart: true` no `startTick`. DET: duas execuções do kind ⇒ NDJSON idêntico; seeds diferentes ⇒ instância/fase afetada pode mudar (onde aplicável).
- **T1.23** — CLI-1 (baseline 10 ticks: toda linha JSON com `type` ∈ {metric, log, span, event}, exit 0), CLI-2 (6 kinds com padrão, uma sobrescrita, duas falhas: exit 0), CLI-3 (kind inválido lista os 6; `--seed` ausente; `--ticks` inválido; alvo inexistente: exit 2, stderr não vazio, stdout vazio), CLI-4; só `node:util`/`node:process` + biblioteca (D-5). DET: duas execuções em processos separados (`spawnSync`) ⇒ mesmo SHA-256.
- **T1.24** — P-1, P-2, P-3 sobre ≥ 100 seeds × (baseline + 6 kinds) × 30 ticks; S-1 (8 métricas para todo componente × instância × tick), S-2 (formato), S-3 (árvores), W-4 (tick inteiro em `[0, ticks)`). Tempo da suíte ≤ 60 s no CI. DET: seeds geradas por PRNG do teste com seed fixa.
- **T1.25** — F-6: duas falhas de kinds diferentes em alvos diferentes (`connection_pool_exhaustion` em `payment` + `service_crash_loop` em `catalog`): ambas as assinaturas F-3 aparecem; S-5: 10 pares de seeds com a mesma falha ⇒ hashes diferentes e ≥ 1 métrica diferente. DET: a execução com duas falhas é byte-idêntica entre duas rodadas.
- **T1.26** — Workflow roda lint, typecheck, test+coverage, build e `scripts/ci-engine.sh` (D-1 por baseline + 6 kinds, D-2, CLI-3, CLI-4, CLI-5 com `timeout 10` e 360 ticks, P-4 com `verify-coherence.mjs` sobre os 6 kinds a 60 ticks) e `scripts/pack-smoke.sh` (PUB-1 com Node 22; lista do tarball conforme PUB-2). Um passo vermelho deixa o check vermelho (QC-2). DET: D-1/D-2 no CI.
- **T1.27** — `ls packages/engine/fixtures/*.ndjson` = 7 arquivos de 60 ticks, cada um ≤ 2 MB, gerados pelos comandos da ADR-005; `test/fixtures.test.ts` regenera em memória e compara byte a byte (D-3). DET: o teste de regeneração.
- **T1.28** — README em inglês com instalação (tarball local e, quando B-1 resolver, canal), uso do CLI com os 6 kinds, exemplo de biblioteca com `createSimulation` + `ask()`, explicação de seed e tick; todo bloco de comando roda verbatim com exit 0 (PUB-3). DET: o README mostra que repetir o comando dá o mesmo hash.
- **T1.29** — Bloqueada por B-1. Roteiro de PUB-1 a partir do canal publicado, saída idêntica (PUB-4). DET: hash igual ao do `$CLI`.

## Rastreabilidade PRD → tarefas

| Critério | Tarefas |
| --- | --- |
| CT-1, CT-2, CT-3 | T1.1 |
| W-1, W-2 | T1.3 |
| W-3 | T1.3, T1.15 |
| W-4 | T1.5, T1.6, T1.15, T1.24 |
| F-1 | T1.1, T1.17–T1.22 |
| F-2 | T1.15, T1.17–T1.22 |
| F-3, F-4 | T1.17–T1.22 |
| F-5 | T1.20 |
| F-6 | T1.15 (composição), T1.25 |
| F-7 | T1.4 |
| S-1 | T1.6, T1.24 |
| S-2 | T1.7, T1.24 |
| S-3 | T1.14, T1.24 |
| S-4 | T1.15, T1.20 |
| S-5 | T1.1 (grep), T1.25 |
| P-1, P-2 | T1.6, T1.24 |
| P-3 | T1.7, T1.24 |
| P-4 | T1.13, T1.26 |
| Q-1 | T1.1 (grep), T1.16 |
| Q-2, Q-3, Q-10 | T1.16 |
| Q-4, Q-5, Q-7 | T1.9 |
| Q-6, Q-8 | T1.10 (Q-8 seed: T1.16) |
| Q-9 | T1.11 |
| D-1 | T1.2, T1.5, T1.15, T1.23, T1.25, T1.26 |
| D-2 | T1.2, T1.5, T1.26 |
| D-3 | T1.27 |
| D-4 | T1.1, T1.2 |
| D-5 | T1.12, T1.23 |
| CLI-1..CLI-4 | T1.12, T1.23, T1.26 |
| CLI-5 | T1.26 |
| PUB-1 | T1.26 |
| PUB-2 | T1.1, T1.26 |
| PUB-3 | T1.28 |
| PUB-4 | T1.29 (bloqueada por B-1) |
| QC-1 | T1.1 (thresholds), todas (manter) |
| QC-2 | T1.26 |
| QC-3, G-1 | Diretor |

## Conferência contra SPEC §3 e §4

| # | Princípio | Como as tarefas respeitam |
| --- | --- | --- |
| 1 | A mecânica é a habilidade | Nenhuma tarefa adiciona pontos, XP ou narrativa; o motor só gera sinais e responde perguntas. `askNpc` devolve dado, não texto (T1.11). |
| 2 | Progressão = perguntas, não ferramentas | Os 6 kinds de `Question` existem desde o tick 0 sem parâmetro de nível (T1.16, Q-1); grep de `junior/pleno/senior/playerLevel` em T1.1. O custo é só `tickCost` (ADR-006). |
| 3 | Telemetria gerada, nunca roteirizada | Toda tarefa tem `DET`; PRNG por streams (T1.2, ADR-003); métricas derivadas dos spans (T1.6, T1.24); retry storm emerge da política de retry (ADR-004, T1.21); grep S-5 (T1.1). |
| 4 | Sinais mentem como na vida real | F-4 em cada tarefa de falha; F-5 em T1.20; `whatChanged` não revela origem falha/noise (ADR-006); `lastWeek` com seed derivada (ADR-003). |
| 5 | Mitigar é válido sem root cause | Efeito das `Action`s está fora da fase 1 (PRD); `Action` existe no contrato (T1.1, CT-1). Nenhuma tarefa impede mitigação futura. |
| 6 | Web-first, zero instalação | Biblioteca sem imports externos nem built-ins (CT-3, T1.1); `dependencies` vazio (ADR-007); nenhuma tarefa cria backend, rede ou I/O; CLI só stdout/stderr. |
| 7 | Conteúdo é dado | `SystemDefinition`, `Fault[]` e `NoiseEvent[]` são entrada (T1.3, T1.15, W-3); parâmetros de falha em catálogo de dados (T1.1); nenhum texto de cenário no motor. |
| 8 | Escopo pequeno e público | 29 tarefas ≤ 1 dia; o motor sozinho é release (PUB-1..PUB-3 sem depender de B-1). |

Escopo SPEC §4: só o sistema `default-shop` com os 9 componentes (T1.3); só as 8 métricas, logs, traces simplificados e eventos de deploy/config (T1.5–T1.7, ADR-005); nada de SLO, OTel/OTLP, alertas, UI, i18n, Grafana/Datadog, backend ou telemetria do jogador. `packages/scenarios` e `apps/web` não são tocados nesta fase (fixtures em `packages/engine/fixtures/` já atendem a UI futura).
