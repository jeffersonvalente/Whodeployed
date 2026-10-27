# ADR-014 — Pacote de cenários na fase 2: tipos, loader, padrões de pergunta, repertório e bundle para a UI

- **Status:** aceita
- **Data:** 2026-10-26
- **Decisor:** Arquiteto (decisões delegadas, SPEC §12: "estrutura interna", "biblioteca de validação de schema"; PRD FASE-2 PR-6 "tabela de repertório ... num único lugar (definido em ADR)")
- **Referência:** SPEC §3.7, §5, §6 ("a UI não conhece YAML"), §7; PRD FASE-2 CN-1..CN-9, PR-4, PR-6, PR-11, PR-19, EN-5; ADR-001, ADR-002 Emenda 1 §6.1, ADR-004, ADR-012

## Contexto

`packages/scenarios` tem só o `_TEMPLATE.yaml`. A fase 2 precisa de um loader tipado com erro legível (CN-4), de 5 YAML (CN-1), de uma tabela de repertório usada pelo CI de conteúdo (CN-5) e pela interface (PR-6), e de um jeito de a interface receber os cenários sem conhecer YAML (SPEC §6, PR-19). O motor não pode conhecer os conceitos de cenário (EN-5: nenhum `referencePath`, `rootCause`, `teaches` ou `trap` em `packages/engine/src`), então o contrato de cenário não pode morar em `packages/engine/src/types.ts`.

## Decisão

### 1. Pacote e contrato

- Nome `@whodeployed/scenarios`, `private: true` (não é publicado na fase 2), ESM, TypeScript estrito com as mesmas opções da ADR-008. Depende de `@whodeployed/engine` (`workspace:*`, só pelo ponto de entrada público) e de `yaml` (ADR-001). `ajv` e `schema.json` ficam para a fase 4 (PRD, "Fora de escopo").
- Contrato em `packages/scenarios/src/types.ts` (dono: Arquiteto; engenheiros não editam). Exporta `Scenario`, `ReferenceStep`, `ReviewSpec`, `QuestionPattern`, `Repertoire`, `RepertoireTable`, `ScenarioErrorInfo`, `ScenarioBundle` e os tipos das funções.
- Layout:

```
packages/scenarios/
  scenarios/*.yaml          5 YAML da fase + _TEMPLATE.yaml (ignorado pelo loader: prefixo "_")
  src/types.ts              contrato (Arquiteto)
  src/index.ts              API pública (navegador e Node): tipos + parseScenario, toSimulationConfig,
                            matchesPattern, repertoire, inRepertoire, checkMitigations, ScenarioError
  src/errors.ts             class ScenarioError implements ScenarioErrorInfo
  src/load.ts               parseScenario (yaml -> Scenario)
  src/node.ts               loadScenarioFile / loadScenarioDir (node:fs; só Node: scripts e testes; export "./node")
  src/patterns.ts           parse e matchesPattern
  src/repertoire.ts         a tabela de repertório (único lugar, PR-6) e inRepertoire
  src/mitigation.ts         checkMitigations: regra de mitigação eficaz da ADR-013 §4 (única implementação)
  scripts/build-data.mjs    gera dist/data.js + dist/data.d.ts (bundle para a UI)
  scripts/check-not-in-code.mjs   CN-8
  test/                     loader, repertório, um arquivo de teste por cenário, replay (CN-5/EN-6b/CN-9)
```

### 2. Formato YAML (SPEC §7 mais o que a fase usa)

- Todos os campos de SPEC §7; obrigatórios na fase 2 também `impactBudget` (inteiro ≥ 1) e `review` (CN-1).
- `faults[*]` passa por `resolveFaults` do motor; `EngineError` vira `ScenarioError` com `field` prefixado pelo caminho no YAML e `engine` = o erro original, com a mensagem do motor intacta (CN-4, F-7). `noise` é validado da mesma forma (`createSimulation`/`validateNoise` do motor via `toSimulationConfig`).
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
| `pleno` | sim | janela livre, com filtro | 50, 95, 99 | sim | `by: 'instance'` | `restart`, `rollback` |

`inRepertoire(level, step)` é a função pura que o teste de CN-5 e a sessão do protótipo (PR-6) usam. O motor nunca a importa (Q-1).

### 3.1 Mitigação eficaz: uma implementação só

`checkMitigations(scenario, steps)` (`src/mitigation.ts`) repete uma sequência de passos (perguntas, ações e `wait`) numa simulação nova do cenário a partir do `alert.tick` e diz, para cada ação, se ela é mitigação eficaz (ADR-013 §4) e qual o impacto acumulado no momento dela. É a única implementação da regra: os testes de conteúdo (CN-3, CN-5, CN-9f) chamam com o `referencePath`, e o protótipo chama com os passos do jogador (PR-11 frase 3, R-4 de PR-15) e com o `referencePath` (impacto de referência da frase 3). A regra de relógio é a da sessão (ADR-015): pergunta e ação avançam `tickCost`, `wait` avança 1, nunca além do tick 360.

### 4. Bundle para a UI (SPEC §6 "a UI não conhece YAML"; PR-19)

- `pnpm --filter @whodeployed/scenarios build` = `tsc` + `scripts/build-data.mjs`, que carrega todos os YAML com o próprio loader e escreve `dist/data.js` (`export const bundle = {...}` com `campaign` e `testIncidents` ordenados por `id`) e `dist/data.d.ts` (tipado como `ScenarioBundle`). YAML inválido = build falha.
- `package.json` `exports`: `"."` → `dist/index.js` (API e tipos), `"./data"` → `dist/data.js` e `"./node"` → `dist/node.js`. A UI importa `@whodeployed/scenarios/data` e nunca importa `yaml` (PR-19). `src/node.ts` não é reexportado por `"."` para o bundle do navegador não puxar `node:fs`; scripts Node importam `@whodeployed/scenarios/node`.
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
