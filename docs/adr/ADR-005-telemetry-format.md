# ADR-005 — Formato de telemetria, NDJSON, trace simplificado e fixtures

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "formato de trace simplificado", "estrutura interna do motor")
- **Referência:** SPEC §3.3, §4, §11; PRD S-1..S-4, P-1..P-4, W-4, CLI-1, D-1..D-3

## Contexto

O PRD exige: discriminador de tipo no NDJSON (CLI-1), vocabulário de nível de log (S-2), trace próprio não-OTLP (S-3), métricas derivadas dos spans (P-1/P-2), verificação externa (P-4) e fixtures versionados (D-3). A ordem e o formato precisam ser canônicos para byte-identidade (D-1).

## Decisão

### Registros (tipos em `types.ts` §4)

Uma linha NDJSON = um registro. Discriminador: campo **`type`**, valores `metric`, `log`, `span`, `event`. Todo registro tem `tick` inteiro em `[0, ticks)` (W-4). Não há linha de cabeçalho.

Ordem das chaves em cada linha (campos opcionais ausentes são omitidos, nunca `null`):

- `metric`: `type, tick, component, instance?, rps, p50, p95, p99, errorPct, cpu, mem, connections`
- `span`: `type, tick, traceId, spanId, parentId?, component, instance, operation, kind, peer?, startMs, durationMs, status`
- `log`: `type, tick, component, instance, level, message, traceId?, attrs?` (chaves de `attrs` em ordem de inserção pelo gerador, que é determinística)
- `event`: `type, tick, kind, target, instance?, restart?, note?`

### Ordem das linhas

Por tick crescente; dentro do tick: (1) `event` — de falhas na ordem das falhas, depois de noise na ordem de entrada; (2) `span` — na ordem de geração (requests em ordem de início, pré-ordem da árvore); (3) `log` — logs de falha (`onTick`) na ordem das falhas, depois logs de request na ordem dos spans; (4) `metric` — componentes na ordem do mundo (serviços, depois dependências), para cada um as instâncias em ordem e então o agregado (sem `instance`).

### Métricas (S-1, P-1, P-2)

Exatamente `rps, p50, p95, p99, errorPct, cpu, mem, connections`. Unidades: rps em req/s; p* em ms; errorPct em 0–100; cpu em % (0–100); mem em MB; connections em contagem.

- Métricas de requisição derivam dos spans **`kind: 'server'`** do componente/instância que começaram no tick (é o "span raiz de servidor" de P-1: a entrada da request naquela instância, inclusive cada retry que a alcança). `rps = n / 10`; `errorPct = erros / n × 100` (0 se n = 0); percentil *nearest-rank* `sorted[ceil(p/100 × n) − 1]` (0 se n = 0).
- Agregado do componente: mesma regra sobre a união dos spans de todas as instâncias (P-2), nunca média de percentis. `cpu` agregado = média das instâncias; `mem` e `connections` agregados = soma.
- Recursos: `cpu = cpuBasePct + cpuPerRequestPct × n + jitter + cpuPctAdd`, limitado a 100; `mem = memBaseMb + jitter + memMbAdd`; `connections = ceil(Σ duração dos spans client para dependências database / 10000) + connectionsAdd`, limitado por `connectionsCap`; em dependências, `connections` = soma das conexões dos clientes. Jitter do stream `('res', ...)`. Instância `down`: zeros em tudo menos `mem`.

### Logs (S-2, P-3)

Níveis: `debug`, `info`, `warn`, `error`. Todo span com `status: 'error'` (client ou server) gera exatamente um log `error` no mesmo componente, instância, tick e `traceId`, com a mensagem do `ErrorDetail`. Logs `info` de request são amostrados (stream `('logs', ...)`, ~20% dos spans server). Mensagens são telemetria genérica em inglês (`upstream timeout`, `connection refused`, ...), sem texto de cenário (S-5).

### Trace simplificado (S-3)

Árvore por `traceId` com uma raiz (o span server da ingress), `parentId` nos demais, `startMs` relativo ao início da raiz e `durationMs` inteiro; para todo filho, `startMs_f + durationMs_f ≤ startMs_p + durationMs_p` e `durationMs_f ≤ durationMs_p`. Sem amostragem: o NDJSON contém todos os spans (P-4). Não é OTLP.

### Verificador independente (P-4)

`packages/engine/scripts/verify-coherence.mjs`: JavaScript puro, sem importar nada de `src/` nem dependências; lê NDJSON de um arquivo (argumento) ou stdin, recalcula `rps`, `errorPct`, `p50/p95/p99` por instância e agregado a partir dos spans e compara com as linhas `metric` (tolerância 1e-9); também checa P-3 e S-3. Sai 0 se tudo confere, 1 com o primeiro desvio no stderr.

### Fixtures (D-3, SPEC §9 Eng. Motor)

- `packages/engine/fixtures/` contém exatamente 7 arquivos NDJSON: `baseline.ndjson` e `<kind>.ndjson` para os 6 kinds, cada um gerado por `whodeployed-engine simulate --seed fixture --ticks 60 [--fault <kind>]` (padrões da ADR-004). O comando de cada arquivo fica em `packages/engine/scripts/gen-fixtures.mjs` e no README do pacote; o teste `test/fixtures.test.ts` regenera e compara byte a byte.
- Respostas de `ask()` para a UI ficam no subdiretório `fixtures/answers/` (um JSON por kind de `Question`, baseline seed `fixture`, tick 30). Assim `ls fixtures/*.ndjson` conta os 7 do D-3.
- Fixtures não entram no tarball (PUB-2).
- Orçamento de tamanho: cada NDJSON de 60 ticks ≤ 2 MB; a topologia da ADR-002 foi dimensionada para isso.

## Consequências

- UI e conteúdo (fases 2–3) podem consumir os fixtures e os tipos sem esperar o motor.
- Mudança de qualquer algoritmo de geração muda fixtures; o PR regenera com `pnpm --filter ./packages/engine fixtures` e explica o diff.

## Alternativas descartadas

- **OTLP/JSON:** fora de escopo (SPEC §4) e verboso demais.
- **Um registro de métrica por nome de métrica:** 8× mais linhas sem ganho; o registro único facilita P-1.
- **Linha de cabeçalho com seed/config:** quebraria W-4 (todo registro tem tick).

## Emenda 1 — 2026-10-25 (issue #24, QA da onda 1 e da T1.14)

Registra escolhas da T1.5, T1.6, T1.7, T1.13 e T1.14 que esta ADR deixava em aberto. Salvo onde indicado, `main` já se comporta assim.

### Recursos (T1.6)

- **Jitter:** `cpu` recebe ruído uniforme em `[−1, +1)` ponto percentual; `mem` recebe ruído uniforme em `[−1%, +1%)` de `memBaseMb`. Ambos do stream `('res', tick, component, instance)`. Constantes `CPU_JITTER_PCT` e `MEM_JITTER_RATIO` em `src/sim/metrics.ts`.
- **Pools por banco:** `dbPoolSize` é por instância **e por dependência `database`** (como diz `types.ts`). Para cada banco que a instância chama (por `calls[].target` ou `onMiss.target`), o pool tem `ceil(Σ durationMs dos spans client para aquele banco / 10000)` conexões; `connectionsAdd` e `connectionsCap` da instância se aplicam a **cada pool**; a métrica `connections` do serviço é a soma dos pools. Isto substitui a fórmula única do texto original ("Σ ... / 10000 + connectionsAdd") e coincide com ela quando o serviço chama um só banco, que é o caso de todo o `default-shop`. Serviço que não chama banco tem um pool implícito de 0 conexões (o `connectionsAdd` continua aparecendo).
- **Dependências:** a métrica `connections` de uma dependência é a soma das conexões dos clientes **a ela**: para `database`, os pools acima; para `cache` e `queue`, `ceil(Σ ms dos spans client / 10000)` por instância cliente. Essa ocupação de cache/queue conta só do lado da dependência; a métrica do cliente conta só pools de banco. Com várias réplicas, o total é repartido entre as instâncias da dependência em proporção aos ms que cada uma serviu, pelo método do maior resto (empate para o menor índice); sem ms servidos, tudo vai para a primeira instância em pé; instância `down` recebe 0. Depois aplicam-se o `connectionsAdd`/`connectionsCap` da própria dependência.

### Chaves de `attrs`

Chaves de `attrs` (logs, `FailEffect`, `ErrorDetail`, `FaultLog`) casam com `^[A-Za-z_][A-Za-z0-9_]*$`: identificador, **nunca** em forma de inteiro. Motivo: `Object.entries`/`JSON.stringify` põem chaves inteiras (`"2"`) antes das demais, e a ordem deixaria de ser a de inserção que esta ADR promete. O serializador (T1.5) não muda. Quem gera `attrs` (T1.7, T1.14 e as falhas T1.17–T1.22) obedece à regex; a T1.24 verifica sobre toda a telemetria gerada.

### Vocabulário de mensagens (fechado)

`message` de log é uma destas strings; mensagem nova entra por emenda desta ADR ou da ADR-004 (mensagens de falha), no mesmo PR que a usa:

| Origem | Mensagens |
| --- | --- |
| Tráfego (T1.14, `MESSAGES` em `traffic.ts`) | `connection refused`, `upstream timeout`, `upstream error`, `dependency call failed` |
| Logs de request (T1.7) | `request completed` (nível `info`) |
| Falhas (ADR-004, "Semântica") | `process exited`, `no space left on device`, `disk usage high`, `connection pool timeout`, `unhandled exception` |

### Verificador independente (T1.13)

- **Códigos de saída:** 0 = coerente; 1 = primeiro desvio de coerência ou de formato (stderr); **2** = erro de uso ou de leitura (argumentos a mais, arquivo inexistente). Substitui o "0 ou 1" do texto original.
- **`null` em campo opcional** (ex.: `"instance": null`) é desvio de formato: o verificador sai 1. Hoje ele aceita e trata como agregado; a correção é da T1.26 (que já usa o script no CI e passa a editá-lo).
- **Fica aceito, por desenho:** registro `metric` zerado em tick ou componente sem spans, e instância sem registro de métrica. O verificador não conhece o `SystemDefinition`, então não sabe quais componentes e instâncias existem; completude das métricas é S-1, verificada pela T1.24 contra o mundo.
