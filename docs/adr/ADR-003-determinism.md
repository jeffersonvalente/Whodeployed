# ADR-003 — Determinismo: PRNG, streams por chave e derivação de seed

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor")
- **Referência:** SPEC §3.3, §10; ADR-001 (aleatoriedade: PRNG próprio); PRD D-1..D-5, F-2, S-4, S-5, Q-3, Q-8

## Contexto

O Gate 1 exige saída byte-idêntica para a mesma seed (D-1), independente de fuso e locale (D-2); exige também que uma falha não altere nada antes de `startTick` (F-2), que noise não altere nada além dos eventos (S-4) e que perguntas não alterem a telemetria (Q-3). Um único PRNG sequencial quebraria F-2/S-4/Q-3: qualquer sorteio a mais desloca todos os seguintes.

## Decisão

1. **Algoritmo:** `mulberry32` (estado de 32 bits, ADR-001), semeado por hash `xmur3` da chave textual. `next()` = `uint32 / 2^32`. Implementação própria em `src/sim/rng.ts`, sem dependência.
2. **Streams por chave:** `createRngFactory(seed)` devolve `RngFactory`; `factory(...key)` cria um stream novo semeado por `xmur3(seed + '\u001f' + key.join('\u001f'))`. Streams nunca são compartilhados entre propósitos. Chaves canônicas:
   - tráfego: `('traffic', tick, component)`, `('lb', tick, component)`, `('lat', traceId, spanSeq)`;
   - logs: `('logs', tick, component, instance)`;
   - recursos: `('res', tick, component, instance)`;
   - falha de índice `i`: o orquestrador passa a `activate()` uma factory prefixada por `('fault', i, kind)`; a falha deriva sub-streams (ex.: `('pick')` para escolher instância, `(tick, traceId)` por request).
3. **IDs sem aleatoriedade:** `traceId = t${tick}r${seq}`, `spanId = ${traceId}s${n}`, com `seq` e `n` contadores por tick/trace. Instâncias: `${component}-${index}` (ADR-002).
4. **Derivação de seed do `lastWeek` (Q-8):** a simulação de comparação usa o mesmo `SystemDefinition`, `faults: []`, `noise: []` e seed `${seed}:lastWeek`. É reproduzível pelo CLI: `simulate --seed '<seed>:lastWeek' --ticks <n>` sem `--fault` dá a mesma série.
5. **Proibições em `src/`** (lint + teste de grep, D-4): `Math.random`, `Date`, `Date.now`, `performance.now`, `crypto.*`, `process.hrtime`, `setTimeout`/`setInterval`, `toLocaleString`, `localeCompare`, `Intl`. Ordenação só com comparadores numéricos ou `<`/`>` em strings (independente de locale, D-2).
6. **Aritmética:** durações de span são inteiros (ms, `Math.round`); `cpu` e `mem` arredondados a 1 casa decimal (`Math.round(x * 10) / 10`); `connections` inteiro; `rps` e `errorPct` calculados exatamente pelas fórmulas de P-1, sem arredondamento. `Math.exp`/`Math.log`/`Math.sqrt` são permitidos (V8 é determinístico na mesma versão de Node; o PUB-1 usa Node 22). Serialização com `JSON.stringify` por campo (ADR-005).
7. **Ordem de iteração:** só arrays na ordem do mundo/geração; nunca iterar `Object.keys` de mapas montados dinamicamente sem ordenar.

## Consequências

- F-2, S-4 e Q-3 seguem por construção, e ainda assim têm teste.
- Seeds diferentes mudam latências, balanceamento e instância afetada (S-5, risco de gamesmanship do PRD).
- Adicionar um novo uso de aleatoriedade exige uma chave nova, nunca reaproveitar um stream existente.

## Alternativas descartadas

- **xoshiro128\*\*:** melhor qualidade, mas desnecessário para streams curtos; mulberry32 é menor e já previsto na ADR-001.
- **PRNG global sequencial:** quebra F-2/S-4/Q-3 (ver Contexto).
- **`lastWeek` com a mesma seed do baseline:** a "semana passada" ficaria idêntica ao baseline em todo valor, o que é irreal e ensinaria a comparar igualdade, não tendência.

## Emenda 1 — 2026-10-25 (issue #24, QA da T1.14 / PR #25)

### 8. Alcance do isolamento entre streams

O QA da T1.14 mostrou que o isolamento por streams vale **por tick e por trace, não por componente**. O round-robin (contador por alvo no tick, deslocamento de `('lb', tick, target)`) e o stream de decisão `('traffic', tick, component)` (sorteios de `ratio` e de hit da cache, em número fixo por span server) são consumidos por request. Quando uma falha muda quantas requests chegam a um componente (o gateway para as chamadas depois de um erro; um retry acrescenta uma escolha no LB), traces do mesmo tick que nunca tocam o componente com falha podem mudar de instância ou de hit/miss. Medido pelo QA: `onServe.fail` em catalog, seed `qa`, 30 ticks: 18 de 210 traces sem catalog mudam.

**Decisão: aceitar e registrar** (opção (a) da issue #24). Motivos: um balanceador compartilhado é realista (a carga que sobra de uma falha redistribui as demais requests); F-2 (ticks `< startTick`), S-4 (noise) e Q-3 (perguntas) continuam valendo por construção, porque nada disso atravessa ticks nem toca streams de tráfego; e trocar para chave por request (`('traffic', traceId, ...)`, escolha aleatória de instância) apagaria o round-robin de ADR-002 §5 sem nenhum critério do PRD que o exija. Não há task nova de motor antes de T1.17–T1.22; nada fica bloqueado.

Garantias, portanto:

| Garantia | Vale? |
| --- | --- |
| Ticks antes de `startTick` byte-idênticos ao baseline (F-2) | sim |
| Noise só muda linhas `event` (S-4) | sim |
| `ask()` não muda a telemetria (Q-3) | sim |
| Ticks em que a falha está ativa: traces que não tocam o alvo idênticos ao baseline | **não** — podem trocar instância (LB) ou hit/miss de cache |

Consequência para as tasks de falha (T1.17–T1.22) e para T1.24/T1.25: F-3, F-4 e F-5 comparam **médias na janela de assinatura sobre ≥ 10 seeds**, como o PRD já pede, e nunca igualdade de trace ou de instância contra o baseline nos ticks com falha. Em F-5 ("demais instâncias a ≤ 2 p.p. do baseline"), o critério é sobre erro %, que a troca de instância no LB não cria. Um teste que precise isolar o efeito do LB compara agregados do componente, não instâncias.

### 9. Chave `('lat', traceId, spanSeq)`

A latência própria de cada span server é sorteada de `('lat', traceId, spanSeq)`, onde `spanSeq` é a posição do span no trace. É intencional que spans inseridos por uma falha (wait `internal`, retry) desloquem `spanSeq` dos spans seguintes **do mesmo trace**: esse trace já é afetado pela falha, e o deslocamento não sai dele. Spans de um trace sorteiam latências distintas (o `spanSeq` faz parte da chave); a T1.32 acrescenta o teste que hoje falta (a mutação `rng('lat', traceId)` sobrevive aos testes da T1.14).

### 6.1 Cauda da latência

`sampleLatencyMs` limita o z-score da log-normal a **±4** (`MAX_Z`), para que um sorteio não gere cauda absurda; o máximo é `latencyP50Ms × (latencyP99Ms / latencyP50Ms)^(4 / 2,326)` (ex.: postgres 4/25 ms → ≈ 94 ms; payment 40/150 ms → ≈ 390 ms), antes de `onServe.addLatencyMs`. Mudar o limite muda todos os fixtures.
