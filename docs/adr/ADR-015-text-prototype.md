# ADR-015 — Protótipo de texto: lugar (`apps/web`), núcleo de sessão, scripts de replay e resultados, build e artifact de CI

- **Status:** aceita
- **Data:** 2026-10-26
- **Decisor:** Arquiteto (decisões delegadas: PRD FASE-2 "`$PROTO` ... é decisão do Arquiteto em ADR"; PR-14 "lugar definido em ADR"; SPEC §12 "estrutura interna", "layout do painel")
- **Referência:** SPEC §3.6, §3.8, §4, §6, §8 (fase 2); PRD FASE-2 PR-1..PR-21, I24-4, I24-6; ADR-001, ADR-008, ADR-009 Emenda 1, ADR-012, ADR-013, ADR-014, ADR-016

## Contexto

O PRD pede uma página HTML sem estilo que roda o loop de SPEC §4 sobre o motor, com log exportável, replay e script de resultados em Node, e um build estático publicado como artifact de CI. Ele deixa ao Arquiteto o lugar do protótipo, o lugar do replay e o formato do log (este último na ADR-016).

## Decisão

### 1. Lugar: `$PROTO = apps/web`

O protótipo é a primeira versão do jogo, no pacote que SPEC §6 reserva para ele (`apps/web`, `@whodeployed/web`, `private: true`). A fase 3 troca a apresentação (mapa, painel, CSS) e mantém o núcleo de sessão. As restrições de PR-2 (sem CSS, `<canvas>`, `<svg>`) valem para `apps/web/src` durante a fase 2; o PRD da fase 3 as substitui.

### 2. Stack (ADR-001)

Vite + React 18 + TypeScript estrito (opções da ADR-008). Testes: Vitest com `jsdom` e `@testing-library/react`. Nenhuma biblioteca de CSS, CSS-in-JS, UI kit, roteador ou estado global (PR-2). `tsx` para os scripts Node. Dependências de runtime: só `react`, `react-dom` e os pacotes do workspace.

### 3. Layout

Segue SPEC §6 (`apps/web/src/{map,signals,notebook,clock,review}/`), sem `map` nesta fase:

```
apps/web/
  index.html                só <div id="root"> e o <script type="module">; sem <style>
  vite.config.ts            build, define de constantes de build, vitest (jsdom)
  src/main.tsx              monta <App/>
  src/app.tsx               roteamento mínimo: lista | sessão (por estado e ?test=<id>)
  src/data.ts               ÚNICO import de @whodeployed/scenarios/data (testes fazem vi.mock deste arquivo)
  src/build-info.ts         ENGINE_VERSION e BUILD_SHA (constantes de build)
  src/engine-runtime.ts     monta o EngineRuntime (ADR-014 §1.1) a partir de @whodeployed/engine
  src/session/              núcleo de sessão: TypeScript puro, sem DOM e sem React
    types.ts                contrato (Arquiteto; ADR-016)
    session.ts              createSession: relógio, ask/act/wait, impacto, fim no tick 360
    notebook.ts             hipóteses, descarte com citação, hipótese final
    log.ts                  SessionLogV1, JSON canônico (ADR-016), comparação sem wallMs
    storage.ts              logs de sessões encerradas em localStorage, com fallback (PR-16)
    review.ts               as 3 frases (PR-11)
    replay.ts               replayLog(log, scenario): ReplayResult (PR-14), puro
    outcomes.ts             R-1..R-4 (PR-15), puro
  src/scenario-list/        lista (PR-4) e modo de teste
  src/signals/              renderização em texto de cada Answer (PR-7) e controles de pergunta (PR-6)
  src/notebook/             caderno (PR-9) e fim (PR-10)
  src/clock/                tick, impacto/orçamento, SEVERE, wait, ações (PR-5, PR-8)
  src/review/               revisão e export (PR-11, PR-13, PR-16)
  scripts/replay.ts         CLI de PR-14
  scripts/results.ts        CLI de PR-15
  scripts/check-static.sh   greps de PR-2 e PR-3
  test/                     espelha src/; test/fixtures/ com cenários e logs de fixture
  README.md                 PR-20, PR-21
```

### 4. Fronteiras (PR-19, SPEC §6)

- `apps/web/src` importa só `@whodeployed/engine`, `@whodeployed/scenarios` e `@whodeployed/scenarios/data`; os scripts importam também `@whodeployed/scenarios/node`. Nada de `@whodeployed/*/src/**` ou `/dist/**`, nada de `yaml`. Regra `no-restricted-imports` no `eslint.config.js` de `apps/web` e um teste de imports (padrão da ADR-008).
- Os pacotes são resolvidos pelos `exports` (o `dist/` de cada um), por isso o `build` roda antes de `lint`/`typecheck`/`test` no CI (ADR-014 §4).

### 5. Sessão (o loop de SPEC §4 em texto)

- **Início (PR-5):** `deps.engine.createSimulation(toSimulationConfig(scenario, deps.engine))`, `advance(alert.tick)`, impacto acumulado até `alert.tick`. A tela mostra o alerta, o tick, `impact N / B` e a lista dos 9 componentes; nenhum sinal sem pedido.
- **Relógio (PR-8):** pergunta avança `Answer.tickCost` (ADR-006); ação avança `ActionResult.tickCost` (ADR-012); `wait` avança 1; anotar, descartar e ler custam 0. O avanço nunca passa do tick 360: se o custo passaria, avança só até 360. No tick 360 a sessão termina sozinha com `end` de `reason: 'tickLimit'` e `final: { kind: 'unknown' }`. Impacto = `accumulatedImpact(view, tick)` (ADR-013), memoizado por tick. `SEVERE` em texto quando impacto ≥ orçamento.
- **Repertório (PR-6):** a sessão só aceita o que `inRepertoire(level, step)` aceita (ADR-014). A interface monta os controles a partir de `repertoire[level]`: o que não está lá não aparece, nem desabilitado. Júnior: `logs` com `window: 30` fixo e sem filtro.
- **Erros:** `EngineError` de pergunta (por exemplo, `invalid_filter`, ADR-006 Emenda 2) vira uma linha de texto com `field` e `message`, sem custo de tick e sem passo no log.
- **Caderno e fim (PR-9, PR-10):** hipótese = componente entre os 9 + texto não vazio; descarte cita ≥ 1 passo `ask` anterior pelo `seq`; fim com hipótese ativa, nova ou `unknown`. Depois do fim, só revisão e export.
- **Revisão (PR-11):** `buildReview(log, scenario, referenceImpact)`, com `referenceImpact` e a mitigação do jogador vindos de `checkMitigations` (ADR-014 §3.1). Antes do fim, nada de `referencePath`, `rootCause`, `review.*` no DOM.
- **Modo de teste (PR-4):** `?test=<id>` abre um incidente de `bundle.testIncidents` (ex.: `?test=test-…`). A lista nunca mostra incidentes de teste. Documentado no README.
- **Determinismo (PR-12):** o núcleo não usa `Math.random` nem relógio, exceto `wallClock` injetado, que só alimenta `wallMs`. Mesmo cenário + mesma sequência de entradas ⇒ mesmo log, sem os `wallMs`.

### 6. Constantes de build (PR-13)

`vite.config.ts` define `__WD_ENGINE_VERSION__` (lido de `packages/engine/package.json` no build) e `__WD_BUILD_SHA__` (`GITHUB_SHA` no CI; fora dele, `git rev-parse HEAD`; sem git, `unknown`). Só em tempo de build; nada roda em runtime além de ler as constantes (`src/build-info.ts`).

### 7. Scripts Node (PR-14, PR-15)

- `pnpm --filter @whodeployed/web replay -- <log.json> <scenario.yaml>` (`tsx scripts/replay.ts`): carrega o YAML com `@whodeployed/scenarios/node`, chama `replayLog` e sai 0 se tudo bate; senão sai 1 e imprime o `seq` e o campo do primeiro passo divergente. Uso errado: exit 2. Igualdade de perguntas e respostas pelo JSON canônico (I24-6, ADR-016).
- `pnpm --filter @whodeployed/web results -- <pre.json> <post.json> --scenarios <dir>` (`tsx scripts/results.ts`): recusa com exit 2 se os dois logs forem do mesmo incidente ou se algum não for incidente de teste; imprime R-1..R-4 (`pre`, `post`, `changed`), `justification: check research note` quando R-2 depende da nota, e o número de perguntas de sinal até a primeira hipótese correta (informativo).
- PR-17: o CI roda o replay de uma sessão de fixture de 360 ticks com 40 perguntas dentro de `timeout 5`.

### 8. CI e "algo no ar" (PR-1, PR-2, PR-3, PR-21; SPEC §3.8)

- Passos novos no `ci.yml`, depois do `build`: `bash apps/web/scripts/check-static.sh` (PR-2 e PR-3); `node packages/scenarios/scripts/check-not-in-code.mjs` (CN-8); replay dos 5 logs de referência e do log adulterado (PR-14); replay de desempenho (PR-17). O `build` do Vite falha com warning (PR-1: `build.rollupOptions.onwarn` lança, e o script confere a saída sem a palavra `warning`).
- **Artifact `whodeployed-prototype`:** em `push` para `main` com o job verde, `actions/upload-artifact` (fixado por SHA, como na ADR-007 Emenda 3) envia `apps/web/dist/`. Em PR não sobe. O README diz como baixar (`gh run download --name whodeployed-prototype`) e servir (`python3 -m http.server` ou `npx serve`) o build.
- Como na ADR-009 Emenda 1, o artifact é snapshot de desenvolvimento, sem garantia de bytes; é o "algo no ar" desta fase (decisão 3 do PM no PR #75), não uma distribuição. GitHub Pages fica para a fase 3.

### 9. Persistência (PR-16)

`localStorage`, chave `whodeployed.sessions.v1`, valor = lista de `SessionLogV1` de sessões encerradas. Toda leitura e escrita dentro de `try/catch`: sem `localStorage` (ou com erro), o jogo funciona e o export do fim da sessão continua disponível. Um controle apaga a chave.

## Consequências

- O núcleo de sessão é testado sem navegador e reaproveitado pelos scripts: a sessão do júnior é auditável sem a UI (H9).
- A fase 3 herda `apps/web` com núcleo testado; o PRD da fase 3 revoga PR-2 para `apps/web/src`.
- `apps/web` passa a depender do `dist/` dos pacotes no CI e no dev local (`pnpm -r build` antes de `pnpm --filter @whodeployed/web dev`), registrado no README.

## Alternativas descartadas

- **`apps/prototype` separado de `apps/web`:** duplicaria scaffolding e núcleo; a fase 3 teria de migrar o núcleo. SPEC §6 só prevê `apps/web`.
- **HTML + JS sem React:** PR-5..PR-11 pedem testes de componente; React com Testing Library é a stack da ADR-001 e da fase 3.
- **Replay e resultados no pacote de cenários:** misturaria conteúdo com análise de sessão; o replay depende do formato do log, que é do protótipo.
- **Deploy em GitHub Pages já na fase 2:** é entregável da fase 3 (SPEC §8); o PM fixou artifact de CI (PR-21).
