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
- Orçamento de tamanho: cada NDJSON de 60 ticks ≤ 2 MB; a topologia da ADR-002 foi dimensionada para isso. *(Substituído pela Emenda 2: ≤ 3 MiB por arquivo.)*

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

## Emenda 2 — 2026-10-25 (bloqueio da T1.27: orçamento de tamanho dos fixtures)

### Contexto

A T1.27 mediu os 7 NDJSON com os comandos desta ADR (seed `fixture`, 60 ticks, padrões da ADR-004): baseline 1.976.962 bytes; `service_crash_loop` 1.939.950; `bad_deploy` 1.637.441; `slow_dependency` 2.435.840; `cache_cold_start` 2.150.137; `disk_full` 2.132.298 (`failRatio` atual); `connection_pool_exhaustion` ≈ 1.995.000. Três passam do orçamento de 2 MB do texto original. O Arquiteto mediu também os defaults que a Emenda 2 da ADR-004 ainda pode escolher: `disk_full` com `failRatio` 0,6 = 2.259.634 e 0,9 = 2.535.432 (pior caso da grade da T1.36); `connection_pool_exhaustion` com `leakPerTick` 4 = 1.994.912. `gzip -9` de `slow_dependency` = 138.551.

Nada disso pode encolher pelos meios normais: D-3 exige ≥ 60 ticks; o formato (esta ADR), a topologia e o ingress (ADR-002 §6) e os defaults (ADR-004) estão fixos; P-4 e D-3 exigem todos os spans, sem amostragem. Os 2 MB eram uma estimativa de dimensionamento desta ADR, não critério do PRD: D-3 não fala em tamanho.

### Decisão

1. **Orçamento por arquivo: ≤ 3 MiB (3.145.728 bytes)** para cada `fixtures/*.ndjson` de 60 ticks. Substitui o "≤ 2 MB" da seção "Fixtures". Pior caso medido: 2.535.432 bytes (`disk_full` a 0,9), 19% abaixo do teto. A soma dos 7 fica entre 14,4 e 14,7 MB, conforme o default que a T1.36 escolher.
2. **O formato continua NDJSON puro, sem compressão no repositório.** Nomes e contagem de D-3 (`ls fixtures/*.ndjson | wc -l` = 7) não mudam.
3. **O teto é verificado em teste:** `test/fixtures.test.ts` (T1.27), além de regenerar e comparar byte a byte, afirma `size ≤ 3_145_728` para cada arquivo. Se uma mudança futura de algoritmo ou de default passar do teto, o PR que a causa para e pede emenda desta ADR. Não se troca o formato, não se reduz `ticks` e não se amostram spans para caber.
4. **Atributos git:** a T1.27 cria `packages/engine/.gitattributes` com a linha `fixtures/** text eol=lf linguist-generated=true`. `eol=lf` impede que um checkout com `core.autocrlf` (Windows) quebre a comparação byte a byte de D-3. `linguist-generated` recolhe por padrão o diff desses arquivos no GitHub, sem escondê-lo: `git diff` continua mostrando as linhas, e é assim que o PR explica a regeneração.
5. **Fora do pacote npm, como antes (PUB-2):** o campo `files` do `package.json` não inclui `fixtures/`, e a checagem do tarball da T1.26 continua valendo. O tamanho dos fixtures não afeta quem instala o pacote.

### Por que não as alternativas

- **Versionar `.ndjson.gz`:** mudaria o critério D-3 do PRD (`*.ndjson`), que é do PM. Além disso, a saída do gzip depende da versão e do nível do zlib. O teste de regeneração teria de comparar o conteúdo descomprimido, e o arquivo versionado deixaria de ser byte-idêntico ao que o CLI gera, o que tira de D-1 sua demonstração mais direta. A UI e qualquer leitor externo teriam de descomprimir. O ganho de armazenamento é pequeno, porque o git já guarda blobs comprimidos com zlib: no clone, cada fixture custa perto do tamanho gzip (~140 KB), não os 2,4 MB brutos.
- **Git LFS:** depende de serviço externo ao repositório, quebra clones e forks sem LFS e complica a contribuição (SPEC §3.7, §3.8). Desproporcional para ~15 MB.
- **Menos ticks, menos tráfego ou amostragem de spans:** proibidos por D-3, ADR-002 §6 e P-4.
- **Manter 2 MB e encolher o formato (chaves curtas, colunas):** mudaria o contrato desta ADR e de `types.ts`, que motor, verificador e UI já consomem, só para caber num número que não é critério de ninguém.

### Consequências

- **PRD:** nenhum critério muda. D-3 e PUB-2 ficam como estão; o orçamento é só desta ADR.
- **Repositório público:** cada regeneração de fixtures adiciona ao histórico aproximadamente o tamanho comprimido dos arquivos alterados (dezenas a centenas de KB por PR). Aceitável; esta ADR já exige que o PR explique o diff.
- **UI (fases 2–3):** os fixtures servem a desenvolvimento e testes. O build de produção do site não empacota os 7 NDJSON no bundle JavaScript. Se uma tela precisar de um deles no ar, carrega por `fetch` de arquivo estático (o GitHub Pages comprime no transporte) ou usa a biblioteca do motor no browser. A decisão concreta é do Arquiteto da fase em que a UI existir.
- **T1.27:** o critério de tamanho passa a ser 3 MiB e a tarefa ganha o `.gitattributes`. As dependências não mudam: os NDJSON de `disk_full` e `connection_pool_exhaustion` continuam esperando T1.36 e T1.37.

## Emenda 3 — 2026-10-26 (fase 2: ações, ADR-012)

- **Ordem dos eventos no tick:** (1a) eventos de falha, na ordem das falhas (as falhas induzidas e as gerações `g ≥ 1` da ADR-012 entram depois das falhas da configuração, na ordem em que foram criadas); (1b) eventos de ação (`restart`: `config` com `restart: true`; `rollback`: `deploy`), na ordem em que `act()` foi chamado; (1c) eventos de noise, na ordem de entrada. O resto da ordem (spans, logs, métricas) não muda.
- Eventos de ação têm `target` e não têm `instance` nem `note`. O motor não marca a origem do evento (falha, ação ou noise), como já vale para `whatChanged` (ADR-006).
- Nenhuma mensagem de log nova: o `restart` usa o mecanismo de instância `down` (`connection refused` no chamador, ADR-002 §5) e não emite log próprio. O vocabulário fechado da Emenda 1 continua o mesmo.
- Sem ação, nada muda: os 7 NDJSON de `fixtures/` ficam byte-idênticos (PRD FASE-2 EN-2). Fixtures de ação e de impacto ficam em `fixtures/actions/` e `fixtures/impact/` (JSON, tarefa T2.7), fora da contagem `fixtures/*.ndjson` de D-3.
