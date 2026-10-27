# ADR-012 — Ações no motor: `restart` e `rollback`, custo em ticks e efeito por `FaultKind`

- **Status:** aceita
- **Data:** 2026-10-26
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor"; PRD FASE-2 EN-4, EN-5: "definido em ADR")
- **Referência:** SPEC §3.3, §3.4, §3.5, §5, §6; PRD `docs/prd/FASE-2.md` (EN-2, EN-3, EN-4, EN-5, EN-7, CN-3, CN-5); ADR-002, ADR-003, ADR-004, ADR-005, ADR-010

## Contexto

A fase 2 precisa que o jogador aja (H3): `restart` no repertório Júnior e `rollback` no Pleno. SPEC §6 já tem o tipo `Action`, mas o motor só o declarava. O PRD fixa as restrições: o contrato de SPEC §6 não muda (EN-3); sem ação, a telemetria não muda (EN-2); o efeito vem do estado da simulação, nunca do cenário (EN-5: o motor não recebe `referencePath`, `rootCause`, `trap` nem `teaches`); mesma seed e mesmas ações nos mesmos ticks dão bytes iguais (EN-4); e a tabela de efeito por kind, alvo e outro componente fica em ADR (EN-5).

## Decisão

### 1. API (`types.ts` §6)

- `Simulation.act(action: Action): ActionResult`. Valida, agenda o efeito para o tick `world.tick + 1` (o "tick de efeito", `te`) e devolve `{ action, tick, tickCost }`. Como `ask()`, **não avança o relógio**: quem avança é o chamador, por `tickCost` (ADR-002 §3). Duas ações chamadas antes do mesmo `advance()` têm o mesmo `te` e são aplicadas na ordem das chamadas.
- `ActionResult` não diz o que a ação mudou (por exemplo, se o `rollback` achou deploy para reverter). O jogador descobre pelos sinais (SPEC §3.4) e pelo relógio de impacto.
- Nenhum tipo de SPEC §6 muda (EN-3). Os acréscimos ficam fora de `World`, `Fault`, `Question`, `Answer` e `Action`: `SupportedActionKind`, `ActionCostTable`, `ActionResult`, o método `act` em `Simulation` (§6 de `types.ts`, que não é cópia do spec) e dois códigos de `EngineErrorCode`.
- O motor não tem nível de jogador (Q-1). Quem restringe `restart`/`rollback` por nível é o repertório do protótipo (ADR-014), nunca o motor.

### 2. Validação (EN-5)

| Entrada | Erro (`EngineError`) | `field` |
| --- | --- | --- |
| Não é objeto; `kind` fora da união de SPEC §6; chave além de `kind`/`target`; `target` presente e não string | `invalid_action` | `action`, `action.kind`, `action.<chave>`, `action.target` |
| `kind` ∈ {`flagOff`, `scale`, `escalate`, `declareMitigated`} | `unsupported_action` (`validValues: ['restart', 'rollback']`) | `action.kind` |
| `restart`/`rollback` sem `target` | `invalid_action` | `action.target` |
| `target` que não é componente do mundo | `unknown_target` (`validValues` = os componentes, ordem do mundo) | `action.target` |

`target: undefined` equivale a chave ausente (mesma regra de I24-6 e da ADR-004 Emenda 1). Nenhum parâmetro de nível existe (Q-1). Erro de validação não altera a simulação.

### 3. Custo (EN-4)

| `kind` | `tickCost` | Motivo |
| --- | --- | --- |
| `restart` | 2 | Reiniciar e esperar o processo subir |
| `rollback` | 3 | Pipeline de deploy da versão anterior |

Tabela em `src/sim/actions.ts` (`actionCostTable`, interna). Como em ADR-006, os números podem mudar por PRD futuro sem mudar contrato.

### 4. Primitivas

Seja `X` o `target` e `te` o tick de efeito.

- **Substituição de processo de `X` (SP):** as falhas **ativas em `te`** (`startTick ≤ te`) com alvo `X` reagem conforme a coluna "SP" da tabela da seção 5 (`clear`, `reset` ou `none`, tipo `ProcessReplacementReaction`). Falhas que ainda não começaram não são afetadas.
- **`restart X`:** SP de `X`; todas as instâncias de `X` ficam `down` no tick `te` (o mesmo mecanismo de `TickEffect.down`, ADR-002 §5: chamada falha em 1 ms com `connection refused`, ingress na borda se perde, métrica de instância zerada); um `EventRecord` `{ kind: 'config', target: X, restart: true }` no tick `te`. Sem `note`, sem `instance`, sem log novo.
- **`rollback X`:** procura, entre os `EventRecord` `deploy` com `target: X` e tick ≤ `world.tick` (de falha ou de noise: o motor não distingue, como `whatChanged`), o **lote mais recente ainda não revertido** (lote = todos os eventos `deploy` de `X` com o mesmo tick). Os `deploy` emitidos pelos próprios rollbacks não entram na busca.
  - **Sem lote:** nada acontece na telemetria (nenhum evento, nenhum `down`). A ação custa os ticks do mesmo jeito.
  - **Com lote:** marca o lote como revertido; toda falha `bad_deploy` ativa com alvo `X` e `startTick` = tick do lote é encerrada (`clear`) em `te`; SP de `X` **sem indisponibilidade** (rolling, nenhum `down`); um `EventRecord` `{ kind: 'deploy', target: X }` no tick `te`. Um segundo `rollback` reverte o lote anterior, e assim por diante.
- **Regra de cache:** SP de um componente `kind: 'cache'` (por `restart` ou por `rollback` com lote) esvazia a cache. O motor ativa uma falha **induzida** `cache_cold_start` com alvo `X`, `startTick = te` e os parâmetros padrão do catálogo (ADR-004), e encerra em `te` qualquer `cache_cold_start` anterior no mesmo alvo. O evento `config` com `restart: true` e o tick `down` são os do próprio módulo `cache_cold_start` (ADR-004), então o `restart` de uma cache **não** emite evento nem `down` próprios (sem duplicata).

### 5. Tabela de efeito por kind (EN-5)

"Alvo" = ação aplicada ao `target` da falha; "outro" = ação aplicada a qualquer outro componente.

| FaultKind | SP (`onProcessReplacement`) | `revertedByRollback` | `restart` no alvo | `restart` em outro | `rollback` no alvo | `rollback` em outro |
| --- | --- | --- | --- | --- | --- | --- |
| `service_crash_loop` | `clear` | não | alvo `down` em `te`; falha encerrada em `te` (processo sobe limpo) | o outro fica `down` em `te`; falha intacta | sem lote: nada; com lote (ex.: noise de deploy no alvo): falha encerrada em `te`, sem `down` | sem lote: nada; com lote: SP do outro; falha intacta |
| `disk_full` | `none` | não | alvo `down` em `te`; disco continua cheio, falha intacta | idem `restart` em outro acima | sem lote: nada; com lote: evento `deploy`, falha intacta | idem acima |
| `connection_pool_exhaustion` | `reset` | não | alvo `down` em `te`; vazamento recomeça do zero em `te` (`s = 0`; pool esgota de novo depois de ⌈`poolSize`/`leakPerTick`⌉ ticks) | o outro fica `down` em `te`; falha intacta | sem lote: nada; com lote: vazamento recomeça em `te`, sem `down` | idem acima |
| `bad_deploy` | `none` | **sim** | alvo `down` em `te`; versão ruim continua (falha intacta) | idem | lote da falha (deploy no `startTick`): falha encerrada em `te`, evento `deploy`, sem `down`. Se houver deploy mais recente no alvo (noise), o 1º `rollback` reverte esse e o 2º reverte o da falha | idem acima |
| `slow_dependency` | `clear` | não | alvo `down` em `te`; latência extra some em `te` | o outro fica `down` em `te`; falha intacta (reiniciar quem grita não resolve) | sem lote: nada; com lote: latência some em `te`, sem `down` | idem acima |
| `cache_cold_start` | `reset` | não | regra de cache: novo esfriamento a partir de `te` (evento e `down` do módulo) | o outro fica `down` em `te`; falha intacta | sem lote: nada; com lote: regra de cache | idem acima |

`restart`/`rollback` de uma cache sem falha nenhuma segue a regra de cache (esfria). `restart` de qualquer outro componente sem falha: `down` em `te` e evento, nada mais.

Por que estes efeitos: `restart` resolve o que mora no processo (loop de crash com estado local corrompido, conexões vazadas, processo degradado) e não resolve o que mora fora dele (disco cheio, versão ruim instalada). `rollback` só resolve o que veio de um deploy. A causa raiz (o vazamento, o bug da versão) continua: no pool, o reset compra tempo, como na vida real. Isso dá a SPEC §3.5 ("mitigar sem root cause") um efeito mensurável e mantém a armadilha de SPEC §3.4: agir no componente que grita, e não no culpado, não muda nada.

### 6. Implementação no orquestrador (ADR-002 §3, ADR-003)

- Ciclo de vida das falhas: cada falha ativa ganha `endTick` opcional; `hooksActiveAt` passa a usar `startTick ≤ tick < endTick`. Sem ação, `endTick` fica indefinido e a execução é idêntica à da fase 1 (EN-2).
- `reset` = encerra a geração atual em `te` e ativa a mesma falha (mesmo `kind`, `target`, `params`) com `startTick = te`, como geração `g ≥ 1`. Streams: a geração 0 usa a fábrica de hoje, prefixo `('fault', i, kind)`; a geração `g ≥ 1` usa `('fault', i, kind, 'gen', g)`. A falha induzida da regra de cache usa `('action', n, 'cache_cold_start')`, com `n` = número de sequência da ação na simulação (0, 1, …). Nenhum módulo de falha usa `'gen'` como primeira chave, então não há colisão (ADR-003 §2).
- Os efeitos da ação no tick `te` entram no passo 1 da ordem de ADR-002 §3: `down` da ação une-se ao `down` das falhas; eventos da ação entram depois dos eventos de falha e antes dos de noise (ADR-005 Emenda 3).
- Histórico de deploys para o `rollback`: lido da própria `TelemetryView` (`eventsIn(0, now)`), mais um conjunto interno de lotes revertidos e de ticks de eventos emitidos por rollback. Nenhum estado vem de fora do motor.
- A ação não usa `ctx` de hooks (issue #24 item 4 continua fora; a exceção prevista no PRD não se aplica).
- Tabela da seção 5 é dado: `FaultActionReactions` em `src/sim/actions.ts` (tipos em `types.ts` §8), uma linha por `FaultKind`.

### 7. Determinismo e coerência

- Mesma seed + mesma sequência de `ask`/`act`/`advance` ⇒ telemetria byte-idêntica (EN-4). `ask` continua sem efeito (Q-3).
- P-1, P-2 e P-3 continuam valendo por construção: a ação só usa mecanismos que já existem (`down`, ativação/encerramento de hooks, eventos). EN-7 testa isso.
- Nenhum `Math.random`, relógio ou I/O (D-4).

## Consequências

- **Conteúdo (CN-3, CN-5, CN-9):** com esta tabela, os incidentes de teste `TA`/`TB` (kind fora de {`service_crash_loop`, `connection_pool_exhaustion`, `slow_dependency`}, mitigação eficaz com `restart`/`rollback`) só fecham com `bad_deploy` + `rollback`: `disk_full` não tem mitigação por estas ações e `cache_cold_start` esquenta sozinho. CN-3 aceita os dois com o mesmo kind e alvos diferentes. Medição do Arquiteto (função de impacto inicial da ADR-013, 10 seeds, ticks 10–59) para guiar a escolha: `bad_deploy` com impacto em quase todo tick em `gateway` (1 instância), `catalog` e `auth` (2 instâncias) e `cart` (2 instâncias, 36–45 de 50); sem impacto em `cart`, `catalog` e `auth` com 1 instância (o retry do chamador mascara). O Eng. Conteúdo escolhe e mede.
- **Cenário 03:** o `restart` do alvo só é mitigação eficaz (30 ticks sem impacto) se o pool demorar > 33 ticks para esgotar de novo; `poolSize`/`leakPerTick` do YAML têm que permitir isso e ainda cumprir CN-6 (pool esgotado no `alert.tick`).
- **Cenário 05:** a mitigação é `restart` do componente lento, não do chamador que mostra o erro.
- **Fase 3:** `flagOff`, `scale`, `escalate` e `declareMitigated` ganham semântica por emenda desta ADR; até lá, `unsupported_action`. A regra de cache já dá ao cenário 7 o "cache frio após restart de redis" como consequência de ação.
- `whatChanged` passa a mostrar os `restart`/`rollback` do próprio jogador, como um sistema real.

## Alternativas descartadas

- **Ação como "resolve a falha se o alvo bater":** o efeito viria do cenário (alvo certo = vitória), não do estado; fere EN-5 e SPEC §3.3.
- **`restart` sem indisponibilidade:** tiraria o custo de reiniciar às cegas; reiniciar tudo tem que doer um pouco.
- **`rollback` sempre com efeito (redeploy da mesma versão quando não há deploy):** tornaria o `rollback` um `restart` sem custo de indisponibilidade e esconderia o valor de perguntar "o que mudou?" antes.
- **Efeito da ação aplicado no fim do `tickCost` (`world.tick + tickCost`):** mais realista para o `rollback`, mas deixaria a janela "impacto para em até 3 ticks" da definição de mitigação eficaz dependente do custo de cada ação. `te = tick + 1` mantém a regra simples e igual para as duas.
- **Hooks novos nos módulos de falha (`onAction`):** cada módulo reimplementaria a mesma lógica de encerrar/recomeçar; o ciclo de vida no orquestrador mais uma tabela de dados é menor e testável por célula.
