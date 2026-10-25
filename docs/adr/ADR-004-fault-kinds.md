# ADR-004 — Catálogo de FaultKind: nomes, mapeamento à campanha, padrões e faixas

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (delegado pelo PRD F-1 e SPEC §12: "estrutura interna do motor")
- **Referência:** SPEC §3.4, §7; PRD F-1..F-7, CLI-2, tabela "Assinaturas de falha"; ADR-002 (topologia do `default-shop`)

## Contexto

O PRD fixa só `connection_pool_exhaustion` e pede uma ADR que nomeie os outros 5 kinds, mapeie cada um a uma linha da campanha (1, 2, 3, 4, 5, 7), e documente alvo, `startTick` e parâmetros padrão com faixas (CLI-2, F-3, F-7). Os dados desta ADR são transcritos em `src/faults/catalog.ts` (tarefa de scaffolding) e lidos pelo resolvedor, pelo `--help` e pelos módulos de falha.

## Decisão

### Nomes e mapeamento (F-1)

| FaultKind | Linha SPEC §7 | Falha | Por que este nome |
| --- | --- | --- | --- |
| `service_crash_loop` | 1 | Serviço crashando em loop | Já usado no `_TEMPLATE.yaml` de cenário |
| `disk_full` | 2 | Disco cheio no postgres | Nomeia a causa, não o alvo; vale para qualquer dependência |
| `connection_pool_exhaustion` | 3 | Pool de conexões esgotado | Fixado por SPEC §7 |
| `bad_deploy` | 4 | Deploy ruim em 1 de N instâncias | O "1 de N" é parâmetro (`affectedInstances`) |
| `slow_dependency` | 5 | Retry storm após dependência lenta | A falha injetada é a lentidão; a tempestade de retries **emerge** da política de retry dos chamadores (SPEC §3.3: gerado, não roteirizado) |
| `cache_cold_start` | 7 | Cache frio após restart do redis | Nomeia o estado que causa o sintoma |

Linha 6 (alerta ruidoso) é `noise`; linha 8 é composição de duas falhas (F-6).

### Padrões, parâmetros e faixas

`startTick` padrão = **10** para todos os kinds. Todo parâmetro tem `default`, `min`, `max` (inclusive) e `integer`; fora disso, ou nome desconhecido, `resolveFaults` lança `EngineError` (F-7) com o campo e os válidos.

| FaultKind | Alvo padrão | Alvos aceitos | Parâmetro | default | faixa | inteiro | unidade |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `service_crash_loop` | `catalog` | serviço | `uptimeTicks` | 1 | 1–30 | sim | ticks |
| | | | `restartTicks` | 3 | 1–30 | sim | ticks |
| `disk_full` | `postgres` | dependência `database` | `fillTicks` | 3 | 0–30 | sim | ticks |
| | | | `failRatio` | 0.4 | 0.05–1 | não | ratio |
| `connection_pool_exhaustion` | `payment` | serviço que chama uma `database` | `poolSize` | 20 | 1–500 | sim | connections |
| | | | `leakPerTick` | 2 | 0–100 | sim | connections/tick |
| | | | `acquireTimeoutMs` | 2000 | 100–30000 | sim | ms |
| `bad_deploy` | `gateway` | serviço com ≥ 2 instâncias | `affectedInstances` | 1 | 1–(réplicas−1) | sim | instances |
| | | | `errorRatio` | 0.9 | 0.05–1 | não | ratio |
| `slow_dependency` | `postgres` | qualquer componente com chamadores | `addedLatencyMs` | 1500 | 50–30000 | sim | ms |
| `cache_cold_start` | `redis` | dependência `cache` | `warmupTicks` | 30 | 1–60 | sim | ticks |

`affectedInstances.max` depende do alvo; o catálogo guarda `max: 64` e `resolveFaults` aplica `réplicas − 1` (a mensagem cita o limite efetivo).

### Semântica de cada kind (hooks de ADR-002)

`s = tick − startTick` (≥ 0 sempre que um hook é chamado).

- **`service_crash_loop`**: cada instância do alvo alterna `uptimeTicks` em pé e `restartTicks` fora (`onTick.down`), com fase inicial por instância sorteada de `('fault', i, kind, 'phase')`, garantindo ≥ 1 instância fora em cada tick com os padrões. Em cada tick em que uma instância cai ou está fora, emite log `error` (`process exited`, attrs `exitCode`, `restartCount`) dessa instância. Sinal indireto: erro no `gateway` (chamador) quando as tentativas caem em instâncias fora.
- **`disk_full`**: a partir de `s >= fillTicks`, cada request servida pelo alvo falha com probabilidade `failRatio` (`onServe.fail`, `no space left on device`); de `s = 0` a `fillTicks` emite um log `warn` por tick (`disk usage high`, attr `usagePct`) e um `error` por tick depois. Sinal indireto: erro nos serviços que dependem do alvo.
- **`connection_pool_exhaustion`**: em cada instância do alvo, conexões vazadas = `min(poolSize, leakPerTick × (s + 1))`; `onResources` soma vazadas e limita `connections` a `poolSize`. Quando vazadas + em uso ≥ `poolSize`, `onCall` às `database` do alvo espera (`waitOperation: 'db.acquire'`) até liberar ou até `acquireTimeoutMs` (depois `fail`: `connection pool timeout`). `poolSize` sobrescreve `dbPoolSize` só no alvo.
- **`bad_deploy`**: em `s = 0`, escolhe `affectedInstances` instâncias por `('fault', i, kind, 'pick')` e emite um `EventRecord` `deploy` por instância (com `instance`). Requests servidas por elas falham com probabilidade `errorRatio` (`onServe.fail`, `unhandled exception`, attr `version`). Demais instâncias intactas (F-5).
- **`slow_dependency`**: `onServe` soma `addedLatencyMs` a toda request do alvo; o alvo não gera erro próprio. Timeouts e retries dos chamadores (ADR-002 §5) produzem o aumento de spans `client` e o erro nos chamadores ("o culpado não é quem grita").
- **`cache_cold_start`**: em `s = 0` emite `EventRecord` `config` com `restart: true` no alvo e marca a instância `down` só nesse tick; de `s = 0` a `warmupTicks`, `onCall` à cache força miss com probabilidade `1 − (s / warmupTicks)` (sorteio por request); a partir de `s >= warmupTicks`, só a `cacheHitRatio` normal. Sinal indireto: RPS de `postgres` e p95 de quem usa a cache.

Valores padrão foram escolhidos para satisfazer a tabela "Assinaturas de falha" do PRD com a topologia fixa da ADR-002; se um teste F-3 exigir ajuste, a tarefa daquela falha ajusta **só** o default e a faixa do seu kind, atualizando esta tabela no mesmo PR (o Arquiteto revisa).

## Consequências

- O `--help` do CLI e as mensagens de F-7 são geradas do catálogo; nenhuma lista de kinds é duplicada em código.
- Nenhum kind tem texto de cenário (S-5); mensagens de log são telemetria genérica em inglês.

## Alternativas descartadas

- **`retry_storm` como nome do kind 5:** a tempestade é consequência; injetá-la diretamente seria roteirizar o sintoma (fere SPEC §3.3).
- **`redis_restart` como nome do kind 7:** acopla a falha a um componente; `cache_cold_start` vale para qualquer `cache`.
- **Instância fixa (índice 0) em `bad_deploy`:** viraria padrão decorável; a seed escolhe.

## Emenda 1 — 2026-10-25 (issue #24, #23, #22)

### Entrada ausente vs `null`

Decisão: **`null` é rejeitado** (opção (b) de #23). "Ausente" é só a chave que não existe ou vale `undefined`; nesse caso entra o default do catálogo. `null` em qualquer campo é um valor inválido e recebe o mesmo erro que qualquer outro valor inválido daquele campo:

| Campo | `null` lança | `validValues` |
| --- | --- | --- |
| `target` | `unknown_target` | componentes do mundo |
| `startTick` | `invalid_start_tick` | `integer >= 0` |
| `params.<nome>` | `param_out_of_range` | `min..max` efetivo |
| `params` | `unknown_param` (campo `faults[i].params`) | nomes dos parâmetros do kind |

Motivo: em YAML, `target: ~` ou `target:` sem valor viram `null`; tratar isso como ausente faria um autor de cenário receber o alvo padrão em silêncio, sem a mensagem de F-7 (SPEC §3.7). O JSON Schema de cenário (fases 3–4) deve rejeitar o mesmo, mas `resolveFaults` continua sendo a fronteira de validação do motor. Implementação: T1.30 (troca dos `??` em `src/faults/resolve.ts` por teste de `undefined`, mais um teste por linha da tabela).

### Chaves de `params`

Só chaves próprias contam, e qualquer chave que não seja parâmetro documentado do kind é `unknown_param`, inclusive `__proto__`, `constructor` e `toString`. `resolveFaults` já usa `Object.keys` + `Object.hasOwn` (correto). O problema de #22 está no produtor: o parser do CLI montava `params` como literal `{}`, onde `params['__proto__'] = 1` não cria propriedade. O parser passa a montar `params` com `Object.create(null)`, para a chave chegar a `resolveFaults` e falhar como `unknown_param` (exit 2). Implementação: T1.23 (edita `src/cli/args.ts`). O loader YAML da fase 3–4 segue a mesma regra.
