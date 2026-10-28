# ADR-014 — Pacote de cenários na fase 2: tipos, loader, padrões de pergunta, repertório e bundle para a UI

- **Status:** aceita
- **Data:** 2026-10-26
- **Decisor:** Arquiteto (decisões delegadas, SPEC §12: "estrutura interna", "biblioteca de validação de schema"; PRD FASE-2 PR-6 "tabela de repertório ... num único lugar (definido em ADR)")
- **Referência:** SPEC §3.7, §5, §6 ("a UI não conhece YAML"), §7; PRD FASE-2 CN-1..CN-9, PR-4, PR-6, PR-11, PR-19, EN-5; ADR-001, ADR-002 Emenda 1 §6.1, ADR-004, ADR-012

## Contexto

`packages/scenarios` tem só o `_TEMPLATE.yaml`. A fase 2 precisa de um loader tipado com erro legível (CN-4), de 5 YAML (CN-1), de uma tabela de repertório usada pelo CI de conteúdo (CN-5) e pela interface (PR-6), e de um jeito de a interface receber os cenários sem conhecer YAML (SPEC §6, PR-19). O motor não pode conhecer os conceitos de cenário (EN-5: nenhum `referencePath`, `rootCause`, `teaches` ou `trap` em `packages/engine/src`), então o contrato de cenário não pode morar em `packages/engine/src/types.ts`.

## Decisão

### 1. Pacote e contrato

- Nome `@whodeployed/scenarios`, `private: true` (não é publicado na fase 2), ESM, TypeScript estrito com as mesmas opções da ADR-008. Depende de `yaml` (ADR-001). `@whodeployed/engine` (`workspace:*`, só pelo ponto de entrada público) entra em `peerDependencies` (tipos) e em `devDependencies` (testes e scripts), **nunca** em `dependencies`: ver §1.1. `ajv` e `schema.json` ficam para a fase 4 (PRD, "Fora de escopo").
### 1.1 Só tipos do motor no código do pacote (SPEC §6)

SPEC §6 diz que `packages/scenarios` depende de "engine (tipos)". O loader (CN-4: propagar o `EngineError` do motor), `toSimulationConfig` e `checkMitigations` (CN-5) precisam do motor em runtime, então o runtime é **injetado** pelo chamador:

- Todo arquivo de `packages/scenarios/src/` importa de `@whodeployed/engine` só com `import type`. Regra de lint: `@typescript-eslint/no-restricted-imports` em `src/**` com `{ name: '@whodeployed/engine', allowTypeImports: true }`, e um teste que falha num import de valor (arquivo-amostra).
- Funções que precisam do motor recebem `engine: EngineRuntime` (`src/types.ts` §0): `{ resolveFaults, createSimulation, accumulatedImpact, systems }`. Quem chama monta o objeto a partir do ponto de entrada público do motor: os testes e scripts deste pacote (`test/`, `scripts/build-data.mjs`, `scripts/check-not-in-code.mjs`, com o motor em `devDependencies`) e o `apps/web`, que pelo SPEC §6 depende do motor.
- Com isso CN-4 e CN-5 ficam cumpridos sem runtime do motor no código do pacote, e SPEC §6 não muda.

- Contrato em `packages/scenarios/src/types.ts` (dono: Arquiteto; engenheiros não editam). Exporta `Scenario`, `ReferenceStep`, `ReviewSpec`, `QuestionPattern`, `Repertoire`, `RepertoireTable`, `ScenarioErrorInfo`, `ScenarioBundle` e os tipos das funções.
- Layout:

```
packages/scenarios/
  scenarios/*.yaml          5 YAML da fase + _TEMPLATE.yaml (ignorado pelo loader: prefixo "_")
  src/types.ts              contrato (Arquiteto)
  src/index.ts              API do navegador: tipos + toSimulationConfig, matchesPattern, repertoire,
                            inRepertoire, checkMitigations, ScenarioError (Emenda 1: nada alcançável importa yaml/node:*)
  src/errors.ts             class ScenarioError implements ScenarioErrorInfo
  src/config.ts             toSimulationConfig (Emenda 1)
  src/load.ts               parseScenario (yaml -> Scenario); exportado só por "./node" (Emenda 1)
  src/node.ts               parseScenario, loadScenarioFile / loadScenarioDir (node:fs; só Node: scripts e testes; export "./node")
  src/patterns.ts           parse e matchesPattern
  src/repertoire.ts         a tabela de repertório (único lugar, PR-6) e inRepertoire
  src/mitigation.ts         checkMitigations: regra de mitigação eficaz da ADR-013 §4 (única implementação)
  scripts/build-data.mjs    gera dist/data.js + dist/data.d.ts (bundle para a UI)
  scripts/check-not-in-code.mjs   CN-8
  test/                     loader, repertório, um arquivo de teste por cenário, replay (CN-5/EN-6b/CN-9)
```

### 2. Formato YAML (SPEC §7 mais o que a fase usa)

- Todos os campos de SPEC §7; obrigatórios na fase 2 também `impactBudget` (inteiro ≥ 1) e `review` (CN-1).
- `faults[*]` passa por `engine.resolveFaults` (injetado, §1.1); `EngineError` vira `ScenarioError` com `field` prefixado pelo caminho no YAML e `engine` = o erro original, com a mensagem do motor intacta (CN-4, F-7). `noise` é validado da mesma forma (`engine.createSimulation` sobre o resultado de `toSimulationConfig`, que lança o `invalid_noise` do motor).
- `referencePath[*]`: `{ ask: <QuestionKind>, ...campos da Question }` vira `{ type: 'ask', question }`; `{ act: <kind>, target? }` vira `{ type: 'act', action }`. Exemplo: `{ ask: logs, service: catalog, window: 30 }`. A forma da pergunta é validada pelo motor (simulação do cenário + `ask` no `alert.tick`) no teste de replay, não no loader.
- **Padrões de pergunta** (`review.redundant[*]` e o novo `review.keySignalAsk`): string `"<kind>"` ou `"<kind> <componente>"`, ex.: `"dashboard gateway"`, `"whatChanged"`. Casa com toda pergunta daquele `kind` (e componente), quaisquer outros parâmetros. `kind` ou componente desconhecido = `ScenarioError`.
- **`review.keySignalAsk`** (novo, obrigatório na fase 2): o padrão da pergunta cuja resposta contém o `keySignal`. PR-11 (frase 2) precisa saber se o jogador fez essa pergunta e em que tick; o `keySignal` é texto livre e não dá para casar por máquina. É um campo a mais, não muda nenhum campo de SPEC §7.
- `id`: `^[0-9]{2}-[a-z0-9-]+$` para a campanha; `^test-[a-z0-9-]+$` para incidente de teste (`testIncident: true`, CN-3). `system`: na fase 2 só `default-shop` (→ `defaultShop` do motor).
- `level: senior` é aceito pelo formato, mas `inRepertoire` não tem repertório Sênior nesta fase; CN-5 reprova qualquer YAML Sênior.
- Os YAML são dado: nenhuma string de cenário entra em `$ENGINE/src` nem em `apps/web/src` (CN-8, script `check-not-in-code.mjs`).

### 3. Repertório (PR-6, CN-5)

`packages/scenarios/src/repertoire.ts` é o **único** lugar da tabela (dado `RepertoireTable`), transcrita do PRD (Convenções):

| Nível | `dashboard` | `logs` | `trace` | `whatChanged` | `compare` | Ações |
| --- | --- | --- | --- | --- | --- | --- |
| `junior` | sim | `window: 30` fixo, sem filtro | — | não | — | `restart` |
| `pleno` | sim | `window: 30` fixo, com ou sem filtro | 50, 95, 99 | `window: 30` fixo | `by: 'instance'` | `restart`, `rollback` |

Janelas fixas em 30 ticks (decisão delegada): o PRD dá ao Pleno "tudo do Júnior; `logs` com `filter`", sem nada a mais, e SPEC §5 só fala em "últimos 5 min" (`logs`) e "deploys/configs recentes" (`whatChanged`); 30 ticks = 5 min (ADR-006) é a única janela que os dois textos sustentam, e é a do `referencePath` de SPEC §7 e do CN-3.

`inRepertoire(level, step)` é a função pura que o teste de CN-5 e a sessão do protótipo (PR-6) usam. O motor nunca a importa (Q-1).

### 3.1 Mitigação eficaz: uma implementação só

`checkMitigations(scenario, steps, engine)` (`src/mitigation.ts`) repete uma sequência de passos (perguntas, ações e `wait`) numa simulação nova do cenário a partir do `alert.tick` e diz, para cada ação, se ela é mitigação eficaz (ADR-013 §4) e qual o impacto acumulado no momento dela. É a única implementação da regra: os testes de conteúdo (CN-3, CN-5, CN-9f) chamam com o `referencePath`, e o protótipo chama com os passos do jogador (PR-11 frase 3, R-4 de PR-15) e com o `referencePath` (impacto de referência da frase 3). A regra de relógio é a da sessão (ADR-015): pergunta e ação avançam `tickCost`, `wait` avança 1, nunca além do tick 360. A janela de 30 ticks depois de uma ação não é truncada: a verificação simula além do 360 se precisar (ADR-013 §4).

### 4. Bundle para a UI (SPEC §6 "a UI não conhece YAML"; PR-19)

- `pnpm --filter @whodeployed/scenarios build` = `tsc` + `scripts/build-data.mjs`, que carrega todos os YAML com o próprio loader (com o `EngineRuntime` montado do motor, que o script tem em `devDependencies`) e escreve `dist/data.js` (`export const bundle = {...}` com `campaign` e `testIncidents` ordenados por `id`) e `dist/data.d.ts` (tipado como `ScenarioBundle`). YAML inválido = build falha.
- `package.json` `exports`: `"."` → `dist/index.js` (API e tipos), `"./data"` → `dist/data.js` e `"./node"` → `dist/node.js`. A UI importa `@whodeployed/scenarios/data` e nunca importa `yaml` (PR-19). `src/node.ts` não é reexportado por `"."` para o bundle do navegador não puxar `node:fs` nem `yaml` (Emenda 1); scripts Node importam `@whodeployed/scenarios/node`.
- Consequência para o CI: o `build` dos pacotes passa a rodar **antes** de `lint`, `typecheck` e `test` no `ci.yml` (a UI precisa do `dist/` do motor e dos cenários). Nenhum passo do GATE-1 sai do workflow (EN-1); só muda a posição do `build`.

## Consequências

- Eng. Conteúdo e Eng. UI trabalham em paralelo sobre `src/types.ts`: a UI testa com cenários de fixture em `apps/web/test/fixtures/`, sem esperar os YAML reais.
- O `_TEMPLATE.yaml` muda para o formato desta ADR (`keySignalAsk`, janela de `logs` em ticks, nenhum `declareMitigated` em exemplo `junior`; decisão delegada 2 do PM no PR #75).
- Na fase 4, `schema.json` (JSON Schema, `ajv`) reescreve a validação de campos do loader; a regex de nome de componente da ADR-002 Emenda 1 §6.1 continua valendo.

## Alternativas descartadas

- **Tipos de cenário em `packages/engine/src/types.ts`:** violaria EN-5 (grep de `referencePath|rootCause|teaches|trap` no motor) e SPEC §6 (o motor não conhece cenário).
- **A UI parseia YAML no navegador (plugin do Vite ou import de `yaml`):** fere "a UI não conhece YAML" (SPEC §6) e PR-19.
- **JSON gerado e versionado em `apps/web/src`:** as strings dos cenários entrariam em `$PROTO/src` (CN-8) e o arquivo poderia divergir do YAML.
- **Repertório no protótipo e cópia no teste de conteúdo:** duas tabelas divergem; PR-6 exige um único lugar, e CN-5 e PR-6 precisam da mesma.
- **Casar `keySignal` por texto livre:** frágil e impossível de testar por máquina.
- **Motor em `dependencies` do pacote de cenários, com import de valor em `src/`:** contraria SPEC §6 ("engine (tipos)"); a injeção do `EngineRuntime` cumpre CN-4 e CN-5 sem mudar o spec.

## Emenda 1 — 2026-10-27 (QA de #97 e #95: `yaml` no bundle do navegador; ligação de `createSession`)

### Contexto

A §1 pôs `parseScenario` na entrada `.`, descrita como "API pública (navegador e Node)". `src/load.ts` importa `yaml`. O QA do #97 mediu: quando `apps/web/src` importa qualquer valor de `.` (ex.: `matchesPattern`), o `dist/` do web sobe de 142.7 kB para 171.2 kB e passa a conter a biblioteca (`tag:yaml.org,2002`, 3 ocorrências). O Rollup descarta o código de `load.ts`, mas mantém `yaml`, porque o pacote não declara `sideEffects`. O lint de imports de `apps/web` (PR-19) só vê imports diretos e não pega o transitivo. Isso contraria o espírito de SPEC §6 ("a UI não conhece YAML") e o mesmo raciocínio que já tirou `node.ts` de `.` (§4). A T2.22 (#95) exporta só `makeCreateSession(rules)`, e nenhuma tarefa tinha `src/session/session.ts` na lista de arquivos para fazer a ligação com as funções reais.

### Decisão

1. **A entrada `.` não alcança `yaml` nem `node:*`.** Todo módulo alcançável a partir de `src/index.ts` por import de valor é um módulo relativo do próprio pacote (o motor continua só como tipo, §1.1). `parseScenario` sai de `.` e passa a ser exportado por `./node`, ao lado de `loadScenarioFile` e `loadScenarioDir`. `./node` é a entrada das ferramentas Node: loader YAML e leitura de disco. `toSimulationConfig` sai de `src/load.ts` para `src/config.ts` e continua em `.`, porque a sessão do navegador precisa dele (ADR-015 §5). O layout da §1 foi atualizado no lugar; as linhas que mudam são:

```
  src/index.ts              API do navegador: tipos + toSimulationConfig, matchesPattern, repertoire,
                            inRepertoire, checkMitigations, ScenarioError. Nada alcançável importa yaml/node:*
  src/config.ts             toSimulationConfig (Scenario -> SimulationConfig)
  src/load.ts               parseScenario (yaml -> Scenario); exportado só por "./node"
  src/node.ts               "./node": parseScenario, loadScenarioFile, loadScenarioDir (scripts, testes, build-data)
```

   Quem usa `parseScenario` (testes do pacote, `scripts/build-data.mjs` da T2.18, scripts de `apps/web`) importa de `@whodeployed/scenarios/node`. A ADR-015 §4 já autoriza `./node` nos scripts e veta em `apps/web/src`.

2. **Duas verificações, uma por camada:**
   - `packages/scenarios/test/browser-entry.test.ts`: percorre o grafo de imports de valor a partir de `src/index.ts` e falha se aparecer qualquer especificador não relativo (`yaml`, `node:*` ou outro pacote) ou se `load.ts`/`node.ts` forem alcançados. Um caso de controle prova que o mesmo percurso, a partir de `src/node.ts`, encontra `yaml` e `node:fs`.
   - `apps/web/test/bundle.test.ts`: faz um build de produção real com o `vite.config.ts` do web (mesmos plugins, `define` e `onwarn` de PR-1) num diretório temporário, com uma entrada extra (`test/bundle/probe.ts`) que alcança todos os exports de valor de `@whodeployed/scenarios` `.` e o `createSession` ligado. Falha se o JavaScript emitido contiver `tag:yaml.org,2002` (marcador da biblioteca `yaml`) ou `__vite-browser-external` (stub do Vite para built-in do Node). Também falha se não contiver as strings da sessão e de `config.ts`, para a verificação não passar no vazio.

   Escolhemos teste do Vitest em vez de passo novo no `ci.yml`. O teste roda em `pnpm -r test` local e no CI, sem passo novo no workflow, que outras tarefas da onda também editam. A entrada de prova cobre `.` inteiro mesmo antes de `app.tsx` alcançar a sessão (T2.27/T2.28): hoje o `dist/` real não importa `session.ts`, e um grep só no `dist/` passaria no vazio. O custo é um build a mais no `test` do web, cerca de 3 s.

3. **Ligação de `createSession` (ADR-015 §5):** `apps/web/src/session/session.ts` exporta `createSession: CreateSession = makeCreateSession({ inRepertoire, toSimulationConfig })`, com as funções reais de `.`. Com isso o web passa a importar valor de `.`, e a verificação do item 2 cobre esse import. `makeCreateSession` continua exportado para os testes que injetam regras. A UI (T2.27 em diante) e os scripts Node (T2.29, T2.32) usam `createSession`.

### Alternativas descartadas

- **Só `"sideEffects": false` em `packages/scenarios/package.json`:** o QA mediu que resolve no build de produção (142.9 kB, sem marcador). Mas a garantia depende da heurística de tree-shaking do bundler. O servidor de desenvolvimento do Vite (`pnpm dev`) continuaria carregando `yaml` no navegador. E a regra "a UI não conhece YAML" ficaria implícita, dependendo de uma flag que qualquer `import` com efeito colateral no pacote invalidaria sem aviso. Com a separação por entrada, a fronteira é estrutural e testável no código-fonte. A flag não foi adicionada, para que a verificação do `dist/` não seja mascarada por ela.
- **Entrada nova `./yaml` ou `./loader` só para `parseScenario`:** equivalente, mas acrescenta uma terceira entrada Node. Os únicos consumidores de `parseScenario` já são Node e já usam `./node`.
- **Grep do `dist/` real num passo de CI:** passa no vazio enquanto `app.tsx` não alcança a sessão, e só roda depois de `pnpm build`.

### Consequências

- `@whodeployed/scenarios` `.` perde `parseScenario`. Na data desta emenda, nenhum código fora de `packages/scenarios` o importava de `.`. Os PRs abertos #92 (T2.23) e #93 (T2.19) não o usam.
- T2.18 (`build-data.mjs`) importa `parseScenario`/`loadScenarioDir` de `@whodeployed/scenarios/node`. T2.27 usa `createSession`, nunca `makeCreateSession`. As linhas das tarefas em `FASE-2.tasks.md` foram atualizadas.
- O tamanho do `dist/` do web deixa de depender de quais valores de `.` a UI importa, no que diz respeito ao `yaml`.
