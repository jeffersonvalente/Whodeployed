# FASE-1 — Motor

- **Fase:** 1 — Motor (SPEC §8, semanas 1–3)
- **Liberada por:** `docs/gates/GATE-0.md` (aprovado pelo Diretor em 2026-10-25)
- **Autor:** PM
- **Entrada:** SPEC §3, §4, §5, §6, §7, §8, §10, §11; ADR-001; GATE-0
- **Consumidores:** Arquiteto (`FASE-1.tasks.md`, ADRs), Eng. Motor (PRs), QA (relatório por PR e `GATE-1.md`)

Convenções deste documento:

- `$ENGINE` = `packages/engine`. Comandos pnpm usam filtro por caminho: `pnpm --filter ./packages/engine <script>`.
- `$CLI` = o comando que executa o CLI dentro do repositório, exatamente como documentado em `packages/engine/README.md` (o nome do binário é decisão do Arquiteto).
- **Baseline** = simulação com o mesmo mundo, a mesma seed e os mesmos ticks, sem nenhuma falha.
- **Janela de assinatura** = ticks `startTick+6` a `startTick+11` (inclusive) de uma falha; comparações "contra baseline" usam a média da métrica nessa janela na execução com falha versus a mesma janela no baseline.
- "Definido em ADR" significa: a escolha é do Arquiteto (SPEC §12, decisões delegadas), mas tem que existir em `docs/adr/` antes do PR que a implementa, e o QA verifica contra ela.

## Objetivo da fase

Entregar `packages/engine`: um simulador determinístico da loja fictícia que injeta 6 tipos de falha, gera métricas, logs, traces e eventos coerentes entre si, responde `ask()`, e roda sozinho como CLI `simulate --seed --fault --ticks` empacotado e instalável fora do repositório (SPEC §8, fase 1; Gate 1: "mesma seed = mesma telemetria; 6 falhas; CLI publicado").

## Histórias

| # | História | Justificativa no spec |
| --- | --- | --- |
| H1 | Como **agente Eng. UI/Conteúdo (fases seguintes)**, quero um contrato TypeScript estável (`World`, `Fault`, `Question`, `Answer`, `Action`) para construir em paralelo sem esperar o motor. | SPEC §6 "Contrato central do motor (fixo a partir da fase 1)"; §9 Arquiteto |
| H2 | Como **jogador**, quero que logs, métricas e traces venham da mesma simulação para que eu só consiga resolver o incidente raciocinando, não decorando padrões roteirizados. | SPEC §3.3; §11 "Motor gera telemetria incoerente" |
| H3 | Como **jogador**, quero que a mesma seed produza exatamente a mesma telemetria para que um incidente seja reproduzível, compartilhável e revisável. | SPEC §3.3; §8 Gate 1; §10 "mesma seed produz telemetria byte-idêntica" |
| H4 | Como **jogador**, quero que cada falha se manifeste também em sinais indiretos (dependentes, agregados, outras instâncias) para que o jogo me ensine que o sinal mente. | SPEC §3.4; §7 tabela da campanha |
| H5 | Como **jogador**, quero poder fazer qualquer uma das 6 perguntas desde o primeiro incidente, pagando só em tempo, para que a progressão seja de repertório e não de ferramenta. | SPEC §3.2; §5 "custo de cada pergunta é tempo" |
| H6 | Como **contribuidor SRE**, quero rodar `simulate --seed --fault --ticks` e obter NDJSON sem instalar o jogo para inspecionar e reaproveitar a telemetria sintética. | SPEC §6 "Entregável isolado: biblioteca npm + CLI ... usável sem o jogo"; §11 "motor sozinho já é release" |
| H7 | Como **contribuidor não-programador (fases seguintes)**, quero que sistema e falhas sejam dados passados ao motor, não constantes no código, para que um cenário YAML consiga descrevê-los depois. | SPEC §3.7; §7 (`system`, `faults`, `noise`) |
| H8 | Como **agente QA**, quero critérios executáveis por comando para aprovar PRs e o Gate 1 sem opinião. | SPEC §9 regras 2 e 3; §10 "CI bloqueia merge" |

## Critérios de aceite

Legenda de "Quem verifica": **CI** = falha o workflow `.github/workflows/ci.yml` se violado; **QA** = agente QA roda o comando e cola a saída no relatório do PR ou do gate; **Diretor** = ação ou registro que só o Diretor pode fazer.

| ID | Critério | Como verificar | Quem verifica |
| --- | --- | --- | --- |
| **Contrato** | | | |
| CT-1 | `$ENGINE` exporta `World`, `Fault`, `FaultKind`, `Question`, `Answer`, `Action` e `Signal`; `World`, `Fault`, `Question`, `Answer` e `Action` têm forma idêntica à de SPEC §6 (mesmos campos, mesmos tipos, mesma união de `Question` com os 6 `kind`, mesma união de `Action` com os 6 `kind`). | Teste de tipo em `$ENGINE/test/` com `expectTypeOf<X>().toEqualTypeOf<CopiaLiteralDoSpec>()` para cada tipo; roda em `pnpm --filter ./packages/engine test`. | CI |
| CT-2 | O pacote compila em TypeScript `strict: true` sem erros. | `grep '"strict": true'` no tsconfig efetivo do pacote; `pnpm --filter ./packages/engine exec tsc --noEmit` sai com código 0. | CI |
| CT-3 | O código da biblioteca (tudo em `$ENGINE/src` exceto os arquivos do CLI, cuja localização é definida em ADR) não importa nenhum módulo externo nem built-in do Node. | Script/teste que lista os `import` dos arquivos da biblioteca e falha se algum especificador não for relativo (`./`, `../`). | CI |
| **Mundo** | | | |
| W-1 | O sistema padrão (`default-shop`) contém exatamente os serviços `gateway`, `auth`, `catalog`, `cart`, `payment`, `orders-worker` e as dependências `postgres`, `redis`, `queue`; nenhum outro componente. | Teste compara o conjunto de nomes de `World.services` e `World.deps` com as duas listas acima. | CI |
| W-2 | Cada um dos 6 serviços do `default-shop` tem ≥ 3 instâncias; cada instância tem identificador estável entre execuções com a mesma seed. | Teste conta instâncias por serviço e compara identificadores de duas execuções. | CI |
| W-3 | A definição do sistema (componentes, instâncias, topologia de chamadas) é dado de entrada do motor, não constante dentro da lógica de simulação: o motor simula um mundo arbitrário de 2 serviços + 1 dependência construído no próprio teste. | Teste cria um mundo mínimo diferente do `default-shop`, roda 30 ticks e verifica que só os componentes desse mundo aparecem na telemetria. | CI |
| W-4 | 1 tick = 10 s de jogo: todo registro de telemetria carrega o tick em que foi gerado, e taxas por segundo são calculadas sobre 10 s. | Coberto por P-1 (RPS = spans do tick ÷ 10); teste verifica que todo registro do NDJSON tem campo de tick inteiro em `[0, ticks)`. | CI |
| **Falhas** | | | |
| F-1 | `FaultKind` é uma união de exatamente 6 literais, incluindo `connection_pool_exhaustion` (SPEC §7). Uma ADR mapeia cada literal a uma linha da campanha de SPEC §7: falhas 1, 2, 3, 4, 5 e 7. (A linha 6, alerta ruidoso, é `noise`; a linha 8 é a composição de duas falhas — ver F-6.) | Teste de tipo afirma 6 membros e a presença de `connection_pool_exhaustion`; QA confere a tabela de mapeamento na ADR. | CI + QA |
| F-2 | Antes de `startTick` a falha é invisível: para cada `FaultKind`, os registros com tick `< startTick` são byte-idênticos aos do baseline. | Teste parametrizado pelos 6 kinds compara a serialização dos ticks anteriores a `startTick` com o baseline. | CI |
| F-3 | Cada `FaultKind`, com os parâmetros padrão documentados, produz a assinatura mínima da tabela "Assinaturas de falha" abaixo, medida na janela de assinatura contra o baseline. | Um teste por linha da tabela, sobre ≥ 10 seeds distintas; todas têm que passar. | CI |
| F-4 | Toda falha se manifesta fora do alvo (SPEC §3.4): para cada `FaultKind`, pelo menos uma métrica de um componente diferente de `target` (dependente, chamador ou dependência) desvia ≥ 25% do baseline na janela de assinatura. | Teste parametrizado pelos 6 kinds, ≥ 10 seeds. | CI |
| F-5 | Agregado esconde instância (SPEC §3.4, cenário 4): com a falha que afeta 1 de N instâncias, o erro % da instância afetada fica ≥ 10 pontos percentuais acima do baseline, as demais instâncias ficam a ≤ 2 p.p. do baseline, e o erro % agregado do serviço fica ≤ metade do erro % da instância afetada. | Teste sobre ≥ 10 seeds, na janela de assinatura. | CI |
| F-6 | O motor aceita uma lista de falhas (≥ 2 simultâneas, inclusive em alvos diferentes), como em SPEC §7 (`faults:` é lista; cenário 8). Com duas falhas, as assinaturas F-3 de ambas aparecem, e a saída continua determinística (D-1). | Teste com duas falhas de kinds diferentes em alvos diferentes. | CI |
| F-7 | Entrada de falha inválida é rejeitada com mensagem legível: `target` inexistente no mundo, `FaultKind` desconhecido, parâmetro desconhecido ou fora da faixa documentada, `startTick` negativo. A mensagem nomeia o campo e os valores válidos. | Teste por caso de erro afirmando que lança erro tipado com mensagem contendo o campo. | CI |
| **Sinais** | | | |
| S-1 | Para cada componente e cada instância, a cada tick, o motor gera as métricas de SPEC §4: RPS, latência p50, p95, p99, erro %, CPU, memória, conexões. Nenhuma métrica fora dessa lista é exposta em `dashboard` (SPEC §4, §1 "O que NÃO é"). | Teste verifica presença das 8 métricas para todo componente × instância × tick em 30 ticks e que o conjunto de nomes é exatamente esse. | CI |
| S-2 | Logs são estruturados: cada entrada tem tick, componente, instância, nível (vocabulário definido em ADR), mensagem e, quando ligada a uma request, `traceId`. Cada entrada é serializável como uma linha JSON. | Teste valida todas as entradas de 30 ticks × 6 kinds contra o formato da ADR. | CI |
| S-3 | Traces são árvores de spans: cada span tem id, id do pai (ausente só na raiz), componente, instância, operação, duração em ms e status `ok`/`error`; a duração de todo filho é ≤ a do pai; toda árvore tem exatamente uma raiz. Formato próprio simplificado (não OTLP). | Teste de propriedade sobre todas as árvores de 30 ticks × 6 kinds × 10 seeds. | CI |
| S-4 | Eventos de deploy/config: o motor emite eventos com tick, alvo e tipo, tanto os gerados por falha (quando a falha implica mudança, ex.: deploy ruim) quanto os de `noise` recebidos na entrada (formato `noise` de SPEC §7). Eventos de `noise` não alteram nenhuma métrica, log ou span: a telemetria sem os registros de evento é byte-idêntica à de uma execução sem `noise`. | Teste com 2 eventos de noise (um deploy, um config). | CI |
| S-5 | Telemetria é gerada, não roteirizada (SPEC §3.3): `$ENGINE/src` não contém ids, títulos ou textos de cenário; seeds diferentes geram valores de métrica diferentes. | `grep -rniE "launch-day|0[1-8]-[a-z]" $ENGINE/src` vazio; teste: 10 pares de seeds distintas com a mesma falha produzem hashes diferentes e pelo menos uma métrica numérica diferente. | CI + QA |
| **Coerência (propriedade do Gate 1)** | | | |
| P-1 | Toda métrica de requisição de cada instância em cada tick é derivável dos spans do tick: RPS = nº de spans raiz de servidor da instância no tick ÷ 10; erro % = spans raiz com `error` ÷ total × 100 (0 quando total = 0); p50/p95/p99 = percentil por *nearest-rank* das durações desses spans. Igualdade exata ou com tolerância ≤ 1e-9. | Teste de propriedade sobre ≥ 100 seeds × (baseline + 6 kinds) × 30 ticks. | CI |
| P-2 | A métrica agregada de serviço é derivada da união dos spans de todas as instâncias (não é média de percentis de instância), pela mesma regra de P-1. | Mesmo teste de P-1, nível serviço. | CI |
| P-3 | Todo span com status `error` tem ≥ 1 log de nível de erro no mesmo componente, instância e tick, com o mesmo `traceId`. | Mesmo conjunto de execuções de P-1. | CI |
| P-4 | A propriedade P-1/P-2 é verificável fora do motor: o NDJSON do CLI contém todos os spans gerados (sem amostragem), e um script independente do código da simulação recalcula as métricas a partir dos spans do arquivo e confere com os registros de métrica. | Script em `$ENGINE/scripts/` (ou equivalente definido em ADR) que só lê o NDJSON; QA o roda sobre a saída de `$CLI simulate --seed qa --fault <kind> --ticks 60` para os 6 kinds. | QA |
| **Perguntas (`ask`)** | | | |
| Q-1 | `ask()` aceita os 6 `kind` de `Question` em qualquer tick, sem parâmetro ou estado de nível de jogador; o motor não tem conceito de nível (SPEC §3.2, §5 regra de ouro). | Teste chama os 6 kinds num mundo recém-criado e afirma `Answer` válido; `grep -rniE "junior|pleno|senior|playerLevel" $ENGINE/src` vazio (o campo de nível de log de S-2 não conta). | CI |
| Q-2 | Todo `Answer` ecoa a `question` recebida (igualdade profunda), traz `data` e `tickCost` inteiro ≥ 1; `tickCost` é função só do `kind` (e dos parâmetros da pergunta, se a ADR assim definir), segundo tabela publicada em ADR. | Teste compara `tickCost` de cada kind com a tabela da ADR. | CI + QA |
| Q-3 | Perguntar não altera a simulação: a telemetria de uma execução com perguntas intercaladas é byte-idêntica à de uma execução sem perguntas; a mesma pergunta no mesmo tick devolve `Answer` idêntico. | Teste com 20 perguntas aleatórias (PRNG seedado do teste) intercaladas em 60 ticks. | CI |
| Q-4 | `dashboard`: devolve as métricas de S-1 do serviço com valores iguais aos registros de métrica da telemetria nos mesmos ticks (janela definida em ADR). | Teste compara `Answer.data` com os registros da execução. | CI |
| Q-5 | `logs`: devolve só entradas do serviço com tick dentro de `window` terminando no tick atual (unidade de `window` definida em ADR e em JSDoc); com `filter`, só entradas cujos campos são iguais a todos os pares do filtro; `filter` vazio = sem filtro. | Teste com e sem filtro, comparando com o conjunto de logs da execução. | CI |
| Q-6 | `trace`: devolve a árvore de uma request do serviço cuja duração de raiz é o percentil pedido (50/95/99, *nearest-rank*) entre as raízes do serviço no tick; essa duração é igual ao pXX que `dashboard` mostra para o mesmo tick. | Teste nos 3 percentis × 6 kinds. | CI |
| Q-7 | `whatChanged`: devolve todos e somente os eventos de deploy/config (de falha e de noise) com tick em `[atual − window, atual]`. | Teste com eventos dentro e fora da janela. | CI |
| Q-8 | `compare`: com `by: 'instance'` devolve uma série por instância do serviço para a métrica pedida (com a falha de F-5, a instância afetada é a de maior erro %); com `by: 'lastWeek'` devolve a série da mesma métrica numa simulação sem falhas do mesmo mundo, com derivação de seed definida em ADR, e portanto sem o efeito da falha. | Teste dos dois modos; para `lastWeek`, igualdade com a série do baseline derivado. | CI |
| Q-9 | `askNpc`: devolve dado estruturado derivado do estado da simulação (muda entre baseline e execução com falha), sem prosa escrita no código do motor; strings no `data` só podem ser identificadores (componente, instância, kind, métrica). Texto narrativo de NPC é conteúdo (SPEC §3.7) e não é desta fase. | Teste dos 3 papéis comparando baseline × falha e validando os tipos dos campos. | CI |
| Q-10 | Pergunta inválida (serviço ou métrica inexistente, `window` ≤ 0, percentil fora de 50/95/99) gera erro tipado cuja mensagem lista os valores válidos; nunca `undefined` nem exceção genérica. | Teste por caso. | CI |
| **Determinismo** | | | |
| D-1 | Mesma seed + mesmos argumentos = saída byte-idêntica: duas execuções do CLI em processos separados produzem o mesmo SHA-256, para baseline e para cada um dos 6 kinds. | Passo de CI: `$CLI simulate --seed gate1 --fault <kind> --ticks 120 \| sha256sum` duas vezes por kind, comparando; QA repete localmente. | CI + QA |
| D-2 | O determinismo não depende de ambiente: a saída é byte-idêntica com `TZ=UTC LANG=C` e com `TZ=Asia/Tokyo LANG=pt_BR.UTF-8`. | Passo de CI comparando os hashes das duas execuções. | CI |
| D-3 | Fixtures de referência versionadas: `$ENGINE/fixtures/` contém um NDJSON de ≥ 60 ticks para o baseline e para cada um dos 6 kinds, com o comando que os gerou; um teste regenera e compara byte a byte. (São também os fixtures para a UI, SPEC §9 Eng. Motor.) | `ls $ENGINE/fixtures/` mostra 7 arquivos; teste de regeneração passa. | CI |
| D-4 | Nenhuma fonte de não-determinismo em `$ENGINE/src`: sem `Math.random`, `Date.now`, `new Date(`, `performance.now`, `crypto.getRandomValues`, `crypto.randomUUID`; lint falha se `Math.random` aparecer fora de `test/`. Toda aleatoriedade vem do PRNG seedado do pacote. | `grep -rnE "Math\.random\|Date\.now\|new Date\(\|performance\.now\|getRandomValues\|randomUUID" packages/engine/src` vazio; regra de lint ativa. | CI |
| D-5 | Sem I/O em runtime na biblioteca (SPEC §3.6, CLAUDE.md): nada de rede, disco ou relógio real. O CLI só escreve em stdout/stderr (e em arquivo apenas se uma flag explícita de saída for definida em ADR). | Coberto por CT-3 para a biblioteca; QA revisa os imports do CLI e confirma ausência de `http`, `https`, `net`, `fetch`, `dgram`. | CI + QA |
| **CLI** | | | |
| CLI-1 | `$CLI simulate --seed <s> --ticks <n>` sem `--fault` emite o baseline em NDJSON no stdout e sai com 0; toda linha é JSON válido com um campo discriminador de tipo cujos valores cobrem métrica, log, span e evento (nomes definidos em ADR). | `$CLI simulate --seed s --ticks 10 \| node -e` que parseia cada linha e conta tipos; exit 0. | CI + QA |
| CLI-2 | `--fault <kind>` aceita cada um dos 6 kinds com alvo, `startTick` e params padrão documentados no `--help`; existe sintaxe (definida em ADR) para sobrescrever alvo, `startTick` e params; `--fault` pode ser repetido para falhas simultâneas (F-6). | QA roda os 6 kinds com padrão, 1 com sobrescrita e 1 com duas falhas; todos saem com 0 e passam D-1. | QA |
| CLI-3 | Erros de uso saem com código ≠ 0, mensagem em stderr e nada no stdout: kind inválido (mensagem lista os 6 válidos), `--seed` ausente, `--ticks` não inteiro ou ≤ 0, alvo inexistente. | Um caso de teste/CI por erro, conferindo exit code, stderr não vazio e stdout vazio. | CI |
| CLI-4 | `$CLI --help` e `$CLI simulate --help` listam `--seed`, `--fault`, `--ticks` e os 6 kinds. | `grep` na saída do help. | CI |
| CLI-5 | Desempenho: `$CLI simulate --seed perf --fault <kind> --ticks 360` (1 h de jogo) termina em ≤ 10 s de relógio no runner `ubuntu-latest` do CI, para cada um dos 6 kinds. | Passo de CI com `timeout 10` por kind. | CI |
| **Empacotamento e publicação ("CLI publicado")** | | | |
| PUB-1 | O pacote é empacotável e roda fora do repositório: `pnpm --filter ./packages/engine pack` gera um tarball; num diretório temporário vazio fora do repo, `npm install <tarball>` seguido de `npx <bin> simulate --seed pub --fault connection_pool_exhaustion --ticks 30` sai com 0 e produz saída byte-idêntica à de `$CLI` com os mesmos argumentos no repo, usando Node 22 (`engines` da raiz). | Passo de CI ou script `$ENGINE/scripts/` que faz o roteiro e compara hashes; QA repete localmente. | CI + QA |
| PUB-2 | O tarball contém só o necessário: código compilado, `package.json`, `README.md`, `LICENSE`; sem `test/`, sem fixtures (salvo se a ADR justificar), sem `.ts` de teste. `package.json` do pacote tem `"license": "Apache-2.0"`, campo `bin`, versão SemVer diferente de `0.0.0`, e não é `private`. | `tar -tzf <tarball>`; `node -p` nos campos do `package.json`. | QA |
| PUB-3 | `$ENGINE/README.md` (inglês, CLAUDE.md) documenta instalação, uso do CLI com os 6 kinds, exemplo de biblioteca com `ask()` e explica o que é seed e tick. Todo comando do README roda verbatim e sai com 0. | QA copia e roda cada bloco de comando do README. | QA |
| PUB-4 | **(Bloqueado por B-1.)** O pacote está disponível publicamente no canal decidido pelo Diretor, e a instalação a partir desse canal num diretório vazio roda o roteiro de PUB-1 com a mesma saída. | Roteiro de PUB-1 com a origem do canal publicado no lugar do tarball local. | QA + Diretor |
| **Qualidade e CI** | | | |
| QC-1 | Cobertura ≥ 80% em linhas, branches, funções e statements nos módulos `sim` e `faults` de `$ENGINE` (SPEC §8, §10), imposta por thresholds na config do Vitest: abaixo de 80%, o comando de teste falha. | `pnpm --filter ./packages/engine test -- --coverage` (ou script equivalente) mostra os 4 números ≥ 80 para `sim` e `faults`; QA confere que os thresholds estão na config. | CI + QA |
| QC-2 | O workflow de CI roda, para todo PR: lint, typecheck (CT-2), testes com cobertura (QC-1), D-1, D-2, CLI-3, CLI-4, CLI-5 e PUB-1; qualquer falha deixa o check vermelho. | QA lê `.github/workflows/ci.yml` e confere o último run verde em `main` (`gh run list --branch main`). | QA |
| QC-3 | O check de CI é obrigatório para merge em `main` (SPEC §10 "CI bloqueia merge"). | `gh api repos/jeffersonvalente/Whodeployed/branches/main/protection` mostra o check do CI como `required_status_checks`. | Diretor (configura) + QA (confere) |
| **Gate** | | | |
| G-1 | Pendência herdada do GATE-0: a tabela de dois leitores externos (um júnior, um sênior) em `docs/gates/GATE-0.md` está preenchida antes da aprovação do Gate 1, como o Diretor se comprometeu. | QA confere as duas linhas preenchidas em `GATE-0.md` e registra no `GATE-1.md`. | Diretor + QA |

### Assinaturas de falha (referenciada por F-3)

Medidas na janela de assinatura, com parâmetros padrão, contra o baseline. Os limiares são o mínimo que torna a falha detectável e ensinável; mudar um limiar é PR neste PRD (PM), não decisão do engenheiro. Os nomes dos kinds, exceto `connection_pool_exhaustion`, são definidos na ADR de F-1.

| Linha SPEC §7 | Falha | Assinatura mínima no alvo | Assinatura mínima indireta (também conta para F-4) |
| --- | --- | --- | --- |
| 1 | Serviço crashando em loop | Erro % do alvo ≥ baseline + 20 p.p. **ou** RPS servido ≤ 50% do baseline; ≥ 1 log de nível de erro do alvo em cada tick da janela | Erro % do chamador direto do alvo ≥ baseline + 5 p.p. |
| 2 | Disco cheio no postgres | Logs de nível de erro em `postgres` em cada tick da janela; erro % de `postgres` ≥ baseline + 10 p.p. | Erro % de ≥ 1 serviço que depende de `postgres` ≥ baseline + 5 p.p. ("sintoma longe da causa") |
| 3 | Pool de conexões esgotado (`connection_pool_exhaustion`) | Métrica de conexões do alvo atinge `poolSize` em ≥ 1 tick da janela; p95 do alvo ≥ 3× baseline; nos traces p95 do alvo, um span de espera por conexão responde por ≥ 50% da duração da raiz | p95 de `gateway` sobe ≥ 25%, enquanto o p50 de `gateway` fica ≤ 1,5× baseline (agregado esconde o gargalo) |
| 4 | Deploy ruim em 1 de N instâncias | Evento de deploy com alvo e instância no `startTick`; condições de F-5 | Erro % do serviço agregado sobe (≥ 1 p.p.), mas F-5 vale |
| 5 | Retry storm após dependência lenta | p95 do alvo (dependência lenta) ≥ 3× baseline | Nº de spans filhos de chamadores para o alvo ≥ 2× baseline (retries); o componente com maior aumento absoluto de erro % **não** é o alvo ("o culpado não é quem grita") |
| 7 | Cache frio após restart do redis | Evento de restart/config de `redis` no `startTick` | RPS de `postgres` ≥ 2× baseline nos 3 primeiros ticks após `startTick`, e volta a ≤ 1,2× baseline até `startTick + warmup` (param documentado); p95 de ≥ 1 serviço que usa `redis` sobe ≥ 25% |

## Fora de escopo nesta fase

- **Efeito das `Action`s na simulação** (`restart`, `rollback`, `flagOff`, `scale`, `escalate`, `declareMitigated`). O tipo `Action` entra no contrato (CT-1, SPEC §6 "fixo a partir da fase 1"), mas a semântica de cada ação e o relógio de impacto ficam para o PRD da fase 2. Nenhum critério desta fase exige mitigação.
- **`packages/scenarios`**: schema JSON Schema, loader YAML, validador `validate`, os 8 cenários, `referencePath`, `systems/default-shop` como YAML (SPEC §6, §8 fases 3 e 4). Nesta fase o motor recebe mundo, falhas e noise como objetos TypeScript/JSON; o formato YAML não é critério.
- **Alertas** (`alert.tick`, `alert.text`), `impactBudget`, `teaches`, `trap`, `rootCause` e `review`: são campos de cenário (SPEC §7), conteúdo de fases seguintes. O motor não avalia alertas nesta fase.
- **Revisão pós-incidente** contra caminho de referência (SPEC §5): fase 2/3.
- **Progressão, níveis, regra de ouro aplicada a cenário** (SPEC §5): o motor não tem conceito de nível (Q-1); a validação da regra de ouro por cenário é da fase 3.
- **Texto de NPC, de alerta e de revisão**: conteúdo (SPEC §3.7, §9 Eng. Conteúdo).
- **`apps/web`**, qualquer UI, i18n, GitHub Pages (SPEC §4 Interface; fase 3). Placeholder ou arte: não se aplica.
- **Conceitos fora de SPEC §4**: SLO/SLI, design de alerta, instrumentação ou exportação OTel/OTLP, custo de ingestão, métricas além das 8 de S-1 (ex.: cache hit rate), integrações com Grafana/New Relic/Datadog (SPEC §4 "Fora", §1).
- **Backend, rede, telemetria do jogador** (SPEC §3.6, §4 "Fora").
- **Tradução pt-BR** de README ou help do CLI (SPEC §4: v0.1 em inglês).
- **Tag `v0.1`, changelog de release e divulgação** (SPEC §8 fase 5; papel Release). A versão do pacote só precisa ser SemVer ≠ `0.0.0` (PUB-2).

## Riscos específicos da fase

| Risco (SPEC §11) | Sinal de alerta concreto nesta fase | Mitigação nesta fase |
| --- | --- | --- |
| Motor gera telemetria incoerente | P-1/P-2/P-3 falham para alguma seed; p95 do `trace` diferente do p95 do `dashboard` no mesmo tick (Q-6); script de P-4 diverge do motor; métrica calculada por fórmula própria em vez de derivada dos spans. | P-1 a P-4 no CI; P-4 rodado por QA fora do código do motor. |
| Gamesmanship: jogador decora padrão do jogo | Seeds diferentes produzem a mesma telemetria a menos de ids (S-5 falha); assinatura de falha sempre no mesmo tick e na mesma instância independentemente da seed. | S-5; F-3 exigido sobre ≥ 10 seeds; instância afetada e ruído dependentes da seed. |
| Gating artificial (ferramenta travada) | Parâmetro, flag ou campo de nível em `ask()`, `Question` ou CLI; algum `kind` de `Question` não implementado ou que lança "não suportado". | Q-1 (6 kinds, sem nível, `grep` vazio). |
| Virar curso com pixel art (escopo infla) | PR adicionando métrica, sinal ou exportador fora de SPEC §4 (ex.: SLO, burn rate, OTLP, hit rate) ou ferramenta de UI no motor. | S-1 fixa o conjunto de métricas; "Fora de escopo" acima; QA reprova citando SPEC §3.1/§4. |
| Projeto morre a 70% | Duas semanas sem commit em `packages/engine`; fase passando das 3 semanas de SPEC §8 sem PUB-1 verde. | Tarefas ≤ 1 dia (Arquiteto); PUB-1 permite release útil do motor mesmo se PUB-4 seguir bloqueado. |

## Roteiro de teste com humano

Não obrigatório nesta fase (SPEC §8 só exige sessão com humano na fase 2). Os critérios PUB-3 e G-1 já cobrem a leitura humana necessária: PUB-3 é executado pelo QA seguindo o README verbatim, e G-1 registra os dois leitores do README raiz exigidos pelo GATE-0.

## Bloqueios

| ID | Decisão necessária | Por que é do Diretor | O que bloqueia | O que não bloqueia |
| --- | --- | --- | --- | --- |
| B-1 | Canal de publicação do CLI para cumprir "CLI publicado" (SPEC §8, Gate 1): (a) registry npm público, com nome do pacote e conta dona; (b) tarball anexado a um GitHub Release do repo; (c) outro. | SPEC §8 diz "publicado" e ADR-001 diz "publicável como pacote npm", sem escolher canal, nome ou conta. Publicar em registry externo cria identidade pública e credencial do projeto; não está na lista de decisões delegadas de SPEC §12. | Só PUB-4. | Todos os outros critérios, inclusive PUB-1 a PUB-3. O Arquiteto e o Eng. Motor seguem normalmente; o Gate 1 só pode ser aprovado com PUB-4 resolvido ou com dispensa registrada pelo Diretor em `GATE-1.md`. |
