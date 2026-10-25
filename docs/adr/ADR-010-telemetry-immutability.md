# ADR-010 — Imutabilidade da telemetria exposta por `TelemetryView` e `ask()`

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor")
- **Referência:** SPEC §3.3; PRD Q-3, D-1; ADR-002 §3; issue #24 (item Q-3 / aliasing, QA do PR #9)

## Contexto

O QA da T1.8 (PR #9) mostrou que `TelemetryStore` devolve arrays novos a cada consulta, mas os registros dentro deles e o objeto `world` são os mesmos guardados na store: `metricsOf('a', 0, 0)[0].rps = 999` altera `all()` e, portanto, o NDJSON; `store.world.tick = 42` altera `now`. Hoje nenhum handler faz isso, então Q-3 vale, mas só por disciplina. A partir da T1.16 o problema sai do motor: `Answer.data` carrega esses mesmos registros até o chamador (o jogo, na fase 2), que poderia corromper a telemetria de perguntas seguintes sem perceber.

Opções: (a) cópia defensiva em toda consulta ou em todo `Answer`; (b) tipos `readonly` só em tempo de compilação; (c) tipos `readonly` mais congelamento em tempo de execução.

## Decisão

Opção (c).

1. **Tipos (`types.ts` §6, já nesta emenda):** `TelemetryView` devolve `Readonly<Registro>[]` em `metricsOf`, `logsOf`, `spansOf`, `traceOf`, `eventsIn`, `readonly Readonly<TelemetryRecord>[]` em `all()` e `Readonly<World>` em `world`. O array devolvido continua novo e mutável (o handler pode filtrar e ordenar); o que fica `readonly` é cada registro. `metricsOf(...)[0].rps = 999` passa a ser erro de compilação (TS2540). Os tipos de registro (§4) e de `Signal` (§5) **não** mudam: `Readonly<T>` é atribuível a `T`, então os handlers existentes compilam sem alteração.
2. **Tempo de execução (task T1.31):** `createTelemetryStore` congela com `Object.freeze` cada registro recebido em `appendTick` (e o objeto `attrs` de cada log), antes de indexá-lo. `world` é um snapshot congelado, trocado por um novo snapshot congelado a cada `appendTick`; os arrays `services`/`deps` e seus objetos são congelados em profundidade na criação da store. Em ESM (modo estrito), uma tentativa de escrita lança `TypeError` em vez de corromper a telemetria.
3. **Sem cópia defensiva.** Registros congelados podem ser compartilhados com segurança entre store, handlers, `Answer` e o retorno de `advance()`; copiar cada registro em cada pergunta não compraria nada além disso.
4. **Contrato para quem produz registros (T1.15 e falhas T1.17–T1.22):** um registro entregue a `appendTick` não é mais alterado por ninguém. O orquestrador monta o registro completo antes de entregá-lo. Ninguém altera `world.services`/`world.deps` depois de `buildWorld`; o `World.tick` que o orquestrador avança é o seu próprio objeto (a store mantém o seu snapshot).

## Consequências

- Q-3 passa a valer por construção, também para quem consome o `Answer` fora do motor.
- `Object.freeze` não consome aleatoriedade nem depende de ambiente: nenhum efeito em D-1/D-2.
- Custo: uma chamada de `freeze` por registro gerado (dezenas de milhares por execução de 360 ticks), desprezível perto da geração.

## Alternativas descartadas

- **Cópia defensiva:** custo proporcional ao volume de cada pergunta, e ainda deixa `world` e o retorno de `advance()` expostos.
- **Só `readonly` nos tipos:** não protege chamadores JavaScript nem quem faz cast; o jogo da fase 2 é o principal consumidor.
- **`readonly` nos campos de cada tipo de registro (§4):** quebra os geradores que montam o registro em passos (`src/sim/logs.ts` atribui `traceId` e `attrs` depois de criar o objeto) e não acrescenta nada à proteção da view.
