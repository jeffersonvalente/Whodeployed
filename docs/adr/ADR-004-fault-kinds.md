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
| | | | `failRatio` | 0.9 | 0.05–1 | não | ratio |
| `connection_pool_exhaustion` | `payment` | serviço que chama uma `database` | `poolSize` | 20 | 1–500 | sim | connections |
| | | | `leakPerTick` | 4 | 0–100 | sim | connections/tick |
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
- **`cache_cold_start`**: em `s = 0` emite `EventRecord` `config` com `restart: true` no alvo e marca a instância `down` só nesse tick; de `s = 0` a `warmupTicks`, `onCall` à cache força miss com probabilidade `min(1, 2 · (1 − s / warmupTicks))`, ou seja, totalmente fria até `s = warmupTicks / 2` e linear até 0 em `s = warmupTicks` (sorteio por request; curva da Emenda 3, antes `1 − (s / warmupTicks)`); a partir de `s >= warmupTicks`, só a `cacheHitRatio` normal. Sinal indireto: RPS de `postgres` e **p50** de quem usa a cache (PRD Emenda 1; texto corrigido na Emenda 2 desta ADR).

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

## Emenda 2 — 2026-10-25 (PRD Emenda 2, PR #46; issue #24)

### Contexto

A Emenda 2 do PRD fixou a leitura de "≥ 10 seeds" (R1–R5: limiar na média, piso de 75% por seed, existência em toda seed) e as métricas elegíveis de F-4 (E1–E4: piso absoluto no baseline, erro % em p.p., par fixo em todas as seeds). Medição do PM com 40 seeds e defaults: `disk_full` e `connection_pool_exhaustion` falham; as outras 4 passam. Medição do Eng. Motor da T1.25: com `connection_pool_exhaustion` em `payment` + `service_crash_loop` em `catalog` (F-6), a assinatura do pool some em 5/40 seeds.

Diagnóstico comum às duas: **amostra pequena por seed**, não semântica errada. `payment` recebe ≈ 1,2 req/tick (ratio 0,1 no `gateway`, ingress fixo de 12/tick) e `orders-worker` 2 req/tick; na janela de 6 ticks são ≈ 7 e 12 requests por seed. Uma condição que só aparece numa fração dessas requests (ou num pedaço da janela) zera em algumas seeds.

### Decisão

1. **`connection_pool_exhaustion`: `leakPerTick` padrão passa de 2 para 4; `poolSize` fica em 20.**
   - Com 20/2 o pool só esgota em `s = 9` (`leakedAt(s) = min(poolSize, leakPerTick·(s+1))`), deixando só 3 dos 6 ticks da janela (`s = 6..11`) esgotados; em seeds em que `payment` recebe 0 requests nesses 3 ticks (mais provável em F-6, quando o crash do `catalog` faz o `gateway` abortar antes de chamar `payment`), a falha não aparece.
   - Com 20/4 o pool esgota em `s = 4`: a janela inteira fica esgotada em toda seed, com 2 ticks de margem, e as conexões sobem visivelmente (4, 8, 12, 16, 20) antes, que é a pista da linha 3 (SPEC §7).
   - `poolSize` fica igual ao `dbPoolSize` do `default-shop` (ADR-002 §6), para a métrica de conexões do alvo e a visão do DBA continuarem batendo com o pool do sistema. A alternativa `poolSize = 10` (esgota no mesmo `s = 4`) foi descartada por isso.
   - **Invariante (teste fechado, independente de seed):** com os defaults, `leakedAt(6, leakPerTick, poolSize) >= poolSize`, ou seja, o pool está esgotado no primeiro tick da janela. Mudar o default de novo exige manter esse invariante.
   - Medição do Eng. Motor (T1.25, 40 seeds, R2–R5): com 20/4, pool sozinho e pool + `service_crash_loop` passam em 40/40 (p95 de `payment` mín. 6,56×, p95 de `gateway` mín. 3,10×, p50 de `gateway` médio 0,68×). A T1.37 confirma com a lista de seeds do teste.
   - Faixas não mudam. A semântica não muda (nenhuma linha da seção "Semântica" é alterada).
2. **`disk_full`: `failRatio` padrão sobe; `fillTicks` fica em 3.**
   - `fillTicks ≤ 6` garante a janela inteira "cheia"; 3 já cumpre e preserva a fase de `warn` (`disk usage high`), que é a pista que antecede o erro.
   - Com `failRatio = 0,4`, uma request de `orders-worker` (chamada direta, `retries: 2`) só falha com probabilidade 0,4³ ≈ 6,4%, e uma de `payment` (`retries: 1`) com 0,16; com ≈ 12 e ≈ 7 requests por seed na janela, várias seeds ficam em +0 p.p. Subir `failRatio` aumenta a probabilidade de a tentativa final falhar, sem roteirizar nada no chamador.
   - **Ponto de partida: 0,8** (`orders-worker` ≈ 51% de erro por request, `payment` ≈ 64%). A T1.36 escolhe o **menor** valor da grade {0,6; 0,7; 0,8; 0,9} que cumpre F-3 linha 2 e F-4 com R1–R5/E1–E4 em 40 seeds e na lista fixa do teste, com o pior seed ≥ 1,5× o piso por seed (+3,75 p.p. → ≥ +5,6 p.p.), e registra a medição no PR. Menor valor porque um disco que derruba quase toda request deixa de ensinar "sintoma longe da causa": o alvo grita tão alto quanto os dependentes.
   - Par F-4 fixo recomendado: (`orders-worker`, `errorPct`) — chamador direto, sem cache no caminho. Alternativa aceita: (`payment`, `errorPct`). O teste de F-3 linha 2 fixa o mesmo serviço dependente em todas as seeds (mais estrito que "≥ 1 serviço" e coerente com E4).
   - Faixas e semântica não mudam.
3. **Nenhuma mudança de geração.** `src/sim/traffic.ts`, `src/world/default-shop.ts` e a semântica dos 6 kinds ficam como estão: mexer no tráfego (ex.: mais requests para `payment`) mudaria as assinaturas já aprovadas das outras 4 falhas e todos os fixtures. Se a T1.36 ou a T1.37 não fecharem os critérios só com o default, o engenheiro para e abre issue para o Arquiteto; mudança de semântica é nova emenda desta ADR, não decisão da task.
4. **Texto corrigido:** a semântica de `cache_cold_start` dizia "p95 de quem usa a cache"; passa a "p50", alinhada com a Emenda 1 do PRD (F-3 linha 7). Os comentários de cabeçalho de `src/faults/cache_cold_start.ts` (ainda fala em p95) e de `src/faults/service_crash_loop.ts` (diz "1 up, 2 down … exactly one instance is up", falso com `restartTicks = 3`: com período 4 e 3 réplicas, em 3 de cada 4 ticks há exatamente uma instância em pé e em 1 de cada 4 nenhuma; ≥ 1 fora em todo tick, como esta ADR exige) são corrigidos pelas tasks T1.34 e T1.35.

### Consequências

- Os fixtures de `disk_full` e `connection_pool_exhaustion` (T1.27) dependem destes defaults: T1.27 só gera depois de T1.36 e T1.37 em `main`. `fixtures/answers/*.json` são baseline e não mudam.
- A suíte multi-falha (T1.25) usa `connection_pool_exhaustion` com defaults: depende da T1.37.
- O exemplo de cenário em SPEC §7 declara `poolSize: 20, leakPerTick: 2` explícitos, com `startTick: 12` e alerta no tick 18; com esses valores o pool só esgota no tick 21, depois do alerta. Isso é conteúdo de cenário (fase 3), não default do motor: fica registrado para o Eng. Conteúdo ajustar os params do cenário 3, sem mudar o SPEC.
- O `--help` do CLI é gerado do catálogo e acompanha os defaults sem edição; o README (T1.28) não copia defaults à mão.

## Emenda 3 — 2026-10-25 (issues #62, #63, #66; QA dos PRs #56 e #59)

### Contexto

Com R1 do PRD ("o QA pode repetir com outra lista qualquer de ≥ 10 seeds, e o critério tem que valer também para ela"), três tasks da Emenda 2 reprovaram ou pararam por seeds em que uma condição por seed (R3) falha:

- **#63 (T1.36, PR #59, `disk_full`):** com `failRatio = 0,7`, o erro % do `orders-worker` fica em +0 p.p. em ~0,3% das seeds.
- **#62 (T1.37, PR #56, `connection_pool_exhaustion`):** no caso F-6 com `service_crash_loop` em `catalog`, ~0,65% das seeds não têm nenhuma request de `payment` na janela; o p95 do alvo e o do `gateway` não sobem.
- **#66 (T1.35, `cache_cold_start`):** o p50 do serviço fixo `auth` fica abaixo do piso de +18,75% em ~4% das seeds; `cart` e `catalog` são piores.

O Arquiteto mediu com um harness fora do repositório (só `resolveFaults`, `buildWorld` e `simulate` de `src/`; janela `startTick+6..+11`; média de janela do agregado, como `windowMean` de `test/support/signature.ts`), sobre **20 000 seeds consecutivas `arch-0..arch-19999`**, `main` em c7d1a96, com os parâmetros escritos explicitamente onde o default ainda não está em `main`:

| Caso | Condição por seed | Violações | Pior seed | Observação |
| --- | --- | --- | --- | --- |
| `disk_full`, `failRatio` 0,7 | erro % de `orders-worker` ≥ +3,75 p.p. | 133 / 20 000 (0,67%) | +0,00 | |
| `disk_full`, `failRatio` 0,8 | idem | 4 / 20 000 (0,02%) | +0,00 | bate com o cálculo: 12 requests na janela, cada uma falha com 0,8³ (`retries: 2`); P(nenhuma falha) = 0,488¹² ≈ 1,8·10⁻⁴ |
| `disk_full`, `failRatio` 0,9 | idem | **0 / 20 000** | +16,67 | P(nenhuma falha) = 0,271¹² ≈ 1,6·10⁻⁷; `postgres` mín. +67,19 p.p. (piso +7,5) |
| pool 20/4 sozinho | p95 de `payment` ≥ 2,5×; p95 do `gateway` ≥ +18,75% | 13 / 20 000 (0,065%) | — | **todas são seeds em que `payment` recebe 0 request na janela, já no baseline** (72 requests de entrada com `ratio` 0,1: 0,9⁷² ≈ 5·10⁻⁴). Nas outras 19 987: 0 violação, p95 de `payment` mín. 7,70× |
| pool 20/4 + crash loop em `catalog` (F-6) | idem | 180 / 20 000 (0,90%) | — | **todas com 0 request de `payment` na janela** (o `gateway` aborta antes de chamar `payment`). Nas outras 19 820: **0 violação**; p50 do `gateway` 0,68× na média (R5) |
| pool 20/4 + crash loop em `cart` | idem | 46 / 20 000 (0,23%) | — | todas com 0 request de `payment` |
| pool 20/4 + `cache_cold_start` | idem | 13 / 20 000 | — | as mesmas 13 seeds do pool sozinho |
| `cache_cold_start`, curva atual, `warmupTicks` 30 | p50 de `auth` ≥ +18,75% | 46 / 2 000 (2,3%) | +10,77% | p50 do melhor dos 3 usuários diretos da cache: 7 / 2 000 |
| idem, `warmupTicks` 60 | p50 de `auth` | 31 / 20 000 | +13,04% | melhor dos 3: 2 / 20 000 (mín. +17,14%) |
| `cache_cold_start`, **curva desta emenda**, `warmupTicks` 30 | p50 do melhor dos 3 usuários diretos | **0 / 20 000** | +25,71% | `auth` fixo: 0 / 20 000, mas pior seed +18,84% (sem margem) |
| idem | conexões de `postgres` ≥ +18,75% (par F-4) | **0 / 20 000** | +58,14% | baseline ≈ 5,2 conexões (E2: ≥ 2) |
| idem | RPS de `postgres` ≥ 1,75× em cada tick `startTick+1..+3` | **0 / 20 000** | 1,92× | |

Dois diagnósticos saem da tabela:

1. **Amostra pequena** (`disk_full`, `cache_cold_start`): o efeito existe em toda seed, mas a condição por seed depende de poucas requests e às vezes zera. Corrige-se com default ou semântica do kind, que é desta ADR.
2. **Alvo sem exercício** (`connection_pool_exhaustion`): em **toda** seed violada, o alvo não serve nenhuma request na janela. Já acontece com o pool sozinho (0,065%; a lista do QA ainda não pegou) e não há default de `poolSize`/`leakPerTick` que mude isso: a falha está lá (conexões em `poolSize`, R4 passa), mas ninguém usa o pool. Nessas seeds o incidente não tem impacto em request nenhuma, e a pista que resta é a métrica de conexões. O que falta é a regra de leitura de R3 para "alvo sem request", que é critério do PRD (PM).

### Regra de robustez para defaults e pares fixos

R1 vale para qualquer lista, mas qualquer condição por seed sobre telemetria gerada tem uma probabilidade residual de falhar. Para escolher default, curva ou par fixo, o Arquiteto e o Eng. Motor usam este critério:

- **0 violação** das condições R3/R4 da linha (e do par F-4) numa varredura de **20 000 seeds consecutivas `arch-0..arch-19999`**, com a janela e as fórmulas de `test/support/signature.ts`, fora das seeds isentas pela R6 (se o PM a aprovar; ver §3).
- 0 em 20 000 dá limite superior de ≈ 1,5·10⁻⁴ violação por seed (95%), ou seja, ≤ 0,15% de chance de uma lista de 10 seeds do QA reprovar. A contagem e a pior seed vão no corpo do PR.
- A varredura é medição de PR, não teste de CI (o tempo não cabe na suíte). O teste versionado continua sendo `signatureSeeds` + `ENGINE_QA_SEEDS`.
- Substitui a regra "menor valor da grade que fecha em 40 seeds e na lista do teste" da Emenda 2 §2: passa a ser "menor valor da grade que cumpre a regra de robustez".

### Decisão

1. **`disk_full`: `failRatio` padrão = 0,9** (substitui o 0,7 do PR #59). `fillTicks` fica 3; faixas e semântica iguais.
   - 0,8 tem violação residual de ≈ 1,8·10⁻⁴ por seed; uma varredura de 1 000 seeds, como a do QA em #63, reprova 0,8 com ≈ 16% de chance. Só 0,9 cumpre a regra de robustez na grade {0,6; 0,7; 0,8; 0,9}.
   - O argumento da Emenda 2 ("um disco que derruba quase toda request deixa de ensinar sintoma longe da causa") é revisto: disco cheio de verdade falha praticamente toda escrita, então 0,9 é mais realista que 0,4. O que ensina "sintoma longe da causa" (SPEC §7 linha 2) é onde o alerta e o primeiro sinal aparecem (dependentes: `orders-worker`, `payment`), não o `postgres` gritar menos. A fase de `warn` (`disk usage high`) antes do erro continua sendo a pista que antecede a falha.
   - Par F-4 fixo e dependente fixo de F-3 linha 2: (`orders-worker`, `errorPct`), como na Emenda 2.
2. **`cache_cold_start`: nova curva de miss forçado; `warmupTicks` fica 30.**
   - Para `0 ≤ s < warmupTicks`, cada chamada à cache é forçada a miss com probabilidade **`min(1, 2 · (1 − s / warmupTicks))`**: cache totalmente fria até `s = warmupTicks / 2`, depois aquecimento linear até `s = warmupTicks`. Antes era `1 − s / warmupTicks`. Com os defaults, a janela de assinatura (`s = 6..11`) fica 100% fria. A partir de `s ≥ warmupTicks`, nada muda (só a `cacheHitRatio` normal).
   - Motivo: uma cache que reinicia vazia só volta a acertar quando o conjunto quente é recarregado; a rampa linear desde `s = 0` aquecia rápido demais para um sinal que se mede no p50 de poucos serviços. O efeito continua emergindo do caminho de miss (SPEC §3.3); nada é roteirizado no chamador.
   - A seção "Semântica de cada kind" acima foi atualizada com a curva nova nesta emenda.
   - Descartados: `warmupTicks` 60 (default no limite da faixa, ainda 2/20 000 violações, e o fixture de 60 ticks deixaria de mostrar a volta ao normal); pedir ao PM p50 agregado dos usuários da cache (desnecessário com a curva nova).
   - **Leitura de F-3 linha 7 na T1.35:** "p50 de **≥ 1 serviço** que usa `redis` sobe ≥ 25%" é lido como o PRD escreve. R2: o p50 de `auth` sobe ≥ 25% na média das seeds (existe um serviço que cumpre). R3: em cada seed, pelo menos um dos usuários diretos da cache (`auth`, `catalog`, `cart`) sobe ≥ +18,75%. O "serviço fixo" que a T1.35 pedia era exigência do Arquiteto, mais estrita que o PRD, e E4 (par fixo) é regra de F-4, não de F-3. Pedagogicamente, a linha 7 ensina um efeito amplo e difuso (PRD Emenda 1), então qual usuário da cache mostra o p50 primeiro pode variar de seed para seed.
   - **Par F-4 fixo: (`postgres`, `connections`)**, no lugar de (`auth`, `p50`). É o sinal da linha 7 (a carga migra para o banco) e cumpre E1–E4 com folga (0/20 000, pior seed +58%). (`postgres`, `cpu`) é alternativa aceita.
   - Faixa de `warmupTicks` igual (1–60).
3. **`connection_pool_exhaustion`: nada muda no motor.** Defaults 20/4 e invariante `leakedAt(6) ≥ poolSize` da Emenda 2 ficam.
   - O caso F-6 da T1.37 e da T1.25 continua sendo pool em `payment` + `service_crash_loop` em `catalog`. É o caso mais rico para a linha 8 da campanha ("priorizar por impacto"): a queda upstream esconde o pool, e isso é comportamento correto do sistema, não bug. Trocar o par por um que não mascara não resolve: com `cache_cold_start` sobram as mesmas 13 seeds do pool sozinho.
   - O que destrava a T1.37 é a **R6, proposta ao PM** (texto exato no PR desta emenda e em #62): numa seed em que o alvo não serve nenhuma request na janela da execução com falha, as condições de tamanho de efeito (R3/E3) que dependem de requests do alvo ou de seus chamadores diretos não se aplicam; as condições de existência que não dependem de request (conexões em `poolSize`) continuam; e a fração de seeds isentas tem teto de 2%. Com a R6, as 180 violações do caso F-6 e as 13 do pool sozinho ficam isentas, e sobra 0 violação em 20 000 seeds.
   - Se o PM recusar a R6, a saída que resta é mudança de tráfego (ex.: `ratio` de `payment` no `gateway`). Isso é emenda da ADR-002 e reabre as assinaturas dos 6 kinds; o Arquiteto não toma essa decisão sem nova rodada.
4. **Inalterados:** semântica de `connection_pool_exhaustion`, `service_crash_loop`, `bad_deploy` e `slow_dependency`; `src/sim/traffic.ts`; `src/world/default-shop.ts`; `src/types.ts`.

### Consequências

- **T1.36 (PR #59):** default 0,9 em vez de 0,7; o resto do PR fica.
- **T1.35:** muda uma expressão de código em `src/faults/cache_cold_start.ts` (a probabilidade de miss) e o comentário de cabeçalho; o teste de módulo "the forced-miss ratio decreases linearly" vira "plateau, then linear"; R3 de p50 lido como "≥ 1 usuário da cache por seed"; par F-4 (`postgres`, `connections`).
- **T1.37 (PR #56) e T1.25 (PR #47):** implementam a isenção R6 no helper e nos testes, mas **só são mergeadas depois de a R6 entrar no PRD**. Sem a R6, a T1.37 continua reprovável por R1 mesmo no caso "pool sozinho".
- **T1.27 (PR #53):** os fixtures de `disk_full`, `connection_pool_exhaustion` e `cache_cold_start` só são gerados depois de T1.35, T1.36 e T1.37 em `main` (`cache_cold_start` entra na lista porque a curva muda a telemetria).
- **Eng. Conteúdo (fase 3):** com a R6, o cenário 3 (e o 8) precisa de uma seed em que o alvo recebe request na janela; o validador da fase 4 pode checar isso rodando o motor. Fica registrado; não é critério desta fase.
