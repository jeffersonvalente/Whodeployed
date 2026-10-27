# FASE-2 — Tarefas (Protótipo de texto)

- **Autor:** Arquiteto
- **Entrada:** `docs/prd/FASE-2.md` (PR #75, `bb33cf3`); SPEC v1.1 §3, §4, §5, §6, §7, §8, §10; ADR-001 a ADR-011; `docs/gates/GATE-1.md` (pendências não bloqueantes); issue #24; formato de `docs/prd/FASE-1.tasks.md`
- **Contratos (tipos, dono: Arquiteto; engenheiros não editam):**
  - `packages/engine/src/types.ts` — §6 ganhou `Simulation.act`, `SupportedActionKind`, `ActionCostTable`, `ActionResult`, `ImpactTick`, `ImpactOfTick`, `AccumulatedImpact`; §7 ganhou `invalid_action` e `unsupported_action`; §8 ganhou `ProcessReplacementReaction`, `FaultActionReaction`, `FaultActionReactions`; comentário de `SimulationConfig.faults` (I24-2) e de `advance` (I24-3). §1 (cópia de SPEC §6) não mudou (EN-3). `src/index.ts` reexporta os tipos novos; `src/sim/simulation.ts` tem um stub de `act` que lança (corpo: T2.2).
  - `packages/scenarios/src/types.ts` — novo: `Scenario`, `ReferenceStep`, `ReviewSpec`, `QuestionPattern`, `Repertoire`, `ScenarioErrorInfo`, `PlayStep`, `MitigationCheck`, `CheckMitigations`, `EngineRuntime`, `ScenarioBundle` (ADR-014). Fora do motor por causa de EN-5. Só `import type` do motor: o runtime é injetado como `EngineRuntime` (ADR-014 §1.1, SPEC §6 "engine (tipos)").
  - `apps/web/src/session/types.ts` — novo: `SessionLogV1`, `SessionStep`, `Session`, `SessionDeps`, `BuildReview`, `ReplayResult`, `OutcomeReport` (ADR-015, ADR-016).
  - Os três compilam: `pnpm --filter ./packages/engine typecheck` e testes do motor verdes (973 testes); os dois arquivos novos foram verificados com `tsc --noEmit` (strict, `exactOptionalPropertyTypes`, resolução `@whodeployed/*` para os `src/` dos pacotes). Os `tsconfig` de `packages/scenarios` e `apps/web` nascem em T2.9 e T2.21 e passam a incluí-los.
- **ADRs desta fase:** ADR-012 (ações `restart`/`rollback`, custo, tabela por kind), ADR-013 (função de impacto), ADR-014 (pacote de cenários: tipos, loader, padrões, repertório, `checkMitigations`, bundle), ADR-015 (protótipo em `apps/web`, núcleo de sessão, scripts, CI e artifact), ADR-016 (log de sessão v1 e JSON canônico); emendas: ADR-002 Emenda 2 (API pública, I24-1..I24-4), ADR-005 Emenda 3 (ordem de eventos com ações), ADR-006 Emenda 2 (códigos de erro de pergunta, I24-5, I24-6)
- **Escalação (CLAUDE.md):** tudo neste arquivo é decisão delegada; o motivo de cada uma está na ADR citada. Pendências para o Diretor no fim.

Regras para todas as tarefas:

- Um PR por tarefa, branch `<papel>/T2.n-slug`: `engine/` (motor), `content/` (conteúdo), `web/` (ui), `pm/`, `qa/`, `arquiteto/`. Conventional Commits. Autoria só do usuário git; nada de trailer ou menção a ferramenta (CLAUDE.md).
- **EN-1 em todo PR:** todos os passos de CI do GATE-1 continuam no `ci.yml` e passam. **EN-2 em todo PR:** `git diff --exit-code 4fe9dce -- 'packages/engine/fixtures/*.ndjson'` vazio. **EN-3 em todo PR:** a cópia de SPEC §6 em `packages/engine/test/contract.types.test.ts` não muda.
- **Determinismo por seed (SPEC §3.3) é critério de toda tarefa `motor`** e de toda tarefa que repete o motor (conteúdo, núcleo de sessão, scripts): o PR inclui teste em que a mesma seed e as mesmas entradas dão saída idêntica (byte a byte quando há serialização), e nenhum `Math.random`/`Date.now`/relógio fora de `test/` (D-4; no protótipo, só o `wallClock` injetado, que alimenta `wallMs`). Na tabela: `DET`.
- **Nenhuma tarefa introduz backend, rede em runtime ou telemetria do jogador** (SPEC §3.6, PR-3). Estado só em `localStorage` (PR-16).
- Ninguém edita os três arquivos de contrato acima; mudança é issue para o Arquiteto. Só T2.1 e T2.6 editam `packages/engine/src/index.ts` (linhas próprias). Ninguém edita `packages/engine/src/world/default-shop.ts` nem `src/faults/catalog.ts`.
- Dependências: só T2.9 e T2.21 criam `package.json`/`tsconfig`/lockfile dos seus pacotes; tarefa que precisar de dependência nova pede no PR e acrescenta só a linha dela no `package.json` do próprio pacote e no `pnpm-lock.yaml`.
- Cobertura ≥ 80% em `packages/engine/src/sim/**` e `src/faults/**` em todo PR (QC-1). O threshold `'src/sim/**'` do Vitest é agregado (sem `perFile`) e não garante os módulos novos; por isso cada módulo novo ganha threshold **por arquivo** em `packages/engine/vitest.config.ts`, entregue pela tarefa que o cria: `'src/sim/actions.ts': QC1` (T2.2) e `'src/sim/impact.ts': QC1` (T2.6) (EN-8).
- Checklist de PR (`.github/PULL_REQUEST_TEMPLATE.md`): nas tarefas `ui`, os itens "390 px" e "`i18n/en.json`" são N/A nesta fase; nas de `conteudo`, "`pnpm validate`" é N/A (o comando é da fase 4) e vale o teste do loader e de replay (PRD, "Fora de escopo"). Strings de interface em inglês (PR-18).
- **Integração:** donos diferentes nunca esperam um ao outro para começar; trabalham sobre os contratos e sobre fixtures (`packages/engine/fixtures/`, `apps/web/test/fixtures/`). As tarefas marcadas **INT** são a costura final: precisam da implementação de outro dono em `main` para o teste ficar verde, e só elas.

## Tabela de tarefas

| ID | Tarefa | Pacote | Dono | Depende de | Critério do PRD que atende | Onda |
| --- | --- | --- | --- | --- | --- | --- |
| T2.0 | Contratos e ADRs da fase (este PR): `types.ts` do motor, `scenarios/src/types.ts`, `web/src/session/types.ts`, ADR-012..016, emendas ADR-002/005/006 | engine, scenarios, web, docs | arquiteto | — | EN-3 (acréscimos fora dos tipos de SPEC §6), I24-1 (lista na ADR), I24-2, I24-3, I24-4 (decisão), I24-5, I24-6 (registro), PR-6 (lugar da tabela), PR-13 (formato), PR-14 (lugar do script) | 0 |
| T2.1 | Motor: remover o ciclo ESM `ask.ts` ↔ `simulation.ts` (`createLastWeek` no `AskEnvironment`), teste de grafo de imports sem ciclo, teste da lista pública de runtime de `index.ts` | engine | motor | T2.0 | I24-4, I24-1 (teste), EN-1, EN-2, DET | 1 |
| T2.2 | Motor: `act()` — validação (`invalid_action`, `unsupported_action`, `unknown_target`), `actionCostTable`, agendamento em `tick + 1`, ciclo de vida das falhas (`endTick`, gerações, prefixo de stream), primitiva `restart` (`down` + evento), ordem de eventos (ADR-005 Em. 3), threshold por arquivo de `actions.ts` | engine | motor | T2.0 | EN-4 (custo, `restart`), EN-5 (erros, sem nível), EN-8 (`actions.ts`), EN-2, EN-3, DET | 1 |
| T2.3 | Motor: substituição de processo — tabela `FaultActionReactions` (ADR-012 §5) e regra de cache (falha induzida `cache_cold_start`) aplicadas ao `restart` | engine | motor | T2.2 | EN-5 (coluna `restart`), DET | 2 |
| T2.4 | Motor: `rollback` — histórico de deploys pela `TelemetryView`, lote mais recente não revertido, vínculo com `bad_deploy`, SP sem indisponibilidade, evento `deploy`, rollback sem lote = nada | engine | motor | T2.3 | EN-4 (`rollback`), EN-5 (coluna `rollback`), DET | 3 |
| T2.5 | Motor: suíte da tabela EN-5 (2 ações × 6 kinds × {alvo, outro}, ≥ 10 seeds por célula) e determinismo de ações em 2 processos (cada ação × cada kind, SHA-256) | engine | motor | T2.4 | EN-4, EN-5, EN-8 (mantém o threshold de `actions.ts`), DET | 4 |
| T2.6 | Motor: impacto — `src/sim/impact.ts` (`impactOfTick`, `accumulatedImpact`), exportação em `index.ts`, threshold por arquivo de `impact.ts`, calibração da ADR-013 §3 (EN-6 a, c; sanidade por kind) e "Emenda 1 — calibração" na ADR-013 | engine | motor | T2.0 | EN-6 (a), EN-6 (c), EN-8 (`impact.ts`), I24-1 (2 nomes novos), DET | 1 |
| T2.7 | Motor: EN-7 — propriedades P-1, P-2, P-3 com ações (≥ 10 seeds × 6 kinds × {`restart`, `rollback`} no alvo em `startTick + 6`, 30 ticks) e P-4 (`verify-coherence.mjs`) sobre uma execução com ações | engine | motor | T2.4 | EN-7, DET | 4 |
| T2.8 | Motor: fixtures para UI e conteúdo — `fixtures/actions/*.json` (sequências canônicas com `ActionResult`, série de impacto e veredito de mitigação eficaz) e `fixtures/impact/*.json` (série por kind), gerador e teste de regeneração | engine | motor | T2.4, T2.6 | EN-2 (NDJSON intocados), insumo de PR-7/PR-8/CN-5, DET | 4 |
| T2.9 | Conteúdo: scaffolding de `packages/scenarios` (`package.json` `@whodeployed/scenarios`, `exports` `.`/`./data`/`./node`, motor só em `peerDependencies`/`devDependencies`, tsconfig, Vitest, ESLint com `import type` obrigatório do motor em `src/`, `src/index.ts` só com tipos) e `ci.yml` com `build` antes de `lint`/`typecheck`/`test` | scenarios | conteudo | T2.0 | EN-1, CN-4 (base), PR-19 (base) | 1 |
| T2.10 | Conteúdo: loader — `parseScenario`, `ScenarioError`, padrões de pergunta (`matchesPattern`), `toSimulationConfig`, `src/node.ts` (`loadScenarioFile`, `loadScenarioDir`) | scenarios | conteudo | T2.9 | CN-4, CN-1 (campos), DET | 2 |
| T2.11 | Conteúdo: repertório — `src/repertoire.ts` (tabela única) e `inRepertoire` | scenarios | conteudo | T2.9 | PR-6 (fonte única), CN-5 (tabela) | 2 |
| T2.12 | Conteúdo: corrigir `_TEMPLATE.yaml` (sem `declareMitigated` em exemplo `junior`; `logs` com `window: 30`; `review.keySignalAsk`; `impactBudget` comentado) | scenarios | conteudo | T2.0 | Decisão delegada 2 do PM (PR #75); CN-5 (template coerente com SPEC §5) | 1 |
| T2.13 | Conteúdo: `checkMitigations` (`src/mitigation.ts`, ADR-013 §4, ADR-014 §3.1) | scenarios | conteudo | T2.10; **INT** T2.4, T2.6 | CN-3, CN-5, CN-9 (f), insumo de PR-11 e PR-15 (R-4), DET | 4 |
| T2.14 | Conteúdo: cenário `01-*` (`service_crash_loop`, `junior`) e seus testes CN-6 e CN-7 | scenarios | conteudo | T2.10 | CN-1, CN-2, CN-6, CN-7, DET | 3 |
| T2.15 | Conteúdo: cenário `03-*` (`connection_pool_exhaustion`, `junior`) e seus testes CN-6 (pool em `poolSize` no `alert.tick`, alvo exercitado na janela) e CN-7 | scenarios | conteudo | T2.10 | CN-1, CN-2, CN-6, CN-7, DET | 3 |
| T2.16 | Conteúdo: cenário `05-*` (`slow_dependency`, `pleno`) e seus testes CN-6 e CN-7 | scenarios | conteudo | T2.10 | CN-1, CN-2, CN-6, CN-7, DET | 3 |
| T2.17 | Conteúdo: incidentes de teste `TA` e `TB` (`test-*`, `pleno`) com testes de campos de CN-3 e CN-9 (a)–(e), (g), CN-6 e CN-7 | scenarios | conteudo | T2.10 | CN-1, CN-2, CN-3 (campos), CN-6, CN-7, CN-9 (a–e, g), DET | 3 |
| T2.18 | Conteúdo: bundle `@whodeployed/scenarios/data` (`scripts/build-data.mjs` no `build`, `dist/data.js` + `dist/data.d.ts`, `campaign`/`testIncidents` ordenados) | scenarios | conteudo | T2.10 | PR-19 (a UI não conhece YAML), insumo de PR-4, DET | 3 |
| T2.19 | Conteúdo: `scripts/check-not-in-code.mjs` (CN-8) e passo no `ci.yml` | scenarios | conteudo | T2.9 | CN-8 | 2 |
| T2.20 | Conteúdo: suíte de replay dos 5 YAML — CN-5 (repertório + mitigação eficaz < orçamento), EN-6 (b), CN-3 (mitigação eficaz antes de 50%), CN-9 (f), CN-1 (exatamente 5 arquivos, `teaches` distintos) | scenarios | conteudo | T2.11, T2.13, T2.14, T2.15, T2.16, T2.17; **INT** T2.4, T2.6 | CN-1, CN-3, CN-5, CN-9 (f), EN-6 (b), DET | 5 |
| T2.21 | UI: scaffolding de `apps/web` (Vite + React, Vitest/jsdom/Testing Library, ESLint com fronteiras de PR-19, `index.html`, `src/main.tsx`, `src/build-info.ts`, constantes de build), `scripts/check-static.sh` e passos de CI (build com 0 warnings, PR-2, PR-3) | web | ui | T2.0 | PR-1, PR-2, PR-3 (grep), PR-19 | 1 |
| T2.22 | UI: núcleo de sessão — `createSession` (início em `alert.tick`, `ask`/`act`/`wait`, custo, limite 360, impacto memoizado, `severe`, repertório via `inRepertoire`) | web | ui | T2.21 | PR-5 (núcleo), PR-6 (núcleo), PR-8, PR-12 (núcleo), DET | 2 |
| T2.23 | UI: núcleo do caderno — hipótese, descarte com citação, fim (ativa / nova / `unknown`) | web | ui | T2.21 | PR-9 (núcleo), PR-10 (núcleo), DET | 2 |
| T2.24 | UI: log v1 e persistência — serialização canônica (ADR-016), comparação sem `wallMs`, download e cópia, `storage.ts` com fallback | web | ui | T2.21 | PR-13, PR-16, I24-6, DET | 2 |
| T2.25 | UI: `buildReview` — as 3 frases (PR-11), com `checkMitigations` injetado/mocado | web | ui | T2.21 | PR-11 (lógica), DET | 2 |
| T2.26 | UI: renderização das respostas em texto (`src/signals/`) para os 5 kinds do repertório Pleno, sobre `packages/engine/fixtures/answers/*.json` | web | ui | T2.21 | PR-7 | 2 |
| T2.27 | UI: telas de lista, modo de teste (`?test=<id>`), início da sessão, controles de pergunta/ação montados do repertório, relógio (`impact N / B`, `SEVERE`, `wait`) | web | ui | T2.22 | PR-4, PR-5, PR-6, PR-8 (DOM), PR-18 | 3 |
| T2.28 | UI: telas de caderno, fim, revisão e export (download, cópia, lista salva, apagar) | web | ui | T2.23, T2.24, T2.25, T2.27 | PR-9, PR-10, PR-11 (DOM), PR-13 (UI), PR-16 (UI), PR-18 | 4 |
| T2.29 | UI: `replayLog` (`src/session/replay.ts`) e `scripts/replay.ts`; passo de CI de desempenho (PR-17, `timeout 5`) sobre log de fixture | web | ui | T2.22, T2.24 | PR-14, PR-17 (CI), I24-6, DET | 3 |
| T2.30 | UI: `outcomes.ts` (R-1..R-4) e `scripts/results.ts` | web | ui | T2.29 | PR-15, DET | 4 |
| T2.31 | UI: artifact `whodeployed-prototype` em push verde para `main` (PR-21) | web | ui | T2.21 | PR-21 (CI) | 2 |
| T2.32 | UI: integração com os dados reais — `src/data.ts` real, 5 logs de referência gerados pelo núcleo de sessão a partir do `referencePath`, log adulterado, passo de CI de replay; PR-4/PR-5/PR-12 sobre os 5 cenários reais | web | ui | T2.28, T2.29; **INT** T2.18, T2.20 | PR-4, PR-5, PR-12, PR-14 (CI), DET | 6 |
| T2.33 | UI: `apps/web/README.md` (inglês): build, servir, modo de teste, export, replay, resultados, baixar o artifact; todo comando roda verbatim | web | ui | T2.30, T2.31, T2.32 | PR-20, PR-21 (README) | 7 |
| T2.34 | PM: modelo da nota de pesquisa `docs/research/FASE-2-sessao-01.md` (formulário do Roteiro, seção "Ensaio", intervenções, ordem TH-5), termo de consentimento, checklist de preparação, contagem de palavras do Anexo A | docs | pm | — | TH-1, TH-2 (formulário), TH-4, TH-5, TH-6 (≤ 400 palavras) | 1 |
| T2.35 | QA: conferência do ensaio (TH-1) no build do SHA da sessão; TH-6 contra os 5 YAML; PR-3 offline, PR-17 no navegador, PR-18 nas telas dos 5 cenários, PR-20/PR-21 verbatim | docs | qa | T2.33, T2.34 (+ ensaio feito pelo moderador) | TH-1, TH-6, PR-3, PR-17, PR-18, PR-20, PR-21 | 8 |
| T2.36 | QA: depois da sessão do Diretor — replay dos 5 logs (TH-2), resultados (TH-3), intervenções (TH-4), ordem (TH-5), `GATE-2.md` com todos os critérios e I24-7 | docs | qa | T2.35, T2.37, sessão (Diretor) | TH-2, TH-3 (medição), TH-4, TH-5, I24-7 (conferência), todos (relatório) | 9 |
| T2.37 | Arquiteto: atualizar e fechar a issue #24 (cada item com PR ou "fora — FASE-2.md" com o motivo) | docs | arquiteto | T2.0, T2.1, T2.6 | I24-7 | 6 |

Não são tarefas de engenharia (registrados para o gate, sem dono de engenharia): **recrutar o júnior e indicar o moderador** (Diretor; o moderador nunca é engenheiro que escreveu código do protótipo), **ensaio** e **sessão gravada** (moderador, TH-1 e TH-2), **guardar a gravação e confirmá-la no `GATE-2.md`** (Diretor, TH-2), **decisão GO/NO-GO** (Diretor, TH-3; gate).

## Ondas de paralelismo

| Onda | Tarefas (rodam em paralelo) | Liberada quando |
| --- | --- | --- |
| 0 | T2.0 | — |
| 1 | T2.1, T2.2, T2.6 (motor); T2.9, T2.12 (conteúdo); T2.21 (ui); T2.34 (pm) | T2.0 em `main` (T2.34 não depende de nada) |
| 2 | T2.3 (motor); T2.10, T2.11, T2.19 (conteúdo); T2.22, T2.23, T2.24, T2.25, T2.26, T2.31 (ui) | T2.2; T2.9; T2.21 |
| 3 | T2.4 (motor); T2.14, T2.15, T2.16, T2.17, T2.18 (conteúdo); T2.27, T2.29 (ui) | T2.3; T2.10; T2.22 (T2.29 também T2.24) |
| 4 | T2.5, T2.7, T2.8 (motor); T2.13 (conteúdo, INT); T2.28, T2.30 (ui) | T2.4 (T2.8 também T2.6); T2.10 + T2.4 + T2.6; dependências da tabela |
| 5 | T2.20 (conteúdo, INT) | T2.11, T2.13, T2.14–T2.17 |
| 6 | T2.32 (ui, INT); T2.37 (arquiteto) | T2.18, T2.20, T2.28, T2.29; T2.1 e T2.6 |
| 7 | T2.33 (ui) | T2.30, T2.31, T2.32 |
| 8 | ensaio (moderador) → T2.35 (qa) | T2.33 e T2.34; build do SHA da sessão |
| 9 | sessão gravada (Diretor/moderador) → T2.36 (qa) → decisão do Diretor | T2.35, T2.37 |

Os três donos de engenharia começam no mesmo dia (onda 1) sobre os contratos de T2.0. Caminho crítico: T2.0 → T2.2 → T2.3 → T2.4 → T2.13 → T2.20 → T2.32 → T2.33 → ensaio → T2.35 → sessão → T2.36. Fora dele: impacto (T2.6, roda desde o dia 1), todo o núcleo e as telas do protótipo (sobre fixtures), os YAML (escritos com as tabelas das ADR-012/013) e a nota de pesquisa.

## Arquivos tocados por tarefa

"novo" = não existe antes. Caminhos relativos ao pacote quando o pacote é óbvio pela tarefa.

| ID | Arquivos |
| --- | --- |
| T2.0 | `packages/engine/src/{types,index}.ts`, `packages/engine/src/sim/simulation.ts` (só o stub de `act`); novo `packages/scenarios/src/types.ts`, `apps/web/src/session/types.ts`; novo `docs/adr/ADR-0{12,13,14,15,16}-*.md`; emendas em `docs/adr/ADR-00{2,5,6}-*.md`; novo `docs/prd/FASE-2.tasks.md` |
| T2.1 | `src/questions/ask.ts` (`AskEnvironment.createLastWeek`, sem import de `sim/simulation.ts`), `src/sim/simulation.ts` (só a montagem do `env`), `src/index.ts` (nada além de comentário, se preciso), `test/boundaries.test.ts` (ciclo), novo `test/public-api.test.ts` (lista da ADR-002 Emenda 2 §2.1 sem os 2 nomes da T2.6), `test/questions/ask.test.ts` só se montar `AskEnvironment` à mão |
| T2.2 | novo `src/sim/actions.ts` (validação, custo, agendamento, ciclo de vida, `restart`), `src/sim/hooks.ts` (`endTick` em `ActiveFault`/`hooksActiveAt`), `src/sim/simulation.ts` (corpo de `act`, passo 1 com efeitos de ação, ordem de eventos, mecanismo de gerações `g ≥ 1` e de falha induzida, ainda sem quem os chame), novo `test/sim/actions.test.ts`, `test/sim/hooks.test.ts` (casos de `endTick`), `packages/engine/vitest.config.ts` (só a linha `'src/sim/actions.ts': QC1`) |
| T2.3 | `src/sim/actions.ts` (tabela `FaultActionReactions`, SP, regra de cache), `test/sim/actions.test.ts`; usa o mecanismo de gerações e de falha induzida da T2.2, sem reimplementá-lo (`simulation.ts` só se faltar uma chamada) |
| T2.4 | `src/sim/actions.ts` (`rollback`), `test/sim/actions.test.ts` |
| T2.5 | novo `test/actions/table.test.ts` (24 células), novo `test/actions/determinism.test.ts` (2 processos, padrão de D-1) |
| T2.6 | novo `src/sim/impact.ts`, `src/index.ts` (2 linhas de export), `packages/engine/vitest.config.ts` (só a linha `'src/sim/impact.ts': QC1`), `test/public-api.test.ts` (2 nomes), novo `test/sim/impact.test.ts`, `docs/adr/ADR-013-impact.md` (só a "Emenda 1 — calibração") |
| T2.7 | `test/properties/coherence.test.ts` (bloco novo com ações; o resto intacto), `packages/engine/scripts/ci-engine.sh` só se o P-4 com ações rodar no shell (preferência: em teste) |
| T2.8 | novo `scripts/gen-action-fixtures.mjs`, novo `fixtures/actions/*.json`, `fixtures/impact/*.json`, novo `test/action-fixtures.test.ts`; `package.json` do motor (script `fixtures:actions`, única linha) |
| T2.9 | novo `packages/scenarios/{package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, eslint.config.js, src/index.ts, test/type-only-engine.test.ts}`, remove `src/.gitkeep`, `pnpm-lock.yaml`, `.github/workflows/ci.yml` (move `build` para antes de `lint`) |
| T2.10 | novo `src/{errors,load,node,patterns}.ts`, `src/index.ts` (exports), novo `test/{load,patterns,node}.test.ts`, novo `test/fixtures/*.yaml` (casos de erro) |
| T2.11 | novo `src/repertoire.ts`, `src/index.ts` (exports), novo `test/repertoire.test.ts` |
| T2.12 | `packages/scenarios/scenarios/_TEMPLATE.yaml` |
| T2.13 | novo `src/mitigation.ts`, `src/index.ts` (export), novo `test/mitigation.test.ts` |
| T2.14 | novo `scenarios/01-*.yaml`, novo `test/scenarios/01.test.ts` |
| T2.15 | novo `scenarios/03-*.yaml`, novo `test/scenarios/03.test.ts` |
| T2.16 | novo `scenarios/05-*.yaml`, novo `test/scenarios/05.test.ts` |
| T2.17 | novo `scenarios/test-*.yaml` (2), novo `test/scenarios/test-incidents.test.ts` |
| T2.18 | novo `scripts/build-data.mjs`, `package.json` (script `build`), novo `test/build-data.test.ts` |
| T2.19 | novo `scripts/check-not-in-code.mjs`, novo `test/check-not-in-code.test.ts`, `.github/workflows/ci.yml` (1 passo depois do `build`) |
| T2.20 | novo `test/replay.test.ts`; pode ajustar `params`, `startTick`, `alert.tick`, `impactBudget` e `referencePath` dos 5 YAML (o resto dos YAML é das T2.14–T2.17) |
| T2.21 | novo `apps/web/{package.json, tsconfig.json, vite.config.ts, eslint.config.js, index.html, src/main.tsx, src/app.tsx, src/build-info.ts, src/engine-runtime.ts, src/data.ts (stub com bundle vazio), scripts/check-static.sh, test/boundaries.test.ts, test/fixtures/scenarios.ts}`, remove `src/.gitkeep`, `pnpm-lock.yaml`, `.github/workflows/ci.yml` (passos `check-static.sh` e build sem warning) |
| T2.22 | novo `src/session/{session,errors}.ts`, novo `test/session/session.test.ts` |
| T2.23 | novo `src/session/notebook.ts`, `src/session/session.ts` (só ligar `hypothesis`/`discard`/`end`), novo `test/session/notebook.test.ts` |
| T2.24 | novo `src/session/{log,storage}.ts`, novo `src/review/export.ts` (download e clipboard), novo `test/session/{log,storage}.test.ts` |
| T2.25 | novo `src/session/review.ts`, novo `test/session/review.test.ts` |
| T2.26 | novo `src/signals/*.tsx`, novo `test/signals/*.test.tsx` |
| T2.27 | novo `src/scenario-list/*.tsx`, `src/clock/*.tsx`, `src/signals/controls.tsx`, `src/app.tsx`, novo `test/{scenario-list,clock}/*.test.tsx`, `test/signals/controls.test.tsx` |
| T2.28 | novo `src/notebook/*.tsx`, `src/review/*.tsx`, `src/app.tsx` (ligação), novo `test/{notebook,review}/*.test.tsx` |
| T2.29 | novo `src/session/replay.ts`, `scripts/replay.ts`, `test/session/replay.test.ts`, `test/fixtures/logs/perf-360.json`; `package.json` (script `replay`), `.github/workflows/ci.yml` (passo PR-17) |
| T2.30 | novo `src/session/outcomes.ts`, `scripts/results.ts`, `test/session/outcomes.test.ts`, `test/fixtures/logs/outcomes-*.json`; `package.json` (script `results`) |
| T2.31 | `.github/workflows/ci.yml` (passo de upload `whodeployed-prototype`, só em `push` para `main`) |
| T2.32 | `src/data.ts` (import real de `@whodeployed/scenarios/data`), novo `scripts/gen-reference-logs.ts`, novo `test/fixtures/logs/reference/*.json` (5) e `tampered.json`, novo `test/integration/*.test.tsx`, `.github/workflows/ci.yml` (passo de replay dos 6 logs) |
| T2.33 | `apps/web/README.md` |
| T2.34 | novo `docs/research/FASE-2-sessao-01.md` (modelo), novo `docs/research/FASE-2-consentimento.md`, novo `docs/research/fase-2/.gitkeep` |
| T2.35 | `docs/research/FASE-2-sessao-01.md` (só a conferência do QA na seção "Ensaio"); relatório no PR |
| T2.36 | `docs/research/fase-2/*.json` (os 5 logs da sessão, entregues pelo moderador), novo `docs/gates/GATE-2.md` |
| T2.37 | só a issue #24 no GitHub (comentário e fechamento); nenhum arquivo |

Conflitos residuais conhecidos: T2.1 e T2.2 tocam `src/sim/simulation.ts` em trechos diferentes (montagem do `env` × `act` e passo 1); quem entrar depois rebaseia, merge trivial. T2.2, T2.3 e T2.4 são sequenciais no mesmo `actions.ts`. T2.9, T2.19, T2.21, T2.29, T2.31 e T2.32 acrescentam passos ao `ci.yml` em lugares diferentes (T2.9 move o `build`; os outros só acrescentam depois dele). T2.6 e T2.1 editam `test/public-api.test.ts`: a T2.1 cria com a lista 0.1.0, a T2.6 acrescenta 2 nomes.

## Critérios de aceite por tarefa (e como o QA verifica)

Todas: lint, typecheck e testes verdes no CI; EN-1, EN-2 e EN-3 conferidos; checklist do PR preenchido; `DET` provado onde marcado. O QA cola no relatório do PR a saída dos comandos citados.

- **T2.0** — `pnpm --filter ./packages/engine typecheck` e `test` verdes; `git diff 4fe9dce -- packages/engine/test/contract.types.test.ts` vazio (EN-3); os dois `types.ts` novos compilam em modo estrito; ADR-012..016 e emendas existem antes dos PRs que as implementam. *QA:* roda os comandos; lê as ADRs contra EN-4, EN-5, EN-6, PR-6, PR-13, PR-14, I24-1..I24-6.
- **T2.1** — `ask.ts` não importa `sim/simulation.ts`; `test/boundaries.test.ts` falha num ciclo de import relativo (teste com arquivo-amostra) e passa em `src/`; `test/public-api.test.ts` compara `Object.keys` de `src/index.ts` com a lista 0.1.0 da ADR-002 Emenda 2 §2.1; os testes de `ask`/`lastWeek` continuam verdes sem mudança de expectativa. DET: hashes de D-1 iguais aos de `main`. *QA:* `grep -n "sim/simulation" packages/engine/src/questions/ask.ts` vazio; muta a lista (remove um nome) e vê o teste falhar.
- **T2.2** — Cada linha da tabela de validação da ADR-012 §2 tem um teste com `code`, `field` e `validValues`; erro não altera a simulação (hash igual antes/depois); `act()` não avança o relógio; `restart X` = todas as instâncias de `X` `down` em `tick + 1` + 1 evento `config` `restart: true` (ordem de ADR-005 Emenda 3); duas ações antes do mesmo `advance` aplicadas na ordem; `endTick` em `hooksActiveAt`; sem `act`, NDJSON byte-idêntico ao de `main` (EN-2); `grep -rniE "referencePath|rootCause|teaches|trap|junior|pleno|senior|playerLevel" packages/engine/src` vazio. `vitest.config.ts` tem `'src/sim/actions.ts': QC1` e a cobertura do arquivo é ≥ 80% (EN-8). DET: mesma sequência de `act`/`advance` 2× ⇒ NDJSON idêntico. *QA:* roda o grep; confere `actionCostTable` = ADR-012 §3; apaga um teste de `actions.ts` localmente e vê o threshold do arquivo falhar.
- **T2.3** — Tabela `FaultActionReactions` = ADR-012 §5 (teste compara linha a linha); `restart` no alvo: `service_crash_loop` e `slow_dependency` encerrados, `connection_pool_exhaustion` recomeça do zero (conexões vazadas = `leakPerTick` no tick seguinte ao `restart`), `disk_full` e `bad_deploy` intactos; regra de cache: `restart` de `redis` sem falha produz o evento e o `down` do `cache_cold_start` (um evento só) e miss forçado nos ticks seguintes; geração `g ≥ 1` usa o prefixo `('fault', i, kind, 'gen', g)` e a induzida `('action', n, 'cache_cold_start')`. DET: idem T2.2. *QA:* lê a tabela do código contra a ADR.
- **T2.4** — `rollback` sem deploy no alvo: telemetria byte-idêntica a não agir; com `bad_deploy`: falha encerrada em `tick + 1`, 1 evento `deploy` sem `instance`, nenhum `down`; noise de deploy no alvo depois do `bad_deploy`: o 1º `rollback` não resolve, o 2º resolve; eventos de `rollback` não são revertíveis. DET: idem. *QA:* reproduz o caso do noise com `--seed` qualquer num teste próprio de 10 linhas.
- **T2.5** — 24 testes (um por célula da ADR-012 §5), cada um com ≥ 10 seeds de `signatureSeeds` e a asserção da célula (ex.: crash loop + `restart` no alvo ⇒ nenhum log `process exited` do alvo em `[te + 1, te + 30]`; `restart` em outro ⇒ assinatura F-3 da linha continua na média, R1–R5); EN-4: para cada ação × 6 kinds, 2 processos Node separados (padrão de D-1) com a mesma seed e a mesma sequência dão o mesmo SHA-256; `ENGINE_QA_SEEDS` troca a lista. DET: o próprio EN-4. *QA:* repete com `ENGINE_QA_SEEDS` de outra lista de 10 seeds.
- **T2.6** — `impactOfTick`/`accumulatedImpact` conforme ADR-013 §1–2 (testes com views montadas à mão: perda na borda, raiz com erro, raiz lenta, sem ingress, `tick` fora de `[0, now]` ⇒ `invalid_ticks`); calibração da §3: EN-6(a) ≤ 1% em 10 seeds × 360 ticks; EN-6(c) baseline + ≥ 3 noises = mesma série; sanidade por kind; medição e par escolhido na "Emenda 1 — calibração" da ADR-013; `test/public-api.test.ts` com os 2 nomes. `vitest.config.ts` tem `'src/sim/impact.ts': QC1` e a cobertura do arquivo é ≥ 80% (EN-8). DET: mesma view ⇒ mesma série. *QA:* confere a linha do threshold no `vitest.config.ts`; roda a suíte; confere a emenda contra a saída do teste.
- **T2.7** — P-1, P-2, P-3 em ≥ 10 seeds × 6 kinds × {`restart`, `rollback`} no alvo em `startTick + 6`, 30 ticks; `verify-coherence.mjs` aprova o NDJSON de uma execução com `restart` (P-4). DET: idem. *QA:* roda o bloco novo; confere que o bloco antigo não mudou (`git diff`).
- **T2.8** — `fixtures/actions/<kind>-<ação>.json` (seed `fixture`, defaults, ação no alvo em `startTick + 6`) com `ActionResult`, série `ImpactTick[]` de `[0, 60]` e o veredito de mitigação eficaz (ADR-013 §4); `fixtures/impact/<kind>.json` (sem ação) e `baseline.json`; teste regenera e compara byte a byte; `ls fixtures/*.ndjson` continua com os 7 de D-3. DET: o teste de regeneração. *QA:* `git diff --exit-code 4fe9dce -- 'packages/engine/fixtures/*.ndjson'`.
- **T2.9** — `pnpm install --frozen-lockfile` na raiz; `pnpm --filter @whodeployed/scenarios {lint,typecheck,test,build}` saem 0; `ci.yml` roda `build` antes de `lint`/`typecheck`/`test` e mantém todos os passos do GATE-1 (EN-1); `src/types.ts` entra no typecheck; `@whodeployed/engine` só em `peerDependencies` e `devDependencies`; ESLint recusa import de valor de `@whodeployed/engine` em `src/**` (`allowTypeImports`) e `test/type-only-engine.test.ts` falha com um arquivo-amostra que importa um valor (ADR-014 §1.1). *QA:* `gh run list --branch` do PR verde; diff do `ci.yml` só move o `build`.
- **T2.10** — Um teste por caso de CN-4: campo obrigatório ausente (cita arquivo e campo); `kind`/`target`/param inválido (mensagem do `EngineError` intacta, `engine` preenchido); padrão de pergunta com `kind` ou componente desconhecido; `review.keySignalAsk` ausente; `id` fora dos dois formatos; `system` desconhecido. O loader aceita várias falhas (o cenário 8 da fase 3 precisa); CN-2 é verificado sobre o YAML cru nos testes de cada cenário (T2.14–T2.17). `parseScenario`, `toSimulationConfig` e `loadScenarioFile` recebem `engine: EngineRuntime` e não importam valor do motor (ADR-014 §1.1); `toSimulationConfig` não leva texto de cenário (teste afirma as chaves). DET: mesmo texto ⇒ `Scenario` `toStrictEqual`. *QA:* lê as mensagens de erro de 3 casos.
- **T2.11** — `repertoire` = tabela das Convenções do PRD (teste transcreve a tabela); `inRepertoire` aceita/recusa cada item (Júnior: `logs` só com `window: 30` e sem `filter`; `trace`/`whatChanged`/`compare`/`rollback` recusados; Pleno: `logs` só com `window: 30`, com ou sem `filter`; `whatChanged` só com `window: 30`; `compare by lastWeek` e `askNpc` recusados; nenhuma ação Sênior em nível algum). *QA:* confere que é o único lugar (`grep -rn "tracePercentiles" packages apps` só acha o arquivo e o tipo).
- **T2.12** — `_TEMPLATE.yaml` sem `declareMitigated`; `referencePath` do exemplo `junior` só com itens do repertório Júnior; `logs` com `window: 30`; `review.keySignalAsk` presente; comentários em inglês atualizados (impacto em ticks impactados, ADR-013). *QA:* `grep -n declareMitigated packages/scenarios/scenarios/_TEMPLATE.yaml` vazio; carrega o template com o loader quando T2.10 estiver em `main` (o `_` faz o diretório ignorá-lo, o arquivo isolado carrega).
- **T2.13** — `checkMitigations` segue ADR-013 §4 e o relógio da ADR-015 §5; testes de veredito na simulação real, um por linha da ADR-012 §5 com a ação no alvo (`effective` esperado pela tabela); recebe `engine: EngineRuntime` (ADR-014 §1.1); ação sem efeito ⇒ `effective: false`; ação depois do tick 327 é verificada simulando além do 360, sem truncar a janela (ADR-013 §4); impacto no momento da ação = `accumulatedImpact(view, tick)`; limite 360. DET: 2 chamadas ⇒ `toStrictEqual`. *QA:* compara 3 vereditos com `packages/engine/fixtures/actions/*.json` (T2.8), que usa a mesma regra; a T2.13 não depende da T2.8.
- **T2.14 / T2.15 / T2.16** — YAML com todos os campos de SPEC §7 + `impactBudget` + `review` (`redundant`, `keySignal`, `keySignalAsk`); `teaches` igual à coluna "Ensina" de SPEC §7 linha 1, 3 ou 5; 1 falha com `target`/`startTick`/`params` explícitos; `noise` ≥ 1 no `03` e no `05` (regra de design do Eng. Conteúdo); CN-6: `alert.tick ≥ startTick` e a condição do `alert.text` vale na telemetria da seed no `alert.tick` (uma asserção); no `03`, conexões do alvo = `poolSize` no `alert.tick` e o alvo serve ≥ 1 request em cada tick da janela de assinatura, e `poolSize`/`leakPerTick` deixam o `restart` ser mitigação eficaz (ADR-012, consequências); CN-7: uma asserção da condição do `trap` no `alert.tick` (ex.: `03`: p50 do `gateway` ≤ 1,5× o baseline e p95 do alvo ≥ 3×; `05`: o componente com maior aumento de erro % não é o alvo). DET: telemetria da seed 2× idêntica. *QA:* confere `teaches` contra SPEC §7; lê as asserções de CN-6/CN-7.
- **T2.17** — `TA` e `TB`: `id` `test-*`; `kind` fora de {`service_crash_loop`, `connection_pool_exhaustion`, `slow_dependency`} (com ADR-012, na prática `bad_deploy` + `rollback`; alvos com impacto medido na ADR-012); `seed`, `title`, `alert.text` distintos dos de `01`/`03`/`05` e entre si; `noise` ≥ 1 e listas `{kind, target, tick}` distintas entre os 5; `TA` ≠ `TB` em `kind` ou `target`; `level: pleno`; ≥ 1 evento deploy/config em `[alert.tick − 30, alert.tick]`; CN-9 (a)–(e) e (g) nos campos (teste carrega os dois). CN-6 e CN-7 como acima. DET: idem. *QA:* roda o teste; lê os dois YAML lado a lado.
- **T2.18** — `pnpm --filter @whodeployed/scenarios build` gera `dist/data.js` e `dist/data.d.ts`; `bundle.campaign` só com `id` `NN-*` ordenados; `bundle.testIncidents` só `test-*`; YAML inválido ⇒ build sai ≠ 0 com a mensagem do loader; `dist/data.js` não importa `yaml`. DET: 2 builds ⇒ `dist/data.js` byte-idêntico. *QA:* `grep -c "from 'yaml'" packages/scenarios/dist/data.js` = 0.
- **T2.19** — O script lê todos os YAML de `scenarios/` (menos `_*`), faz `grep -F` de cada `id`, `title`, `alert.text`, `rootCause` e `teaches` em `packages/engine/src` e `apps/web/src`, sai 0 sem ocorrência e 1 listando arquivo e string; teste com árvore temporária que contém uma string; passo no CI. *QA:* planta uma string num arquivo de `apps/web/src` num branch e vê o CI falhar.
- **T2.20** — Para cada um dos 5 YAML: todo passo de `referencePath` passa em `inRepertoire(level)` (CN-5); `checkMitigations(scenario, referencePath)` tem ação eficaz com impacto < `impactBudget` (CN-5) e, nos de teste, < 50% do `impactBudget` (CN-3); sem ação, impacto acumulado ≥ `impactBudget` até `alert.tick + 2 × impactBudget` (EN-6b); CN-9 (f): impacto na mitigação de `TA` e `TB` difere ≤ 20% e < 50% do orçamento nos dois; CN-1: exatamente 5 YAML, `teaches` distintos; todo `ask` do `referencePath` é aceito pelo motor no tick em que é feito. DET: 2 replays ⇒ resultados iguais. *QA:* roda a suíte; confere CN-9 (f) com os números impressos.
- **T2.21** — `pnpm --filter @whodeployed/web build` sai 0 e o CI falha se a saída tiver `warning` (PR-1); `dist/` abre num servidor estático; `scripts/check-static.sh` falha em `.css`, `<style`, `style=`, `style:`, `<canvas`, `<svg`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` em `src/` (teste com amostra) e passa no repositório; ESLint de `apps/web` recusa `yaml` e caminhos profundos `@whodeployed/*/src|dist` (PR-19), com teste; dependências só `react`/`react-dom` + workspace; `build-info.ts` com as 2 constantes. *QA:* lê `package.json` (nenhuma lib de CSS/CSS-in-JS/UI kit); serve o `dist/`.
- **T2.22** — Com um `Scenario` de fixture e o motor real (só API pública): sessão começa em `alert.tick` com impacto de `accumulatedImpact`; `ask` avança `tickCost`; `act` avança o custo da ADR-012; `wait` avança 1; nada passa de 360 e o tick 360 encerra (`reason: 'tickLimit'`); `severe` quando impacto ≥ orçamento; pergunta/ação fora do repertório lança `SessionError` e não muda nada; `EngineError` de pergunta não custa tick nem vira passo. DET: mesma sequência 2× ⇒ mesmos `steps` sem `wallMs` (PR-12). *QA:* lê o teste de sequência fixa (tick e impacto depois de cada passo).
- **T2.23** — Hipótese exige componente entre os 9 e texto não vazio; descarte exige ≥ 1 `seq` de `ask` anterior (sem citação, citação de passo não-`ask` ou futuro ⇒ erro); fim com ativa/nova/`unknown`; depois do fim, todo método lança. DET: idem. *QA:* lê os casos de erro.
- **T2.24** — Serialização na ordem da ADR-016 (golden string de um log curto); `undefined` omitido; comparação de logs ignora só `wallMs`; nenhum campo proibido (teste afirma as chaves de topo e de passo); `storage.ts` funciona com `localStorage` real (jsdom), com `localStorage` que lança em `getItem`/`setItem` e com `localStorage` ausente; apagar remove a chave. DET: mesmo log ⇒ mesma string. *QA:* lê a lista de chaves.
- **T2.25** — Exatamente 3 frases; um teste com log sintético por ramo: (1) pergunta repetida idêntica, pergunta em `review.redundant`, nenhuma ("no redundant questions"); (2) pediu `keySignalAsk` (cita o tick) / não pediu; (3) mitigação eficaz do jogador × impacto de referência / sem mitigação (impacto no fim); nenhuma nota, estrela, porcentagem ou ranking (regex no texto). DET: mesma entrada ⇒ mesmas frases. *QA:* lê as frases dos testes contra PR-11 e PR-18.
- **T2.26** — Um teste por kind do repertório Pleno (`dashboard`, `logs`, `trace`, `whatChanged`, `compare by instance`) sobre `packages/engine/fixtures/answers/*.json`: o texto renderizado contém cada valor de `Answer.data` (tabela métrica × tick ou instância × tick; uma linha por log; árvore indentada com componente, operação, duração e status; lista de eventos), o tick do pedido e o `tickCost`; nenhum `style`, `<svg>`, `<canvas>`. *QA:* compara 3 valores renderizados com o JSON.
- **T2.27** — Lista com `id`/título/nível só da `campaign` (com bundle de fixture); `?test=<id>` abre incidente de teste e `?test=` desconhecido mostra erro em texto; DOM inicial: alerta, tick, `impact N / B`, 9 componentes, nenhum sinal; controles = `repertoire[level]` (teste por nível compara controles com a tabela; nada desabilitado, nenhum "unlocks at"); Júnior sem filtro de `logs`; `wait` avança 1; `SEVERE` aparece quando o fake passa do orçamento. *QA:* abre o build de fixture e percorre Júnior e Pleno.
- **T2.28** — Caderno: registrar e descartar citando resposta (botão de descarte sem citação não existe/não envia); fim: só revisão e export depois; DOM antes do fim não contém `rootCause`, passos de `referencePath` nem `review.*` do cenário de fixture; revisão com 3 frases; export: download de JSON e cópia para a área de transferência, a qualquer momento; lista salva sobrevive a recarregar (jsdom) e o controle apaga tudo. *QA:* joga o cenário de fixture no navegador, exporta, recarrega e exporta de novo.
- **T2.29** — `replayLog` sai `ok` para logs gerados pela sessão (fixture) e aponta o primeiro desvio em logs adulterados (um teste por `field`: `answer`, `tickCost`, `impactAfter`, `tickBefore`, `review`, `format`); `scripts/replay.ts` com exit 0/1/2; perguntas comparadas pelo JSON canônico (`filter: undefined` ≡ ausente, I24-6); passo de CI com `timeout 5` sobre `test/fixtures/logs/perf-360.json` (360 ticks, 40 perguntas). DET: replay 2× ⇒ mesmo resultado. *QA:* adultera um número num log e roda o script.
- **T2.30** — Testes com logs sintéticos que ligam e desligam cada um de R-1..R-4 (definições do Roteiro), inclusive `justification: check research note` em R-2 e R-4 usando `checkMitigations` (mock no teste unitário); recusa (exit 2) de dois logs do mesmo incidente e de log de cenário que não é de teste; imprime `pre`/`post`/`changed` e o número de perguntas de sinal até a primeira hipótese correta. DET: mesma entrada ⇒ mesma saída. *QA:* roda o script sobre 2 logs de fixture.
- **T2.31** — Passo `actions/upload-artifact` (fixado por SHA) com `name: whodeployed-prototype`, `path: apps/web/dist`, `if-no-files-found: error`, condição `github.event_name == 'push' && github.ref == 'refs/heads/main'`. *QA:* depois do merge, `gh run download <run> --name whodeployed-prototype`, serve e abre a lista.
- **T2.32** — `src/data.ts` importa `@whodeployed/scenarios/data`; teste de integração: a lista mostra exatamente `01`, `03`, `05` (PR-4) e nenhum `test-*`; DOM inicial dos 5 cenários reais (PR-5); `scripts/gen-reference-logs.ts` joga o `referencePath` de cada YAML pelo núcleo de sessão e grava 5 logs; o CI roda `replay` nos 5 (exit 0) e no `tampered.json` (exit ≠ 0); PR-12 com o `01` real. DET: regenerar os 5 logs dá os mesmos bytes (sem `wallMs`, que o gerador fixa em 0). *QA:* roda o CI localmente (`replay` nos 6) e PR-3 offline com o `01`.
- **T2.33** — README em inglês com build, `serve`, modo de teste (`?test=<id>` e os 2 ids), export, `replay`, `results`, download do artifact (`gh run download … --name whodeployed-prototype`) e o aviso de que o artifact é snapshot de desenvolvimento (ADR-009 Emenda 1); todo bloco roda verbatim com exit 0. *QA:* copia e roda cada bloco (PR-20, PR-21).
- **T2.34** — Modelo com todos os campos do formulário do Roteiro §9, seção "Ensaio" (tempos, export dos 5 logs, replay, Anexo A ≤ 1 página), tabela de intervenções (minuto, frase), ordem pré/pós de TH-5 preenchida antes; termo de consentimento (gravação só com o Diretor, nota e logs públicos); checklist do Roteiro §1; `wc -w` do Anexo A ≤ 400 colado no PR. *QA:* confere o modelo campo a campo contra o Roteiro.
- **T2.35** — Ensaio feito com o mesmo SHA de build da sessão: 5 logs exportados passam no `replay`; tempos registrados; TH-6: Anexo A ≤ 400 palavras e nenhum componente/falha/sinal de `TA`, `TB`, `01`, `03`, `05` citado (lista de nomes dos 5 YAML contra o texto); PR-3 (DevTools Offline, 0 requisições), PR-17 (≤ 1 s no tick 300, máquina e navegador registrados), PR-18 (lista de textos fora das categorias = vazia), PR-20/PR-21 verbatim. *QA:* é o próprio relatório.
- **T2.36** — `replay` nos 5 logs de `docs/research/fase-2/` (TH-2); `results` sobre `pre.json`/`post.json` colado no `GATE-2.md` (TH-3); lista de intervenções conferida (TH-4); ordem da nota × `id` dos logs (TH-5); `gh issue view 24` fechada (I24-7); todos os critérios do PRD com evidência. O QA mede; a decisão GO/NO-GO é do Diretor.
- **T2.37** — Cada item da #24 marcado com o PR que o fecha (I24-1: T2.0 + T2.1 + T2.6; I24-2, I24-3, I24-5, I24-6: T2.0; I24-4: T2.0 + T2.1; item 9 e "D-3": já resolvidos) ou "fora — FASE-2.md" com o motivo da tabela do PRD (itens 4, 8, 10, arquivos tocados); issue fechada. *QA:* `gh issue view 24` (T2.36).

## Rastreabilidade PRD → tarefas

| Critério | Tarefas |
| --- | --- |
| EN-1 | todas (regra geral); T2.9 (ordem do CI) |
| EN-2 | todas (regra geral); T2.2 (sem `act` = byte-idêntico), T2.8 |
| EN-3 | T2.0; todas (regra geral) |
| EN-4 | T2.2, T2.4, T2.5 |
| EN-5 | T2.2 (erros, grep), T2.3, T2.4, T2.5 (24 células) |
| EN-6 | T2.6 (a, c), T2.20 (b) |
| EN-7 | T2.7 |
| EN-8 | T2.2 (threshold por arquivo `'src/sim/actions.ts'`), T2.6 (threshold por arquivo `'src/sim/impact.ts'`); T2.3, T2.4, T2.5 mantêm o de `actions.ts` |
| CN-1 | T2.10 (campos), T2.14–T2.17, T2.20 (5 arquivos, `teaches`) |
| CN-2 | T2.14–T2.17 (YAML cru: 1 falha com `target`, `startTick` e `params` presentes) |
| CN-3 | T2.17 (campos), T2.13, T2.20 (mitigação < 50%); "fora da lista": T2.27, T2.32 |
| CN-4 | T2.10 |
| CN-5 | T2.11, T2.13, T2.20 |
| CN-6, CN-7 | T2.14, T2.15, T2.16, T2.17 |
| CN-8 | T2.19 |
| CN-9 | T2.17 (a–e, g), T2.13 + T2.20 (f) |
| PR-1 | T2.21 |
| PR-2 | T2.21 |
| PR-3 | T2.21 (grep), T2.32/T2.35 (offline) |
| PR-4 | T2.27, T2.32 |
| PR-5 | T2.22, T2.27, T2.32 |
| PR-6 | T2.0 (lugar), T2.11, T2.22, T2.27 |
| PR-7 | T2.26 |
| PR-8 | T2.22, T2.27 |
| PR-9 | T2.23, T2.28 |
| PR-10 | T2.23, T2.28 |
| PR-11 | T2.25, T2.28, T2.13 (impacto) |
| PR-12 | T2.22, T2.32 |
| PR-13 | T2.0 (formato, ADR-016), T2.24, T2.28 |
| PR-14 | T2.0 (lugar), T2.29, T2.32 (5 logs + adulterado no CI) |
| PR-15 | T2.30 |
| PR-16 | T2.24, T2.28 |
| PR-17 | T2.29 (CI), T2.35 (navegador) |
| PR-18 | T2.25, T2.27, T2.28, T2.35 |
| PR-19 | T2.0 (ADR-014/015), T2.9, T2.18, T2.21 |
| PR-20 | T2.33, T2.35 |
| PR-21 | T2.31, T2.33, T2.35 |
| I24-1 | T2.0 (lista na ADR-002 Em. 2), T2.1 (teste), T2.6 (2 nomes) |
| I24-2, I24-3 | T2.0 |
| I24-4 | T2.0 (decisão), T2.1 (código); PR-1/PR-3 via T2.21 |
| I24-5 | T2.0 (ADR-006 Em. 2) |
| I24-6 | T2.0 (ADR-006 Em. 2, ADR-016), T2.24, T2.29 |
| I24-7 | T2.37, T2.36 (conferência) |
| TH-1 | T2.34 (modelo), ensaio (moderador), T2.35 |
| TH-2 | T2.34 (formulário), sessão (Diretor), T2.36 |
| TH-3 | T2.30 (script), T2.36 (medição), Diretor (decisão) |
| TH-4, TH-5 | T2.34, T2.36 |
| TH-6 | T2.34 (contagem), T2.35 (nomes) |

Todo critério do PRD (EN-1..EN-8, CN-1..CN-9, PR-1..PR-21, I24-1..I24-7, TH-1..TH-6) tem ao menos uma tarefa.

## Decisões delegadas tomadas nesta quebra (uma linha cada; detalhe na ADR)

- `$PROTO = apps/web`, núcleo de sessão em TS puro, scripts em `apps/web/scripts` (ADR-015): o protótipo é a primeira versão do jogo no pacote que SPEC §6 reserva para ele.
- `restart` custa 2 ticks e derruba o alvo por 1 tick; `rollback` custa 3, só age se houver deploy a reverter e não derruba (ADR-012): dá custo a agir às cegas e valor a perguntar "o que mudou?".
- Efeito de ação vem de reações por kind em tabela de dados (ADR-012 §5), não do cenário: EN-5.
- Impacto = ticks em que ≥ 5% das requests de entrada se perdem, falham ou passam de 1 s (ADR-013): função pura de spans, 0% no baseline medido.
- Tipos de cenário fora do motor, em `packages/scenarios/src/types.ts` (ADR-014): EN-5 proíbe os nomes no motor.
- `review.keySignalAsk` novo no YAML (ADR-014): PR-11 frase 2 precisa de algo casável por máquina; não muda campo de SPEC §7.
- Repertório e `checkMitigations` com uma implementação só, no pacote de cenários (ADR-014): PR-6 e a regra de "mitigação eficaz" são usados por conteúdo e por UI.
- `build` antes de `lint`/`typecheck`/`test` no CI (ADR-014 §4): a UI resolve os pacotes pelo `dist/`.
- `packages/scenarios/src` só importa tipos do motor; o runtime entra como argumento `EngineRuntime` (ADR-014 §1.1): cumpre CN-4/CN-5 sem mudar SPEC §6 ("engine (tipos)").
- Janela fixa de 30 ticks para `logs` (Júnior e Pleno) e `whatChanged` (Pleno) (ADR-014 §3): o PRD dá ao Pleno "tudo do Júnior; `logs` com `filter`" e SPEC §5 não fala de outra janela.
- Threshold de cobertura por arquivo para `actions.ts` e `impact.ts` (T2.2, T2.6): o glob `src/sim/**` é agregado e não garante EN-8.
- Mitigação eficaz depois do tick 327 simula além do 360, sem truncar a janela (ADR-013 §4): 360 é limite da sessão, não do motor.
- Log com o `Answer` inteiro e JSON canônico (ADR-016): replay compara resposta a resposta e o QA lê o que o júnior viu.
- Ciclo ESM removido, não só registrado (ADR-002 Emenda 2 §2.4): o bundle de navegador é novo nesta fase.
- `TA`/`TB` serão, na prática, `bad_deploy` em alvos diferentes (ADR-012, consequências): é o único kind fora dos jogados que `restart`/`rollback` mitigam; CN-3 permite.

## Conferência contra SPEC §3 e §4

| # | Princípio | Como as tarefas respeitam |
| --- | --- | --- |
| 1 | A mecânica é a habilidade | Nenhuma tarefa acrescenta pontos, XP, nota ou narrativa; a revisão são 3 frases sem nota (T2.25, PR-11); nenhum texto que ensine as 4 práticas na interface (PR-18 em T2.25/T2.27/T2.28/T2.35). Ações e impacto existem porque o loop de SPEC §4 tem "mitigar" e "relógio de impacto". |
| 2 | Progressão = perguntas, não ferramentas | O motor continua sem nível (grep Q-1/EN-5 em T2.2); o repertório é dado num único lugar (T2.11) e o que está fora não aparece nem desabilitado (T2.27); nenhuma pergunta ou ação nova além de SPEC §5; `scale`/Sênior fora. |
| 3 | Telemetria gerada, nunca roteirizada | Toda tarefa `motor` e toda que repete o motor tem `DET`; o efeito de ação vem do estado (ADR-012), o impacto vem de spans (ADR-013), nenhum dos dois conhece cenário (EN-5, EN-6); EN-7 mantém a coerência com ações; replay prova a sessão (T2.29, T2.32). |
| 4 | Sinais mentem como na vida real | Cada YAML tem teste do `trap` (CN-7, T2.14–T2.17); `ActionResult` não diz se a ação funcionou; `restart` em quem grita não resolve `slow_dependency` (ADR-012 §5); `whatChanged` não marca a origem dos eventos. |
| 5 | Mitigar é válido sem root cause | `restart`/`rollback` mitigam sem mostrar causa; o reset do pool compra tempo sem curar (ADR-012); R-4 e a frase 3 da revisão medem mitigação eficaz antes da hipótese correta (T2.25, T2.30). |
| 6 | Web-first, zero instalação | Build estático servido por qualquer servidor (T2.21); sem `fetch`/WebSocket/beacon (PR-3, T2.21); estado em `localStorage` com fallback (T2.24); nenhuma tarefa cria backend; o artifact é arquivo estático (T2.31). |
| 7 | Conteúdo é dado | Os 5 incidentes são YAML (T2.14–T2.17); repertório é dado (T2.11); CN-8 bloqueia string de cenário em código (T2.19); a UI recebe os cenários por bundle gerado do YAML (T2.18); o template é corrigido para contribuidores (T2.12). |
| 8 | Escopo pequeno e público | 38 tarefas ≤ 1 dia; protótipo sem estilo; artifact de CI em todo push verde em `main` como "algo no ar" (T2.31, decisão 3 do PM); Pages fica para a fase 3. |

Escopo SPEC §4: só o `default-shop` e os 9 componentes; só os sinais existentes (nenhuma métrica nova; o impacto é derivado de spans); 3 cenários da campanha (`01`, `03`, `05`) e 2 incidentes de teste (SPEC §2/§10 v1.1, ADR-011); loop completo em texto; nada de mapa, CSS, arte, i18n, Pages, Lighthouse, 390 px (fase 3), `schema.json`/`validate` (fase 4), backend, contas, telemetria automática, SLO/OTel ou integrações (fora). Itens da #24 fora (4, 8, 10, arquivos tocados) não têm tarefa.

## Pendências para o Diretor

Só itens (a) gate, (b) alteração do `SPEC.md`, (c) SPEC §12 do autor, (d) ação irreversível ou pública:

1. **(a) Gate 2 (GO/NO-GO).** Depois de T2.36: decidir com a saída de `results` (TH-3), as respostas 1 e 5 da entrevista e os logs de `01`/`03`/`05`. Também é do Diretor: indicar o moderador (nunca um engenheiro do protótipo), recrutar o júnior, guardar a gravação fora do repositório e registrar no `GATE-2.md` que ela existe e a data (TH-2).
2. **(c) Tom narrativo (SPEC §12, aberta): não bloqueia.** O PRD já registra que os modelos das 3 frases da revisão (T2.25) seguem o tom se o Diretor decidir antes; se não, são reescritos na fase 3 sem mudar critério. Nenhuma ação pedida agora.

Nenhum item (b) ou (d). SPEC §6 ("`packages/scenarios` depende de engine (tipos)") é cumprido sem alteração: o código de `scenarios/src` só importa tipos e recebe o runtime do motor por injeção (ADR-014 §1.1), então CN-4 e CN-5 não pedem mudança do spec. Nenhuma tarefa altera o `SPEC.md`; o artifact `whodeployed-prototype` é snapshot de CI já decidido no PRD (PR-21, decisão 3 do PM) e na ADR-009 Emenda 1, não é release, tag nem post.
