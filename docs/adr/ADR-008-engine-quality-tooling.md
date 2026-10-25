# ADR-008 — Ferramentas de qualidade do pacote engine: tsconfig, Vitest, cobertura, lint e CI

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor")
- **Referência:** SPEC §10; ADR-001; PRD CT-2, CT-3, D-1, D-2, D-4, QC-1, QC-2, CLI-3..CLI-5, PUB-1

## Contexto

O PRD exige `strict: true` (CT-2), thresholds de cobertura que falham o comando de teste (QC-1), regra de lint contra `Math.random` (D-4) e um CI que roda typecheck, testes, determinismo, CLI e empacotamento (QC-2). Hoje `packages/engine` só tem `src/types.ts` e um `tsconfig.json` mínimo; o CI raiz roda `pnpm install --frozen-lockfile` sem lockfile.

## Decisão

- **TypeScript:** `packages/engine/tsconfig.json` (typecheck de `src`, `test`, `scripts` e configs, `noEmit`) com `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module/moduleResolution: NodeNext`, `lib: ES2022` (sem `DOM` nem `@types/node` em `src/` da biblioteca; `src/cli` e testes recebem `@types/node` via `tsconfig` próprio ou `types`). `tsconfig.build.json` estende e emite `dist/` só de `src/`.
- **Scripts do pacote** (todos criados no scaffolding; tarefas posteriores não editam `package.json`): `build`, `typecheck` (`tsc --noEmit`), `lint`, `test` (`vitest run --coverage`), `fixtures` (`node scripts/gen-fixtures.mjs`), `verify` (`node scripts/verify-coherence.mjs`), `smoke:pack` (`bash scripts/pack-smoke.sh`), `dev:cli` (`tsx src/cli/main.ts`).
- **Vitest + `@vitest/coverage-v8`:** `coverage.include: ['src/**']`, `exclude: ['src/types.ts', 'src/cli/**']`; `thresholds` por glob `'src/sim/**'` e `'src/faults/**'` com `lines`, `branches`, `functions`, `statements` = 80 (QC-1). `pnpm --filter ./packages/engine test` falha abaixo disso.
- **ESLint (flat config, `typescript-eslint`)** em `packages/engine/eslint.config.js`: `no-restricted-properties` para `Math.random`, `Date.now`, `performance.now`, `crypto.getRandomValues`, `crypto.randomUUID`; `no-restricted-globals` para `Date`, `Intl`, `performance`, `crypto`, `setTimeout`, `setInterval`; `no-restricted-syntax` para `toLocaleString`/`localeCompare`; `no-restricted-imports` bloqueando qualquer especificador não relativo em `src/**` exceto `src/cli/**`, e em `src/cli/**` bloqueando tudo além de `node:util` e `node:process`. Regras desligadas em `test/**`.
- **Testes de fronteira** (além do lint, porque o PRD pede teste): `test/boundaries.test.ts` varre `src/` e falha em import não relativo fora de `src/cli/` (CT-3), nos padrões de D-4, em `launch-day|0[1-8]-[a-z]` (S-5) e em `junior|pleno|senior|playerLevel` (Q-1).
- **CI** (`.github/workflows/ci.yml`, um job `check`, obrigatório em `main` por QC-3, que o Diretor configura): install com lockfile → `lint` → `typecheck` → `test` (cobertura) → `build` → passos de shell do engine: D-1 (2× por kind + baseline, `sha256sum`), D-2 (`TZ=UTC LANG=C` vs `TZ=Asia/Tokyo LANG=pt_BR.UTF-8`), CLI-3 (exit ≠ 0, stderr não vazio, stdout vazio), CLI-4 (`grep` no help), CLI-5 (`timeout 10` por kind, 360 ticks), PUB-1 (`smoke:pack`), P-4 (`verify` sobre a saída de cada kind). Os passos ficam em `packages/engine/scripts/ci-engine.sh`, chamado pelo workflow.
- Dependências de desenvolvimento fixadas no scaffolding: `typescript@~5.6`, `vitest@^2`, `@vitest/coverage-v8@^2`, `eslint@^9`, `typescript-eslint@^8`, `@types/node@^22`, `tsx@^4`. Nenhuma em `dependencies`.

## Consequências

- Uma tarefa que deixa `sim` ou `faults` abaixo de 80% fica vermelha no próprio PR.
- O lint roda em `src/` inteiro desde o primeiro PR; `Math.random` só aparece em `test/` (CLAUDE.md).

## Alternativas descartadas

- **Thresholds globais:** o SPEC fixa 80% em `sim` e `faults`; global esconderia um módulo fraco atrás de outro forte.
- **Só grep, sem ESLint:** o PRD (D-4) pede regra de lint ativa.
- **Jest:** ADR-001 fixa Vitest.
