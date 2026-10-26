# FASE-1 — Tarefas (Motor)

- **Autor:** Arquiteto
- **Entrada:** `docs/prd/FASE-1.md`; SPEC §3, §4, §6; ADR-001
- **Contrato:** `packages/engine/src/types.ts` (compila com `tsc --noEmit`, `strict: true`)
- **ADRs desta fase:** ADR-002 (estrutura e mundo), ADR-003 (determinismo), ADR-004 (FaultKind), ADR-005 (telemetria/NDJSON/fixtures), ADR-006 (perguntas), ADR-007 (CLI e pacote), ADR-008 (qualidade e CI), ADR-009 (canal de publicação), ADR-010 (imutabilidade da telemetria)
- **ADR-009 revista (2026-10-26, Diretor; #58):** asset = `pnpm --dir packages/engine pack --pack-destination dist/`; a T1.29 não publica Release (artifact de CI + README + instalação isolada); Release e tag `engine-v0.1.0` com o agente Release após GATE-1
- **Emendas da onda 1 (issue #24):** ADR-002, ADR-003, ADR-004, ADR-005, ADR-006 e ADR-007 têm "Emenda 1"; as notas por tarefa estão em "Notas da onda 1" no fim deste arquivo
- **Emenda 2 do PRD (PR #46, R1–R5 e E1–E4):** ADR-004 tem "Emenda 2" (defaults de `disk_full` e `connection_pool_exhaustion`); tasks T1.33–T1.37; notas em "Notas da Emenda 2" no fim deste arquivo
- **ADR-005 Emenda 2 (bloqueio da T1.27):** orçamento dos fixtures sobe para 3 MiB por arquivo; nota na T1.27 em "Notas da Emenda 2"
- **ADR-004 Emenda 3 (issues #62, #63, #66) e ADR-007 Emenda 2 (#58):** `disk_full.failRatio` 0,9; nova curva de miss de `cache_cold_start`; regra de robustez (0 violação em 20 000 seeds); isenção R6 proposta ao PM para pool sem request; comando de pack. Notas em "Notas da Emenda 3" no fim deste arquivo

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
| T1.16 | `ask()`: validação de Question, dispatcher, tabela de `tickCost`, `QuestionContext` a partir de `AskEnvironment`, `lastWeek` lazy memoizado e ≥ `now`; nearest-rank único; teste de desempate (#21); fixtures `fixtures/answers/*.json` | engine | motor | T1.9, T1.10, T1.11, T1.15 | Q-1, Q-2, Q-3, Q-6 (desempate), Q-10, Q-8 (seed derivada), DET |
| T1.17 | Falha `service_crash_loop` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 1), F-4, DET |
| T1.18 | Falha `disk_full` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 2), F-4, DET |
| T1.19 | Falha `connection_pool_exhaustion` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 3), F-4, DET |
| T1.20 | Falha `bad_deploy` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 4), F-4, F-5, S-4 (evento de falha), DET |
| T1.21 | Falha `slow_dependency` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 5), F-4, DET |
| T1.22 | Falha `cache_cold_start` | engine | motor | T1.15 | F-1, F-2, F-3 (linha 7), F-4, DET |
| T1.23 | CLI `main`: comando `simulate`, NDJSON no stdout, códigos de saída, help; `args.ts` com `EngineError` compartilhado (#15) e `params` sem protótipo (#22) | engine | motor | T1.5, T1.12, T1.15 | CLI-1, CLI-2, CLI-3, CLI-4, F-7 (via CLI), D-1, D-5, DET |
| T1.24 | Suíte de propriedades de coerência (≥ 100 seeds × baseline + 6 kinds × 30 ticks), incluindo Q-6 na simulação real e chaves de `attrs` | engine | motor | T1.15 | P-1, P-2, P-3, Q-6 (simulação real), S-1, S-2, S-3, W-4, DET |
| T1.25 | Suíte multi-falha e variação de seed | engine | motor | T1.17, T1.19, T1.33, T1.37, **R6 no PRD (PM)** | F-6, S-5, D-1, DET |
| T1.26 | CI do engine: `scripts/ci-engine.sh` (D-1, D-2, CLI-3, CLI-4, CLI-5, P-4) + `scripts/pack-smoke.sh` (PUB-1) + workflow; verificador rejeita `null` em opcional (ADR-005 Emenda 1) | engine | motor | T1.13, T1.23 | QC-2, D-1, D-2, CLI-3, CLI-4, CLI-5, PUB-1, PUB-2 (checagem), P-4, DET |
| T1.27 | Fixtures de telemetria: 7 NDJSON de 60 ticks (≤ 3 MiB cada, ADR-005 Emenda 2), `scripts/gen-fixtures.mjs`, teste de regeneração e de tamanho, `.gitattributes` do pacote | engine | motor | T1.17, T1.18, T1.19, T1.20, T1.21, T1.22, T1.23, T1.35, T1.36, T1.37 | D-3, DET |
| T1.28 | `packages/engine/README.md`: instalação, CLI com os 6 kinds, exemplo de biblioteca com `ask()`, seed e tick | engine | motor | T1.16, T1.23 | PUB-3, DET |
| T1.29 | Tarball do motor como artifact de CI (`pnpm --dir packages/engine pack --pack-destination dist/`, ADR-009), comando no README e teste de instalação isolada a partir de `packages/engine/dist/*.tgz`; **não** cria Release nem tag | engine | motor | T1.26, T1.27, T1.28 | PUB-4 (roteiro contra o artifact; a parte pública fica com o Release, ADR-009), PUB-2, DET |
| T1.30 | `resolveFaults` rejeita `null` em `target`/`startTick`/`params`/`params.<nome>` (ADR-004 Emenda 1, #23) | engine | motor | T1.4 | F-7, DET |
| T1.31 | `TelemetryStore` congela registros (e `attrs`) e `world` (ADR-010) | engine | motor | T1.8 | Q-3, DET |
| T1.32 | Tráfego: corrigir comentário de isolamento em `traffic.ts` (ADR-003 §8) e acrescentar testes de isolamento, chave `lat` e sorteio fixo de hit da cache | engine | motor | T1.14 | S-3, F-2, DET |
| T1.33 | Helper de teste da regra de agregação por seed (R1–R5) e de elegibilidade F-4 (E1–E4) | engine | motor | — | F-3, F-4, F-5 (leitura R1–R5, E1–E4), DET |
| T1.34 | Testes de `service_crash_loop` e `bad_deploy` com R1–R5 e par F-4 fixo elegível; corrigir comentário de cabeçalho de `service_crash_loop.ts` | engine | motor | T1.33 | F-3 (linhas 1 e 4), F-4, F-5, DET |
| T1.35 | Testes de `slow_dependency` e `cache_cold_start` com R1–R5 e par F-4 fixo elegível; curva de miss de `cache_cold_start` (ADR-004 Emenda 3) e comentário de cabeçalho (p95 → p50, curva nova) | engine | motor | T1.33 | F-3 (linhas 5 e 7), F-4, DET |
| T1.36 | `disk_full`: `failRatio` padrão 0,9 (ADR-004 Emenda 3) e testes com R1–R5 e par F-4 fixo | engine | motor | T1.33 | F-3 (linha 2), F-4, DET |
| T1.37 | `connection_pool_exhaustion`: `leakPerTick` padrão 4 (ADR-004 Emenda 2) e testes com R1–R5 + isenção R6, par F-4 fixo, invariante de esgotamento e caso F-6 com `service_crash_loop`; isenção R6 no helper | engine | motor | T1.33, **R6 no PRD (PM) para o merge** | F-3 (linha 3), F-4, F-6 (com `service_crash_loop`), DET |

Não são tarefas de engenharia (registrados para o gate): **QC-3** (proteção de branch, Diretor configura), **G-1** (leitores do GATE-0, Diretor), **B-1** (canal de publicação, Diretor).

## Ondas de paralelismo

| Onda | Tarefas (rodam em paralelo) | Liberada quando |
| --- | --- | --- |
| 0 | T1.1 | — |
| 1 | T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8, T1.9, T1.10, T1.11, T1.12, T1.13 | T1.1 mergeada |
| 2 | T1.14 | T1.2 e T1.3 |
| 3 | T1.15 | onda 1 (T1.4–T1.8) e T1.14 |
| 4 | T1.16, T1.17, T1.18, T1.19, T1.20, T1.21, T1.22, T1.23, T1.24 | T1.15 (T1.16 também precisa de T1.9–T1.11; T1.23 de T1.5 e T1.12) |
| 4′ | T1.30, T1.31, T1.32 | já liberadas (dependências em `main`); rodam em paralelo com T1.15 e a onda 4 e não bloqueiam nenhuma tarefa |
| 5 | T1.25, T1.26, T1.27, T1.28 | dependências da tabela |
| 6 | T1.29 | T1.26, T1.27 e T1.28 em `main` (B-1 resolvido: ADR-009) |
| E2-a | T1.33 | já liberada (PRD Emenda 2 em `main`); roda em paralelo com a onda 5 |
| E2-b | T1.34, T1.35, T1.36, T1.37 | T1.33 mergeada; as quatro em paralelo (arquivos disjuntos, exceto linhas próprias em `catalog.ts`/`catalog.test.ts`/ADR-004) |

Caminho crítico: T1.1 → T1.2/T1.3 → T1.14 → T1.15 → T1.17..T1.22 → T1.27; desde a Emenda 2: T1.33 → T1.36/T1.37 → T1.27 (e T1.37 → T1.25). As tarefas de pergunta (T1.9–T1.11), CLI (T1.12), verificador (T1.13) e os módulos de suporte (T1.4–T1.8) ficam fora dele.

## Arquivos tocados por tarefa

Arquivos "novo" não existem antes; "substitui corpo" é um stub criado por T1.1 que só aquela tarefa reescreve.

| ID | Arquivos |
| --- | --- |
| T1.1 | `packages/engine/{package.json, tsconfig.json (edita), tsconfig.build.json, tsconfig.node.json, tsconfig.build.cli.json, vitest.config.ts, eslint.config.js, LICENSE, README.md (stub)}`, `package.json` da raiz (scripts `-r --if-present run` e `typecheck`), remoção de `packages/engine/src/.gitkeep`, `pnpm-lock.yaml`, `packages/engine/src/index.ts`, `src/faults/{catalog,registry}.ts`, `src/faults/{service_crash_loop,disk_full,connection_pool_exhaustion,bad_deploy,slow_dependency,cache_cold_start}.ts` (stubs no-op), `src/questions/{registry,ask,dashboard,logs,whatChanged,trace,compare,askNpc}.ts` (stubs), `test/{contract.types,boundaries,catalog}.test.ts`, `.github/workflows/ci.yml` (passo `typecheck` e correções do workflow: sem `version: 9`, `--if-present`) |
| T1.2 | novo `src/sim/rng.ts`, `test/sim/rng.test.ts` |
| T1.3 | novo `src/world/{default-shop,build}.ts`, `test/world/*.test.ts`; `src/errors.ts` (cópia idêntica à da T1.4, criada porque T1.3 não dependia de T1.4; merge trivial). Regra daqui em diante: quem precisa de `EngineError` depende de T1.4 |
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
| T1.16 | substitui corpo `src/questions/ask.ts`; novo `src/questions/validate.ts`, `test/questions/{ask,validate}.test.ts`, `fixtures/answers/*.json`; edita `src/sim/metrics.ts` (só exporta `nearestRankIndex` e a usa em `nearestRank`), `src/questions/trace.ts` (usa `nearestRankIndex`), `test/questions/trace.test.ts` (#21), `test/sim/metrics.test.ts` (casos de `nearestRankIndex`) |
| T1.17–T1.22 | substitui corpo `src/faults/<kind>.ts`; novo `test/faults/<kind>.test.ts`; pode editar só a linha do seu kind em `src/faults/catalog.ts` e a linha correspondente na tabela de ADR-004 se ajustar default/faixa |
| T1.23 | novo `src/cli/main.ts`, `test/cli/main.test.ts`; edita `src/cli/args.ts` e `test/cli/args.test.ts` (#15, #22) |
| T1.24 | novo `test/properties/coherence.test.ts` |
| T1.25 | novo `test/properties/{multi-fault,seed-variation}.test.ts` |
| T1.26 | novo `scripts/{ci-engine,pack-smoke}.sh`; edita `.github/workflows/ci.yml`, `scripts/verify-coherence.mjs` e `test/scripts/verify-coherence.test.ts` (+ amostra `test/scripts/samples/null-instance.ndjson`) |
| T1.27 | novo `fixtures/{baseline,service_crash_loop,disk_full,connection_pool_exhaustion,bad_deploy,slow_dependency,cache_cold_start}.ndjson`, `scripts/gen-fixtures.mjs`, `test/fixtures.test.ts`, `.gitattributes` (raiz do pacote) |
| T1.28 | edita `packages/engine/README.md` (stub criado em T1.1) |
| T1.29 | novo `packages/engine/scripts/pack-artifact.sh`; edita `.github/workflows/ci.yml` (passo depois de `pack-smoke.sh` + `actions/upload-artifact` só com `packages/engine/dist/*.tgz`) e `packages/engine/README.md` (seção do comando de pack). Não toca `package.json` |
| T1.30 | edita `src/faults/resolve.ts`, `test/faults/resolve.test.ts` |
| T1.31 | edita `src/sim/store.ts`, `test/sim/store.test.ts` |
| T1.32 | edita `src/sim/traffic.ts` (só o comentário de cabeçalho sobre isolamento), `test/sim/traffic.test.ts` |
| T1.33 | novo `test/support/signature.ts`, `test/support/signature.test.ts` (nenhum arquivo de `src/`) |
| T1.34 | edita `test/faults/service_crash_loop.test.ts`, `test/faults/bad_deploy.test.ts`, `src/faults/service_crash_loop.ts` (só o comentário de cabeçalho) |
| T1.35 | edita `test/faults/slow_dependency.test.ts`, `test/faults/cache_cold_start.test.ts`, `src/faults/cache_cold_start.ts` (comentário de cabeçalho e a expressão da probabilidade de miss, ADR-004 Emenda 3; nada mais). Não edita ADR-004 (a curva já está na Emenda 3) |
| T1.36 | edita `src/faults/catalog.ts` (só a entrada `disk_full`), `docs/adr/ADR-004-fault-kinds.md` (só a linha `failRatio` da tabela), `test/catalog.test.ts` (só a linha `failRatio`), `test/faults/resolve.test.ts` (só as expectativas de default de `disk_full`, ~l. 224–229), `test/faults/disk_full.test.ts`; `src/faults/disk_full.ts` só se o comentário de cabeçalho citar o default |
| T1.37 | edita `src/faults/catalog.ts` (só a entrada `connection_pool_exhaustion`), `docs/adr/ADR-004-fault-kinds.md` (só a linha `leakPerTick` da tabela), `test/catalog.test.ts` (só a linha `leakPerTick`), `test/faults/connection_pool_exhaustion.test.ts`, `test/faults/resolve.test.ts` (só a expectativa de default de `leakPerTick`, l. 85; desvio já aceito pelo QA no #56), `test/support/signature.ts` e `test/support/signature.test.ts` (só a isenção R6, ADR-004 Emenda 3; nenhuma outra task edita o helper até a T1.37 entrar em `main`); `src/faults/connection_pool_exhaustion.ts` só se o comentário de cabeçalho citar o default |

Conflitos residuais conhecidos: T1.15 já chama o stub `src/questions/ask.ts` (criado em T1.1), então T1.16 não toca `simulation.ts`; T1.16 e T1.24 não tocam os mesmos arquivos; T1.30–T1.32 não tocam arquivo de nenhuma tarefa aberta; T1.17–T1.22 em `catalog.ts`/ADR-004 só se ajustarem padrões, cada uma na sua linha (merge textual trivial). T1.36 e T1.37 editam linhas diferentes de `catalog.ts`, `test/catalog.test.ts` e da tabela de ADR-004 (merge trivial). T1.25 cria `test/properties/multi-fault.test.ts`, que nenhuma task da Emenda 2 toca; ela só passa a importar `test/support/signature.ts`.

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
- **T1.16** — `QuestionContext` montado do `AskEnvironment`, com `lastWeek` memoizado por ambiente e simulado até ≥ `view.now` (ADR-006 Emenda 1: teste que pergunta `compare by lastWeek` no tick 5, avança a execução e pergunta no tick 40, conferindo que a série `lastWeek` cobre a janela inteira e que só uma simulação `lastWeek` foi criada); nearest-rank único (`trace.ts` importa `nearestRankIndex` de `metrics.ts`); #21: teste com `x=20, y=20, a=10, w=30` em ordem de geração, p50 ⇒ `focusSpanId` de `x` (a mutação do comparador de desempate tem que falhar); Q-3 também sobre o `Answer`: escrever em `answer.data.records[0]` lança `TypeError` quando a T1.31 estiver em `main` (antes disso, o teste fica `todo`). Q-1 (6 kinds num mundo recém-criado, nenhum parâmetro de nível), Q-2 (eco profundo da `question`, `tickCost` = tabela da ADR-006), Q-3 (20 perguntas de PRNG de teste intercaladas em 60 ticks: NDJSON idêntico ao sem perguntas; mesma pergunta no mesmo tick ⇒ `Answer` igual), Q-10 (um caso por erro). `lastWeek` = `simulate` com seed `${seed}:lastWeek` (Q-8). Fixtures `fixtures/answers/<kind>.json` (baseline, seed `fixture`, tick 30) com teste de regeneração. DET: os testes acima.
- **T1.17–T1.22** (cada uma no seu kind) — Linha correspondente da tabela "Assinaturas de falha" do PRD (F-3) sobre ≥ 10 seeds, na janela de assinatura, com defaults; F-4 (componente ≠ alvo desvia ≥ 25%) sobre ≥ 10 seeds; F-2 (ticks < `startTick` byte-idênticos ao baseline); semântica da ADR-004; T1.20 também F-5 sobre ≥ 10 seeds e evento `deploy` com `instance` no `startTick`; T1.22 evento `config` com `restart: true` no `startTick`. DET: duas execuções do kind ⇒ NDJSON idêntico; seeds diferentes ⇒ instância/fase afetada pode mudar (onde aplicável).
- **T1.23** — `args.ts` lança o `EngineError` de `src/errors.ts` (sem `CliUsageError`; `instanceof EngineError` nos testes do parser, #15); `--fault bad_deploy:__proto__=1` ⇒ exit 2 com `unknown_param` (#22); `--seed ''` ⇒ exit 2 (`invalid_seed`); todo `EngineError` ⇒ exit 2, outro erro ⇒ exit 1 (ADR-007 Emenda 1). CLI-1 (baseline 10 ticks: toda linha JSON com `type` ∈ {metric, log, span, event}, exit 0), CLI-2 (6 kinds com padrão, uma sobrescrita, duas falhas: exit 0), CLI-3 (kind inválido lista os 6; `--seed` ausente; `--ticks` inválido; alvo inexistente: exit 2, stderr não vazio, stdout vazio), CLI-4; só `node:util`/`node:process` + biblioteca (D-5). DET: duas execuções em processos separados (`spawnSync`) ⇒ mesmo SHA-256.
- **T1.24** — P-1, P-2, P-3 sobre ≥ 100 seeds × (baseline + 6 kinds) × 30 ticks; S-1 (8 métricas para todo componente × instância × tick), S-2 (formato), S-3 (árvores), W-4 (tick inteiro em `[0, ticks)`); Q-6 na simulação real: para cada seed × (baseline + 6 kinds), avançando tick a tick, todo componente e p ∈ {50, 95, 99}, a duração do span de foco do handler `trace` é igual ao pXX do agregado (sem `instance`) no mesmo tick (≥ 10 seeds bastam para esta parte); chaves de `attrs` de todo log casam com `^[A-Za-z_][A-Za-z0-9_]*$` e `message` pertence ao vocabulário fechado (ADR-005 Emenda 1). Tempo da suíte ≤ 60 s no CI. DET: seeds geradas por PRNG do teste com seed fixa.
- **T1.25** — **(ADR-004 Emenda 3: o que está em "Notas da Emenda 3" prevalece sobre este texto.)** F-6: duas falhas de kinds diferentes em alvos diferentes (`connection_pool_exhaustion` em `payment` + `service_crash_loop` em `catalog`): ambas as assinaturas F-3 aparecem, lidas com R1–R5 pelo helper da T1.33 (asserções por seed R3/R4, tetos R5 só na média), com os defaults da T1.37; S-5: 10 pares de seeds com a mesma falha ⇒ hashes diferentes e ≥ 1 métrica diferente. DET: a execução com duas falhas é byte-idêntica entre duas rodadas.
- **T1.26** — Workflow roda lint, typecheck, test+coverage, build e `scripts/ci-engine.sh` (D-1 por baseline + 6 kinds, D-2, CLI-3, CLI-4, CLI-5 com `timeout 10` e 360 ticks, P-4 com `verify-coherence.mjs` sobre os 6 kinds a 60 ticks) e `scripts/pack-smoke.sh` (PUB-1 com Node 22; lista do tarball conforme PUB-2). Um passo vermelho deixa o check vermelho (QC-2). O verificador sai 1 com campo opcional `null` (amostra nova) e mantém exit 2 para uso/leitura (ADR-005 Emenda 1). DET: D-1/D-2 no CI.
- **T1.27** — `ls packages/engine/fixtures/*.ndjson` = 7 arquivos de 60 ticks, gerados pelos comandos da ADR-005; `test/fixtures.test.ts` regenera em memória, compara byte a byte (D-3) e afirma `size ≤ 3_145_728` bytes (3 MiB) por arquivo (ADR-005 Emenda 2; acima do teto, parar e pedir emenda ao Arquiteto, sem mudar formato, ticks ou amostragem). `packages/engine/.gitattributes` com `fixtures/** text eol=lf linguist-generated=true`. NDJSON puro, sem `.gz`; `fixtures/` continua fora de `files` (PUB-2). DET: o teste de regeneração.
- **T1.28** — README em inglês com instalação (tarball local e, quando B-1 resolver, canal), uso do CLI com os 6 kinds, exemplo de biblioteca com `createSimulation` + `ask()`, explicação de seed e tick; todo bloco de comando roda verbatim com exit 0 (PUB-3). DET: o README mostra que repetir o comando dá o mesmo hash.
- **T1.29** — (ADR-009, revista em 2026-10-26.) `scripts/pack-artifact.sh`, rodado da raiz depois do build: falha se já existir `packages/engine/dist/*.tgz`; roda exatamente `pnpm --dir packages/engine pack --pack-destination dist/`; confere que há um só `.tgz` em `packages/engine/dist/` e que suas entradas são só `package.json`, `README.md`, `LICENSE` e `dist/**/*.{js,d.ts}` (PUB-2; o `.tgz` não pode conter outro `.tgz`); copia o tarball para um diretório temporário vazio fora do repo, `npm install` dele, `npx whodeployed-engine simulate --seed pub --fault connection_pool_exhaustion --ticks 30` e compara SHA-256 com `$CLI` (roteiro de PUB-1/PUB-4 contra o artifact). No `ci.yml`, o passo vem depois de `pack-smoke.sh` e anexa `packages/engine/dist/*.tgz` com `actions/upload-artifact` (nome com a versão do pacote). O README do pacote documenta o comando, o caminho de saída e o `rm -rf packages/engine/dist` antes do build para não empacotar um `.tgz` antigo. **Não cria GitHub Release nem tag**: isso é do agente Release, após GATE-1 (tag `engine-v0.1.0`). DET: hash do CLI instalado igual ao do `$CLI`; dois packs de build limpo dão o mesmo SHA-256 do tarball.
- **T1.30** — Os 4 casos da tabela "Entrada ausente vs `null`" da ADR-004 lançam `EngineError` com o `code`, o `field` e os `validValues` da tabela; chave ausente e `undefined` continuam recebendo o default; os testes existentes de F-7 seguem verdes. DET: mesma entrada ⇒ mesmo `Fault[]` ou mesmo erro (`toJSON` igual).
- **T1.31** — Depois de `appendTick`, `Object.isFrozen` vale para todo registro, para o `attrs` de cada log, para `world`, `world.services`, `world.deps` e cada componente; escrever num registro devolvido por qualquer consulta lança `TypeError` e não altera `all()`; `store.world.tick = 42` lança e `now` não muda; `world` troca de snapshot a cada `appendTick`, com o `tick` novo. Testes existentes seguem verdes. DET: duas lojas com os mesmos appends dão `all()` igual (`toStrictEqual`).
- **T1.33** — `test/support/signature.ts` (só teste; de `src/` importa apenas tipos) exporta: `signatureWindow(startTick)` = ticks `startTick+6..startTick+11`; `signatureSeeds(prefix)` = lista fixa de 12 seeds `${prefix}-0..11`, substituída pela lista da variável de ambiente `ENGINE_QA_SEEDS` (separada por vírgula, ≥ 10 seeds distintas; menos que isso lança) para o QA repetir com outra lista sem editar o teste (R1); `windowMean(records, component, metric, window, instance?)` por seed (agregado quando `instance` ausente); `effect(faulted[], base[], cond)` com `cond` ∈ `{ ratioAtLeast: k }`, `{ ppAtLeast: x }`, `{ riseAtLeast: y }` (fração), `{ ratioAtMost: r }`, que aplica R2 (média das seeds) e R3 (piso por seed: `1 + 0,75·(k−1)`, `0,75·x`, `0,75·y`, `1 − 0,75·(1−r)`) e devolve `{ mean, perSeed[], pass, failingSeeds[] }`; `ceiling(faulted[], base[], cond)` só com R2 (R5); `everySeed(predicate)` para R4; `assertEligibleF4({ component, metric }, base[], faulted[], target)`, que aplica E1 (uma das 8 métricas de S-1, agregado), E2 (pisos na média do baseline: RPS ≥ 1 req/s, p50/p95/p99 ≥ 5 ms, conexões ≥ 2, CPU ≥ 5%, memória ≥ 100 MB), E3 (`errorPct` em p.p.: ≥ +5 na média e ≥ +3,75 por seed; demais métricas ≥ 25% na média e ≥ 18,75% por seed, na direção do desvio), E4 (o mesmo par em toda seed) e `component ≠ target`. Mensagem de falha cita a seed e o valor. `signature.test.ts` cobre cada `cond` com séries sintéticas (passa na média e falha por seed; passa por seed e falha na média; baseline 0 em condição de razão lança), os pisos de E2 nos limites e `ENGINE_QA_SEEDS`. DET: funções puras; mesma entrada ⇒ mesmo resultado; sem `Math.random`.
- **T1.34** — `service_crash_loop` (linha 1) e `bad_deploy` (linha 4 e F-5) reescritos sobre o helper da T1.33, com seeds de `signatureSeeds`: R3 nas condições de tamanho (crash loop: erro % do alvo ≥ +20 p.p. **ou** RPS ≤ 50% — a mesma alternativa em toda seed, declarada no teste; chamador direto ≥ +5 p.p.; bad deploy: instância afetada ≥ +10 p.p., agregado ≥ +1 p.p.), R4 nas de existência (log de erro do alvo em cada tick da janela; evento `deploy` com `instance` no `startTick`), R5 nos tetos (demais instâncias ≤ 2 p.p.; agregado ≤ metade da afetada). F-4 com par fixo via `assertEligibleF4`: recomendado (`gateway`, `errorPct`) no crash loop e (`auth`, `rps`) no bad deploy (medidos pelo PM). O comentário de cabeçalho de `service_crash_loop.ts` passa a dizer o que ADR-004 Emenda 2 §4 registra (período 4, 3 réplicas: em 3 de cada 4 ticks exatamente uma instância em pé, em 1 de cada 4 nenhuma; ≥ 1 fora em todo tick); nenhuma linha de código muda. Os testes passam também com `ENGINE_QA_SEEDS` de uma segunda lista de 10 seeds (rodada registrada no PR). DET: os testes de determinismo existentes ficam; F-2 continua.
- **T1.35** — **(ADR-004 Emenda 3: o que está em "Notas da Emenda 3" prevalece sobre este texto.)** `slow_dependency` (linha 5) e `cache_cold_start` (linha 7) sobre o helper: R3 (p95 do alvo lento ≥ 3× → ≥ 2,5× por seed; spans filhos para o alvo ≥ 2× → ≥ 1,75× por seed; RPS de `postgres` ≥ 2× nos 3 primeiros ticks após `startTick` → ≥ 1,75× por seed; p50 de um serviço fixo que usa `redis` ≥ +25% → ≥ +18,75% por seed), R4 (evento `config` com `restart: true` no `startTick`), R5 ("o componente com maior aumento de erro % não é o alvo"; volta a ≤ 1,2× até `startTick + warmupTicks`). F-4 com par fixo via `assertEligibleF4`: recomendado (`gateway`, `p95`) em slow dependency e (`auth`, `p50`) em cache cold start (RPS de `postgres` não é elegível para F-4: ≈ 0,55 req/s no baseline, abaixo do piso E2; continua valendo como condição de F-3). O comentário de cabeçalho de `cache_cold_start.ts` troca "the p95 of every service that uses the cache" por p50 (PRD Emenda 1, ADR-004 Emenda 2 §4); nenhuma linha de código muda. Segunda lista via `ENGINE_QA_SEEDS` registrada no PR. DET: idem T1.34.
- **T1.36** — **(ADR-004 Emenda 3: o que está em "Notas da Emenda 3" prevalece sobre este texto.)** `failRatio` padrão = menor valor de {0,6; 0,7; 0,8; 0,9} que cumpre, em 40 seeds e na lista de `signatureSeeds`, F-3 linha 2 (R4: log de erro em `postgres` em cada tick da janela, em toda seed; R2/R3: erro % de `postgres` ≥ +10 p.p. → ≥ +7,5 por seed; erro % do dependente fixo ≥ +5 p.p. → ≥ +3,75 por seed, com pior seed ≥ +5,6 p.p.) e F-4 com par fixo (recomendado `orders-worker`/`errorPct`, ADR-004 Emenda 2 §2); tabela de medição no PR (valor testado, mínimo e média por seed). `fillTicks` fica 3; faixas não mudam; `traffic.ts`, `default-shop.ts` e a semântica não mudam (se nenhum valor da grade fechar, parar e abrir issue ao Arquiteto). `catalog.ts`, a linha da ADR-004, `catalog.test.ts` e as expectativas de default em `resolve.test.ts` ficam iguais entre si. F-2 segue verde. DET: duas execuções ⇒ NDJSON idêntico; seeds diferentes ⇒ hashes diferentes.
- **T1.37** — **(ADR-004 Emenda 3: o que está em "Notas da Emenda 3" prevalece sobre este texto.)** `leakPerTick` padrão 4, `poolSize` 20 (ADR-004 Emenda 2 §1). Teste fechado do invariante `leakedAt(6, leakPerTick, poolSize) >= poolSize` com os defaults do catálogo. F-3 linha 3 sobre o helper: R4 em toda seed (conexões do alvo = `poolSize` em ≥ 1 tick da janela; no trace p95 do alvo de cada tick da janela com ≥ 1 request do alvo, span `db.acquire` ≥ 50% da raiz), R3 (p95 do alvo ≥ 3× → ≥ 2,5× por seed; p95 do `gateway` ≥ +25% → ≥ +18,75% por seed), R5 (p50 do `gateway` ≤ 1,5× na média). F-4 com par fixo via `assertEligibleF4`, recomendado (`gateway`, `p95`). **Caso F-6 combinado:** a mesma linha 3 com R1–R5 vale com `connection_pool_exhaustion` em `payment` + `service_crash_loop` em `catalog`, ambos com defaults (caso em que 20/2 falhava em 5/40 seeds); a T1.25 continua dona da suíte F-6 completa, este teste só prova que o default fecha o caso. 40 seeds medidas no PR (sozinha e combinada). Faixas e semântica não mudam (se 20/4 não fechar, parar e abrir issue ao Arquiteto). DET: idem T1.36.
- **T1.32** — O comentário de `traffic.ts` diz o que ADR-003 §8 garante (isolamento por tick e por trace, não por componente); o teste `fake hooks do not alter traffic streams…` passa a usar um alvo que não é a última chamada do gateway (ex.: `catalog`) e afirma o que vale (ticks sem falha idênticos; traces do tick podem trocar de instância); teste novo mata a mutação `rng('lat', traceId)` sem `spanSeq`; teste novo fixa o número de sorteios de `('traffic', tick, component)` por span server num mundo com chamada a cache de `ratio < 1`. Nenhuma linha de código de `traffic.ts` muda além do comentário. DET: os testes acima, com seed fixa.

## Rastreabilidade PRD → tarefas

| Critério | Tarefas |
| --- | --- |
| CT-1, CT-2, CT-3 | T1.1 |
| W-1, W-2 | T1.3 |
| W-3 | T1.3, T1.15 |
| W-4 | T1.5, T1.6, T1.15, T1.24 |
| F-1 | T1.1, T1.17–T1.22 |
| F-2 | T1.15, T1.17–T1.22 |
| F-3, F-4 | T1.17–T1.22; leitura R1–R5/E1–E4: T1.33 (helper), T1.34–T1.37 |
| F-5 | T1.20, T1.34 (R1–R5) |
| F-6 | T1.15 (composição), T1.25, T1.37 (default fecha pool + crash loop) |
| F-7 | T1.4, T1.30 (`null`), T1.23 (`__proto__` via CLI) |
| S-1 | T1.6, T1.24 |
| S-2 | T1.7, T1.24 |
| S-3 | T1.14, T1.24, T1.32 |
| S-4 | T1.15, T1.20 |
| S-5 | T1.1 (grep), T1.25 |
| P-1, P-2 | T1.6, T1.24 |
| P-3 | T1.7, T1.24 |
| P-4 | T1.13, T1.26 |
| Q-1 | T1.1 (grep), T1.16 |
| Q-2, Q-10 | T1.16 |
| Q-3 | T1.16, T1.31 (imutabilidade) |
| Q-4, Q-5, Q-7 | T1.9 |
| Q-6 | T1.10 (views de teste), T1.16 (desempate e nearest-rank único), T1.24 (simulação real × 6 kinds) |
| Q-8 | T1.10 (seed: T1.16) |
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
| PUB-4 | T1.29 (roteiro contra o artifact de CI); parte "disponível publicamente": Release após GATE-1 (ADR-009) |
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
| 8 | Escopo pequeno e público | 37 tarefas ≤ 1 dia (T1.30–T1.33 cabem em meio dia); o motor sozinho é release (PUB-1..PUB-3 sem depender de B-1). |

Escopo SPEC §4: só o sistema `default-shop` com os 9 componentes (T1.3); só as 8 métricas, logs, traces simplificados e eventos de deploy/config (T1.5–T1.7, ADR-005); nada de SLO, OTel/OTLP, alertas, UI, i18n, Grafana/Datadog, backend ou telemetria do jogador. `packages/scenarios` e `apps/web` não são tocados nesta fase (fixtures em `packages/engine/fixtures/` já atendem a UI futura).

## Notas da onda 1 (issue #24)

Decisões do Arquiteto sobre os pontos não bloqueantes do QA da onda 1 e da T1.14. A decisão está na ADR citada; aqui fica o que cada tarefa aberta precisa saber.

- **T1.15 (orquestrador, em andamento):** nada muda no que ela entrega, e ela continua sem tocar `types.ts`. Três regras passam a valer (ADR-010 §4, ADR-002 Emenda 1): (1) um registro entregue a `appendTick` não é alterado depois, nem pelo orquestrador; (2) `world.services`/`world.deps` não são alterados depois de `buildWorld` (a T1.31 vai congelá-los); (3) o `AskEnvironment` passado a `ask()` é um objeto por `Simulation`, o mesmo em toda chamada, com a view viva. A mudança de `types.ts` deste PR só torna `readonly` os registros devolvidos por `TelemetryView` (`Readonly<T>[]`); código que lê a view compila igual. Se a T1.15 atribuir um registro lido da view a uma variável e escrever nele, isso agora é erro de compilação, e é o que se quer.
- **T1.16 (`ask()`):** monta `QuestionContext` a partir de `AskEnvironment` e memoiza `lastWeek` por ambiente, simulada até ≥ `now` (ADR-006 Emenda 1); unifica o nearest-rank (`nearestRankIndex` em `metrics.ts`); corrige o teste de desempate (#21). Os arquivos a mais estão na tabela "Arquivos tocados".
- **T1.17–T1.22 (falhas):** F-3/F-4/F-5 comparam médias na janela de assinatura sobre ≥ 10 seeds, nunca igualdade de trace ou de instância contra o baseline nos ticks com falha: o LB compartilhado faz traces que não tocam o alvo trocarem de instância (ADR-003 §8). Chaves de `attrs` seguem `^[A-Za-z_][A-Za-z0-9_]*$` e mensagens ficam no vocabulário fechado da ADR-005 Emenda 1 (mensagem nova = emenda no mesmo PR). Nenhuma task nova bloqueia estas.
- **T1.23 (CLI `main`):** troca `CliUsageError` pelo `EngineError` compartilhado (#15), monta `params` com `Object.create(null)` (#22), mapeia todo `EngineError` (incluindo `invalid_seed`) para exit 2. `--ticks +5` continua aceito como 5 (ADR-007 Emenda 1).
- **T1.24 (propriedades):** acrescenta Q-6 na simulação real × 6 kinds e a checagem de chaves de `attrs` e do vocabulário de mensagens.
- **T1.26 (CI):** o verificador passa a recusar `null` em campo opcional; exit 2 para uso/leitura fica registrado (ADR-005 Emenda 1).
- **Fase 2 (PM):** ingress sem jitter (RPS do gateway plano) fica registrado como risco de padrão decorável (SPEC §11) para o PRD da fase 2 decidir (ADR-002 Emenda 1, §5.1). A redação de D-3 ("7 arquivos em `fixtures/`" e `fixtures/answers/`) é do PM; o Arquiteto não alterou o PRD.

## Notas da Emenda 2 (PRD PR #46; issue #24)

Decisão do Arquiteto na ADR-004 Emenda 2: as duas falhas que reprovam R1–R5/E1–E4 têm amostra pequena por seed, não semântica errada; corrige-se **só o default** (`connection_pool_exhaustion.leakPerTick` 2 → 4; `disk_full.failRatio` sobe, menor valor da grade que fecha, ponto de partida 0,8). Tráfego, `default-shop` e semântica dos kinds não mudam. As 4 falhas que já passam só mudam testes. Para as tasks já mergeadas (T1.17, T1.20–T1.22) o ajuste vira follow-up (T1.34, T1.35); não entra na T1.24, que é de propriedades de coerência e já está em `main`. Nenhuma task da Emenda 2 toca `src/types.ts`: o helper é de teste e vive dentro de `packages/engine`.

- **T1.25 (multi-falha, em andamento):** passa a depender de T1.33 (helper R1–R5) e T1.37 (default do pool). Com 20/2 a assinatura do pool some em 5/40 seeds na combinação pool + crash loop (o crash do `catalog` faz o `gateway` abortar antes de chamar `payment`, e nessas seeds `payment` recebe 0 requests nos 3 ticks esgotados); com 20/4 passa em 40/40 (medição do Eng. Motor da T1.25). Pode continuar o trabalho já começado; o PR só fecha F-6 depois de T1.37 em `main`, rebaseado e usando o helper.
- **T1.27 (fixtures, em andamento):** passa a depender de T1.36 e T1.37. Pode montar `scripts/gen-fixtures.mjs` e o teste de regeneração já; os NDJSON de `disk_full` e `connection_pool_exhaustion` só são gerados e versionados depois das duas em `main`. Os outros 5 NDJSON e `fixtures/answers/*.json` (baseline) não mudam com a Emenda 2.
- **T1.27 (orçamento de tamanho, ADR-005 Emenda 2):** o teto de 2 MB da ADR-005 foi estimativa; medido, `slow_dependency` tem 2.435.840 bytes e `disk_full` chega a 2.535.432 no pior default da grade da T1.36. O teto passa a 3 MiB por arquivo, verificado em `test/fixtures.test.ts`; NDJSON puro, sem `.gz` e sem LFS; `packages/engine/.gitattributes` fixa `eol=lf` nos fixtures. Nenhum critério do PRD muda (D-3 e PUB-2 ficam como estão). Dependências da T1.27 iguais.
- **T1.28 (README):** não copia defaults de parâmetro à mão (o `--help` é gerado do catálogo); se mostrar saída de exemplo de `disk_full` ou `connection_pool_exhaustion`, regenera depois de T1.36/T1.37.
- **Eng. Conteúdo (fase 3):** o exemplo de SPEC §7 (`poolSize: 20, leakPerTick: 2`, `startTick: 12`, alerta no tick 18) só esgota o pool no tick 21. É conteúdo do cenário 3, não default do motor; o YAML do cenário escolhe params coerentes com o alerta. O SPEC não muda.

## Notas da Emenda 3 (ADR-004 Emenda 3, ADR-007 Emenda 2; issues #62, #63, #66, #58)

Decisão completa e medição (20 000 seeds `arch-0..arch-19999`) na ADR-004 Emenda 3. Nenhuma task nova; nenhuma mudança em `src/types.ts`, `src/sim/traffic.ts` ou `src/world/default-shop.ts`. **Regra de robustez**, que vale para todo default ou par fixo escolhido daqui em diante: 0 violação de R3/R4 (e do par F-4) em `arch-0..arch-19999`, fora das seeds isentas por R6; contagem e pior seed no corpo do PR.

- **T1.36 (PR #59, `disk_full`):** `failRatio` padrão **0,9**, não 0,7. Atualizar as mesmas linhas que o PR já toca (`catalog.ts`, linha `failRatio` da tabela da ADR-004, `catalog.test.ts`, `resolve.test.ts` l. 224/229). Testes iguais ao PR (dependente fixo e par F-4 (`orders-worker`, `errorPct`)). Medição no PR: varredura `arch-0..arch-19999` com 0 violação (esperado: pior seed `orders-worker` +16,67 p.p., `postgres` +67,19 p.p.), mais a lista do teste e `ENGINE_QA_SEEDS` de uma segunda lista. Não depende da R6.
- **T1.35 (branch `engine/T1.35-slow-dep-cache-cold-signatures`, `cache_cold_start`):**
  1. Em `src/faults/cache_cold_start.ts`, a probabilidade de miss forçado passa de `1 - s / warmupTicks` para `Math.min(1, 2 * (1 - s / warmupTicks))`, mesmo stream `('miss', tick, traceId)`, mesmo sorteio único por chamada; nada mais muda no módulo. O comentário de cabeçalho descreve a curva nova (fria até `warmupTicks / 2`, depois linear) e p50 em vez de p95.
  2. O teste de módulo "the forced-miss ratio decreases linearly" passa a afirmar a curva nova: razão observada ≈ 1 para `s ≤ warmupTicks / 2` e ≈ `2·(1 − s/warmupTicks)` depois, com a mesma tolerância de hoje.
  3. F-3 linha 7, p50: R2 = p50 de `auth` ≥ 25% na média das seeds; R3 = em cada seed, **pelo menos um** de `auth`, `catalog`, `cart` (os usuários diretos de `redis`, lidos do mundo como hoje em `CACHE_USERS`) com p50 ≥ +18,75%. Mensagem de falha cita a seed e o melhor valor da seed.
  4. F-4: par fixo **(`postgres`, `connections`)** via `assertEligibleF4`, no lugar de (`auth`, `p50`).
  5. As outras condições da linha 7 ficam como estão na branch (RPS de `postgres` ≥ 2× em `startTick+1..+3`, volta a ≤ 1,2× em `startTick + warmupTicks`, evento `config` com `restart: true`). O teste herdado "p95 of every cache user also goes up" (não é critério do PRD; a Emenda 1 diz que o p95 mal se mexe) sai ou vira média sobre os usuários ≥ 1×; o engenheiro escolhe e registra no PR.
  6. Medição no PR: varredura `arch-0..arch-19999` (esperado: melhor usuário pior seed +25,71%, `postgres` conexões pior seed +58,14%, RPS de `postgres` pior seed 1,92×), lista do teste e a segunda lista da #66 via `ENGINE_QA_SEEDS`. Não depende da R6.
- **T1.37 (PR #56, pool):** defaults 20/4 ficam. Implementa a isenção **R6** (texto proposto ao PM no PR desta emenda e em #62):
  1. Em `test/support/signature.ts`: `exercised(faulted, target, window)` = número de spans `server` do `target` com tick na janela, na execução **com falha**, > 0. `effect(...)` e `assertEligibleF4(...)` ganham um parâmetro opcional `exempt?: readonly boolean[]` (um por seed): seed isenta não entra na verificação por seed (R3/E3), mas entra nas médias (R2, R5) como hoje. `signature.test.ts` cobre: seed isenta que falharia por seed passa; a mesma seed sem `exempt` falha; `exempt` de tamanho diferente da série lança.
  2. Em `connection_pool_exhaustion.test.ts`, nos dois casos (sozinho e com crash loop): `exempt[i] = !exercised(faulted_i, 'payment', WINDOW)` para p95 de `payment` (R3), p95 do `gateway` (R3) e o par F-4 (`gateway`, `p95`); conexões do alvo = `poolSize` em ≥ 1 tick da janela continuam em **toda** seed (R4, sem isenção); a cláusula do trace já é por tick com request.
  3. Teto da R6, num bloco próprio: em 1 000 seeds consecutivas `pool-r6-0..999`, a fração de seeds sem exercício é ≤ 2%, para o caso sozinho e para o combinado (medido pelo Arquiteto: 0,065% e 0,90%). Só execuções com falha; `timeout` do bloco ajustado ao tempo medido e registrado no PR.
  4. Medição no PR: `arch-0..arch-19999` nos dois casos, com 0 violação nas seeds exercitadas (esperado: 13 e 180 seeds isentas).
  5. **Não mergear antes de a R6 entrar no PRD** (PR do PM). Se o PM recusar a R6, a T1.37 para e volta ao Arquiteto (a saída restante é tráfego, emenda da ADR-002).
- **T1.25 (PR #47, multi-falha):** continua com pool em `payment` + crash loop em `catalog`. Rebase depois da T1.37 em `main`; usa `exercised`/`exempt` do helper para as condições da linha 3 exatamente como a T1.37; a linha 1 (crash loop) não tem isenção. Mesmo bloqueio de merge pela R6.
- **T1.27 (PR #53, fixtures):** passa a depender também da T1.35, porque a curva nova muda a telemetria de `cache_cold_start`. Gera `disk_full`, `connection_pool_exhaustion` e `cache_cold_start` depois de T1.35, T1.36 e T1.37 em `main`.
- **T1.26/T1.28 e PUB-1 (#58, ADR-007 Emenda 2):** o comando de pack é `pnpm --dir packages/engine pack`, como `scripts/pack-smoke.sh` e o README já fazem. Nenhum código muda; o texto de PUB-1 (PM) e da ADR-009 (Diretor) está proposto no PR desta emenda.
- **ADR-009 (revista em 2026-10-26, decisão do Diretor):** o texto da ADR-009 foi atualizado pelo Arquiteto com o comando aprovado, `pnpm --dir packages/engine pack --pack-destination dist/`. A T1.29 deixa de publicar (ver linha e critério da T1.29); publicação do Release e tag `engine-v0.1.0` com o agente Release após GATE-1.
