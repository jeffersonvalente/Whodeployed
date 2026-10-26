# FASE-2 — Protótipo de texto

- **Fase:** 2 — Protótipo de texto (SPEC §8, semana 4)
- **Liberada por:** `docs/gates/GATE-1.md` (aprovado pelo Diretor em 2026-10-26)
- **Autor:** PM
- **Entrada:** SPEC §2, §3, §4, §5, §6, §7, §8, §10, §11; GATE-1 (pendências não bloqueantes 1 a 4); `docs/prd/FASE-1.md` (formato e critérios entregues); issue #24; ADR-002, ADR-004, ADR-006, ADR-009
- **Consumidores:** Arquiteto (`FASE-2.tasks.md`, ADRs), Eng. Motor, Eng. Conteúdo, Eng. UI (PRs), QA (relatório por PR e `GATE-2.md`), Diretor (sessão com júnior e decisão GO/NO-GO)

Convenções deste documento:

- `$ENGINE` = `packages/engine`; `$SCEN` = `packages/scenarios`; `$PROTO` = o pacote do protótipo. O lugar dele (por exemplo `apps/web`) é decisão do Arquiteto em ADR (SPEC §12, decisões delegadas).
- **Cenários da fase** = `01`, `03` e `05` da campanha (SPEC §7 e §8) mais os **incidentes de teste** `TA` e `TB`, inéditos e de dificuldade equivalente (CN-9), usados só no pré-teste e no pós-teste (SPEC §2 e §10; decisão do Diretor no PR #75: pós-teste com segundo incidente inédito). Com 1 testador, `TA` é o pré e `TB` o pós; com mais de um, a ordem é contrabalanceada (TH-5).
- **Sessão** = uma partida de um cenário, do alerta até a revisão.
- **Repertório do nível** = perguntas e ações que SPEC §5 dá ao nível declarado em `level` no YAML. Nesta fase a tabela é esta, sem nada a mais:

  | Nível | Perguntas (`Question`) | Ações (`Action`) |
  | --- | --- | --- |
  | Júnior | `dashboard` de um componente; `logs` de um componente com `window: 30` (os "últimos 5 min" de SPEC §5; ADR-006: 5 min = 30 ticks), sem `filter` | `restart` |
  | Pleno | tudo do Júnior; `logs` com `filter`; `compare` com `by: 'instance'`; `trace` (50/95/99); `whatChanged` | tudo do Júnior; `rollback` |

  O alerta (`alert.text`) é mostrado a todos os níveis no início da sessão e não custa tick. Itens do Sênior (`askNpc`, `compare` com `by: 'lastWeek'`, `flagOff`, `declareMitigated`, `escalate`) e `scale`, que não aparece em nenhum nível de SPEC §5, não fazem parte de nenhum repertório desta fase (ver "Fora de escopo").
- **Impacto** = contador por tick definido em ADR pelo Arquiteto, com as restrições de EN-6. **Orçamento** = `impactBudget` do YAML. **Grave** = impacto acumulado ≥ orçamento.
- **Mitigação eficaz** = ação depois da qual o impacto para de acumular em até 3 ticks e não acumula em nenhum dos 30 ticks seguintes (5 min de jogo), simulados sem outra ação.
- **Hipótese** = par (componente suspeito, texto livre). O componente é escolhido entre os 9 do `default-shop`. A hipótese é **correta** quando o componente é o `target` da falha do cenário. O texto livre não é avaliado pela máquina; fica no log para a revisão humana.
- "Definido em ADR" tem o mesmo sentido da fase 1: a escolha é do Arquiteto, mas tem que existir em `docs/adr/` antes do PR que a implementa, e o QA verifica contra ela.

## Objetivo da fase

Entregar uma página HTML sem estilo onde um júnior joga o loop completo de SPEC §4 (alerta → pedir sinais → hipótese → testar → mitigar e/ou corrigir → revisão) nos cenários 1, 3 e 5, com log de ações exportável, e verificar numa sessão gravada com um júnior se ele aprende algo que não aprenderia lendo (SPEC §8, fase 2; Gate 2 GO/NO-GO).

## Histórias

| # | História | Justificativa no spec |
| --- | --- | --- |
| H1 | Como **jogador júnior**, quero receber um alerta e decidir que pergunta fazer ao sistema, pagando cada pergunta em tempo de incidente, para treinar a escolha do primeiro sinal sob pressão. | SPEC §1 (tese), §2 resultado (2), §5 ("o custo de cada pergunta é tempo") |
| H2 | Como **jogador**, quero anotar hipóteses e descartá-las apontando a resposta que as derrubou, para praticar descartar hipótese com evidência. | SPEC §2 resultado (3); §4 Loop ("anotar hipótese → testar") |
| H3 | Como **jogador**, quero agir (reiniciar, fazer rollback) antes de saber a causa raiz e ver o impacto parar de subir, para aprender que mitigar cedo vale. | SPEC §3.5; §2 resultado (4); §4 ("relógio de impacto") |
| H4 | Como **jogador**, quero ler no fim de cada incidente três frases que comparam o que fiz com um caminho de referência, sem nota, para saber o que foi redundante e qual sinal já tinha a resposta. | SPEC §5 "Revisão pós-incidente (o professor do jogo)"; §4 Loop |
| H5 | Como **jogador**, quero que as respostas venham da simulação do motor com a seed do cenário, para que só raciocínio resolva o incidente e eu não consiga decorar um roteiro. | SPEC §3.3, §11 (gamesmanship) |
| H6 | Como **jogador júnior**, quero resolver os cenários do meu nível só com as perguntas do meu nível, para não travar por falta de ferramenta. | SPEC §3.2, §5 "Regra de ouro", §11 (gating artificial) |
| H7 | Como **Diretor**, quero exportar o log de ações de cada sessão e medir, com um script, os 4 resultados de SPEC §2 no pré-teste e no pós-teste, para decidir o Gate 2 com evidência e não com impressão. | SPEC §8 (Gate 2), §10 ("log de ações exportado pelo jogador") |
| H8 | Como **contribuidor**, quero que os 3 incidentes e os 2 incidentes de teste sejam YAML no formato de SPEC §7, para que o protótipo prove que cenário é dado, não código. | SPEC §3.7, §7 |
| H9 | Como **agente QA**, quero que toda sessão exportada possa ser repetida pelo motor e dê as mesmas respostas, para auditar a sessão do júnior sem confiar na UI. | SPEC §3.3 (determinismo), §9 regra 2 |
| H10 | Como **agente Eng. UI/Conteúdo**, quero que o motor aplique ações e calcule o impacto sem mudar o contrato de SPEC §6 nem a telemetria já verificada no Gate 1, para construir o protótipo sobre a `engine-v0.1.0` sem reabrir a fase 1. | SPEC §6 ("contrato fixo a partir da fase 1"); GATE-1 |

## Critérios de aceite

Legenda de "Quem verifica": **CI** = falha o workflow `.github/workflows/ci.yml` se violado; **QA** = o agente QA roda o comando ou o roteiro e cola a saída no relatório do PR ou do gate; **Diretor** = ação ou registro que só o Diretor faz; **Moderador** = a pessoa que conduz a sessão com o júnior (o Diretor ou alguém indicado por ele em `GATE-2.md`; nunca um engenheiro que escreveu código do protótipo).

| ID | Critério | Como verificar | Quem verifica |
| --- | --- | --- | --- |
| **Motor (regressão e ações)** | | | |
| EN-1 | A fase 1 continua verde: todos os passos de CI do GATE-1 (lint, typecheck, testes com os thresholds de QC-1, `ci-engine.sh`, `pack-smoke.sh`, `pack-artifact.sh`) continuam no `ci.yml` e passam em todo PR da fase. | QA lê o `ci.yml` e confere o último run verde em `main` (`gh run list --branch main`). | CI + QA |
| EN-2 | Sem ação, a telemetria não muda: os 7 arquivos `$ENGINE/fixtures/*.ndjson` ficam byte-idênticos aos de `4fe9dce`, e o teste de regeneração (D-3) passa. | `git diff --exit-code 4fe9dce -- 'packages/engine/fixtures/*.ndjson'`; suíte de fixtures no CI. | CI + QA |
| EN-3 | O contrato de SPEC §6 não muda: a cópia literal de SPEC §6 no teste de tipo de CT-1 continua igual e passando. Acréscimos (ex.: método para aplicar `Action`) ficam fora dos tipos `World`, `Fault`, `Question`, `Answer` e `Action`. | `git diff 4fe9dce -- packages/engine/test/contract.types.test.ts` não toca a cópia do spec; CT-1 verde. | CI + QA |
| EN-4 | O motor aplica `Action` de `kind` `restart` e `rollback` a uma simulação em andamento. O custo em ticks de cada ação (inteiro ≥ 1) está numa tabela em ADR. Mesma seed e mesma sequência de perguntas e ações nos mesmos ticks dão telemetria byte-idêntica em dois processos. | Teste de biblioteca com 2 execuções em processos separados (mesmo padrão de D-1) para cada ação × cada um dos 6 kinds; hash SHA-256 igual. | CI |
| EN-5 | O efeito de `restart` e de `rollback` está definido em ADR para cada um dos 6 kinds, quando aplicado ao `target` da falha e quando aplicado a outro componente. O efeito vem do estado da simulação, não do cenário: o motor não recebe `referencePath`, `rootCause`, `trap` nem `teaches`. Um `kind` de `Action` sem semântica nesta fase gera `EngineError` tipado, documentado na ADR, sem parâmetro de nível. | Um teste por célula da tabela da ADR (2 ações × 6 kinds × {alvo, outro componente}), com ≥ 10 seeds (R1 da fase 1); `grep -rniE "referencePath\|rootCause\|teaches\|trap" packages/engine/src` vazio; `grep -rniE "junior\|pleno\|senior\|playerLevel" packages/engine/src` vazio (Q-1). | CI + QA |
| EN-6 | O impacto é uma função pura da telemetria gerada, definida em ADR, sem conhecer cenário (SPEC §3.3). (a) No baseline, em 10 seeds × 360 ticks, acumula em ≤ 1% dos ticks. (b) Em cada um dos 5 YAML da fase, com a seed do YAML e sem nenhuma ação, o impacto acumulado chega ao `impactBudget` até o tick `alert.tick + 2 × impactBudget`. (c) Eventos de `noise` sozinhos não acumulam impacto. | Teste de biblioteca para (a), (b) e (c). | CI |
| EN-7 | Coerência com ações: P-1, P-2 e P-3 da fase 1 valem também em execuções com ações aplicadas. | O teste de propriedade da fase 1 é estendido a ≥ 10 seeds × 6 kinds × {`restart`, `rollback`} no alvo, aplicadas no tick `startTick + 6`, por 30 ticks. | CI |
| EN-8 | Cobertura ≥ 80% em linhas, branches, funções e statements nos módulos novos de ações e impacto, imposta por thresholds na config do Vitest, como em QC-1. D-4 (sem `Math.random`, `Date.now` etc. em `$ENGINE/src`) continua valendo. | Saída de cobertura; grep de D-4 vazio. | CI + QA |
| **Cenários (YAML)** | | | |
| CN-1 | `$SCEN/scenarios/` contém 5 YAML no formato de SPEC §7: `01-*` (`service_crash_loop`, `level: junior`), `03-*` (`connection_pool_exhaustion`, `level: junior`), `05-*` (`slow_dependency`, `level: pleno`) e os incidentes de teste `TA` e `TB`. Cada um tem todos os campos obrigatórios de SPEC §7 e também `impactBudget` e `review` (`redundant`, `keySignal`), que a fase usa para o relógio e a revisão. Os `teaches` são distintos e correspondem à coluna "Ensina" de SPEC §7 (linhas 1, 3 e 5). | Teste do loader sobre os 5 arquivos; QA confere os `teaches` contra SPEC §7. | CI + QA |
| CN-2 | Cada YAML da fase tem exatamente 1 falha, com `target`, `startTick` e `params` explícitos. Nenhum depende do default do catálogo (ADR-004). | Teste do loader. | CI |
| CN-3 | Incidentes de teste `TA` e `TB`, inéditos e fora da campanha. Para cada um: `id` fora de `01..08` e com prefixo `test-`; `kind` fora de {`service_crash_loop`, `connection_pool_exhaustion`, `slow_dependency`} (os kinds de `01`, `03`, `05`), para não medir memória dos cenários jogados; `seed`, `title` e `alert.text` diferentes dos de `01`, `03`, `05` e diferentes entre si; `noise` próprio, com ≥ 1 evento, e a lista `noise` (comparada como lista de `{kind, target, tick}`) diferente entre `TA` e `TB` e diferente da de cada um de `01`, `03`, `05` (decisão do Diretor no PR #75: seed e noise distintos); `TA` e `TB` diferem entre si em `kind` ou em `target` (não são o mesmo incidente); `level: pleno`; ≥ 1 evento de deploy/config com tick em `[alert.tick − 30, alert.tick]`, para que "o que mudou?" tenha resposta; `referencePath` com mitigação eficaz antes de 50% do `impactBudget`. Nenhum dos dois aparece na lista de cenários do protótipo: só abrem pelo modo de teste documentado (PR-4). | Teste do loader (compara `seed`, `noise`, `title`, `alert.text`, `kind` e `target` entre os 5 YAML) e teste de replay do `referencePath`; QA confere a lista do protótipo. | CI + QA |
| CN-4 | O loader de `$SCEN` lê YAML e devolve objetos tipados. Campo obrigatório ausente gera erro que cita o arquivo e o campo. `kind`, `target` ou parâmetro inválido propaga a mensagem do `EngineError` do motor (F-7). O `schema.json` e o comando `validate` no CI ficam para a fase 4 (ver "Fora de escopo"). | Teste por caso de erro. | CI |
| CN-5 | Regra de ouro (SPEC §5): o `referencePath` de cada YAML usa só itens do repertório do seu `level`. Repetido no motor com a seed do YAML, a partir de `alert.tick`, ele produz mitigação eficaz com impacto acumulado < `impactBudget`. | Teste de replay por cenário contra a tabela de repertório. | CI |
| CN-6 | O alerta não chega antes do sintoma: `alert.tick ≥ startTick` e, no `alert.tick`, a condição citada em `alert.text` vale na telemetria da seed do YAML (asserção escrita pelo Eng. Conteúdo, uma por cenário). No `03`, além disso, as conexões do alvo estão em `poolSize` no `alert.tick`, e o alvo serve ≥ 1 request em cada tick da janela de assinatura (seed exercitada, R6 da fase 1; nota do GATE-1 para o Eng. Conteúdo). | Teste por cenário. | CI |
| CN-7 | O engano existe (SPEC §3.4): cada YAML tem um teste que afirma a condição do `trap` na telemetria da sua seed, no `alert.tick`. Exemplos: no `03`, p50 do `gateway` ≤ 1,5× o baseline enquanto o p95 do alvo ≥ 3×; no `05`, o componente com maior aumento de erro % não é o alvo. | Teste por cenário. | CI |
| CN-8 | Cenário não está no código (SPEC §3.7): nenhum `id`, `title`, `alert.text`, `rootCause` ou `teaches` dos 5 YAML aparece em `$ENGINE/src` nem em `$PROTO/src`. | Script de CI que lê os 5 YAML e faz `grep -F` de cada string nas duas árvores; saída vazia. | CI |
| CN-9 | Equivalência de dificuldade entre `TA` e `TB` (definida pelo PM; decisão do Diretor no PR #75). Todos os itens valem: (a) mesmo `level` (`pleno`) e exatamente 1 falha; (b) mesmo `impactBudget`; (c) `referencePath` com o mesmo número de passos e a mesma contagem por tipo (quantos `whatChanged`, quantas perguntas de sinal, quantas ações) e o mesmo `kind` de ação de mitigação; (d) mesmo número de eventos de `noise`; (e) o componente citado em `alert.text` é o `target` nos dois ou não é o `target` nos dois (o engano tem o mesmo papel); (f) repetido no motor com a seed do YAML, o impacto acumulado no momento da mitigação do `referencePath` difere ≤ 20% entre `TA` e `TB`, e é < 50% do `impactBudget` nos dois; (g) o tamanho do conjunto S de R-2 é igual nos dois. | Teste que carrega `TA` e `TB`, confere (a)–(e) e (g) nos campos e (f) por replay. | CI |
| **Protótipo** | | | |
| PR-1 | `$PROTO` gera um build estático (HTML + JS) com o comando documentado, com exit 0 e **0 warnings** (SPEC §10). O build abre em qualquer servidor estático sem backend. | Passo de CI; QA serve o build com um servidor estático qualquer e abre no navegador. | CI + QA |
| PR-2 | Sem estilo e sem arte (SPEC §8, "HTML sem estilo"; CLAUDE.md): nenhum arquivo `.css`, nenhum `<style`, nenhum atributo ou prop `style`, nenhuma biblioteca de CSS-in-JS, nenhum `<canvas>` ou `<svg>` em `$PROTO/src`. A página usa só a renderização padrão do navegador: texto, listas, tabelas, `<pre>`, botões e campos de formulário. | `grep -rnE "\.css\|<style\|style=\|style:\|<canvas\|<svg" $PROTO/src` vazio; QA confere as dependências do `package.json` de `$PROTO`. | CI + QA |
| PR-3 | Sem rede, sem backend, sem telemetria do jogador (SPEC §3.6): nenhum `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` ou `sendBeacon` em `$PROTO/src`. Com a rede desligada depois do carregamento, o cenário `01` é jogável do alerta à revisão e ao export. | `grep` vazio no CI; QA joga o `01` com o DevTools em *Offline* e confere 0 requisições depois do carregamento. | CI + QA |
| PR-4 | A tela inicial lista exatamente `01`, `03` e `05` (título e nível). Os incidentes de teste `TA` e `TB` só abrem pelo modo de teste documentado no README de `$PROTO`, nunca pela lista. | Teste de componente; QA confere. | CI + QA |
| PR-5 | Início da sessão: a simulação é avançada até `alert.tick` antes de o jogador ver qualquer coisa. A página mostra o texto do alerta, o tick atual, o impacto acumulado e o orçamento (como texto, ex.: `impact 4 / 60`) e a lista dos 9 componentes. Nenhum sinal aparece sem ser pedido. | Teste de componente sobre o DOM inicial dos 5 cenários. | CI |
| PR-6 | Repertório: a sessão oferece exatamente os itens do repertório do `level` do cenário (tabela das Convenções). Itens fora do repertório não aparecem: nem desabilitados, nem com aviso de "desbloqueia no nível X". Para Júnior, `logs` usa `window: 30` fixo e não oferece filtro. A tabela de repertório é dado num único lugar (definido em ADR), fora de `$ENGINE`. | Teste de componente por nível, comparando controles com a tabela; `grep` de Q-1 em `$ENGINE/src` continua vazio. | CI |
| PR-7 | Respostas em texto: cada `Answer` aparece com o tick em que foi pedido e o `tickCost`, e com todos os valores de `Answer.data`. `dashboard` e `compare` viram tabela métrica × tick ou instância × tick; `logs`, uma linha por entrada; `trace`, a árvore indentada com componente, operação, duração e status de cada span; `whatChanged`, uma lista de eventos. Os valores mostrados são iguais aos de `Answer.data`. | Teste de componente que compara o texto renderizado com `Answer.data` para cada `kind` do repertório Pleno. | CI |
| PR-8 | Relógio: o tick avança exatamente o `tickCost` de cada pergunta (ADR-006) e o custo de cada ação (EN-4). Há um controle "wait" que avança 1 tick. Anotar, descartar e ler não custam tick. O impacto é recalculado a cada passo. Quando o impacto acumulado ≥ orçamento, a página mostra o estado `SEVERE` em texto. A sessão termina sozinha no tick 360. | Teste com sequência fixa de passos, conferindo tick e impacto depois de cada um. | CI |
| PR-9 | Caderno: o jogador registra hipóteses (componente entre os 9 + texto livre não vazio) e descarta uma hipótese citando ≥ 1 resposta anterior (pelo número de sequência no log), com texto opcional. Descartar sem citar resposta não é possível. Tudo entra no log. | Teste de componente. | CI |
| PR-10 | Fim: o jogador encerra o incidente escolhendo a hipótese final (uma ativa, uma nova ou "unknown"). Depois disso só a revisão e o export ficam disponíveis. | Teste de componente. | CI |
| PR-11 | Revisão (SPEC §5): exatamente 3 frases geradas do log contra o `referencePath` e o bloco `review` do YAML. (1) Perguntas redundantes: repetidas de forma idêntica ou listadas em `review.redundant`, ou a frase "no redundant questions". (2) O sinal-chave (`review.keySignal`): se o jogador pediu a pergunta que o continha e em que tick. (3) Impacto acumulado na mitigação eficaz do jogador (ou no fim, se não houve) contra o impacto do `referencePath` repetido. Sem nota, estrela, porcentagem de acerto ou ranking. O `referencePath` e o `rootCause` não aparecem em lugar nenhum antes da revisão. | Teste de componente: o DOM antes do fim não contém o texto dessas listas; depois do fim, 3 frases; teste com log sintético para cada ramo das 3 frases. | CI |
| PR-12 | Determinismo da sessão: mesmo cenário e mesma sequência de entradas dão as mesmas respostas, o mesmo impacto em cada passo e as mesmas 3 frases de revisão. | Teste que joga duas vezes a mesma sequência e compara o log exportado, sem os tempos de relógio de parede. | CI |
| PR-13 | Log exportável (SPEC §8, §10): a qualquer momento e depois do fim, o jogador baixa um arquivo JSON e pode copiá-lo para a área de transferência, sem rede. O formato está em ADR, com número de versão, e traz: `id` e seed do cenário; versão do pacote do motor e SHA do commit do build; cada passo (sequência, tick antes, tipo, payload da pergunta/ação/hipótese/descarte/wait, `tickCost`, impacto depois, ms de relógio de parede desde o início da sessão); hipótese final; as 3 frases da revisão. Não traz nome, identificador do jogador, data absoluta nem user agent. | Teste de formato sobre logs gerados no teste de PR-12; QA exporta um log no navegador e confere os campos. | CI + QA |
| PR-14 | Replay: um script Node (lugar definido em ADR) lê um log exportado e o YAML do cenário, repete os passos no motor e confere cada resposta e cada valor de impacto. Sai com 0 se tudo bate e com ≠ 0 apontando o primeiro passo divergente se não bate. A igualdade de perguntas é feita sobre o JSON canônico (ver I24-6). | CI roda o script sobre 5 logs de fixture (o `referencePath` de cada YAML jogado pela UI) e sobre 1 log adulterado (tem que falhar); QA roda sobre os logs da sessão (TH-2). | CI + QA |
| PR-15 | Script de resultados: lê o log do pré-teste e o do pós-teste (um de `TA`, outro de `TB`, em qualquer ordem; o script lê o `id` de cada log e recusa com exit ≠ 0 se os dois forem do mesmo incidente ou de um cenário que não seja de teste) e imprime, para cada um dos 4 resultados de SPEC §2 (definições R-1 a R-4 no Roteiro), `pre`/`post` (verdadeiro/falso) e se mudou de falso para verdadeiro. Imprime também, informativo, o número de perguntas de sinal até a primeira hipótese correta (métrica de SPEC §10). | Testes unitários com logs sintéticos que ligam e desligam cada um dos 4 resultados. | CI |
| PR-16 | Persistência local (CLAUDE.md, estado em `localStorage`): os logs de sessões encerradas ficam em `localStorage` e podem ser exportados depois de recarregar a página. Um controle apaga todos. Se o `localStorage` não estiver disponível, o jogo funciona e o export do fim da sessão continua disponível. | Teste com `localStorage` funcionando e com `localStorage` que lança erro; QA recarrega a página e exporta. | CI + QA |
| PR-17 | Desempenho: o replay (PR-14) de uma sessão de 360 ticks com 40 perguntas termina em ≤ 5 s no runner `ubuntu-latest`. No navegador, entre clicar numa pergunta `dashboard` no tick 300 e a resposta aparecer passam ≤ 1 s, medido pelo QA, que registra no relatório a máquina e o navegador. | Passo de CI com `timeout 5`; medição manual do QA com o painel Performance. | CI + QA |
| PR-18 | Texto da interface: strings em inglês (SPEC §4; CLAUDE.md). A interface só tem rótulos de controle, o alerta, as respostas, o caderno, o estado do relógio e as 3 frases da revisão. Nenhum tutorial, dica ou texto que explique as 4 práticas de SPEC §2: isso contaminaria o Gate 2 ("não aprenderia lendo"). | QA percorre as telas dos 5 cenários e lista todo texto fora dessas categorias (lista vazia). | QA |
| PR-19 | Fronteiras (SPEC §6): `$PROTO` importa motor e cenários só pelos pontos de entrada públicos dos pacotes e não importa biblioteca de YAML ("a UI não conhece YAML"). `$ENGINE` continua sem importar `$SCEN` nem `$PROTO` (CT-3). | Regra de lint ou teste de imports, como na ADR-008. | CI |
| PR-20 | O README de `$PROTO` (inglês) documenta build, como servir, modo de teste, export do log, replay (PR-14) e script de resultados (PR-15). Todo comando do README roda verbatim e sai com 0. | QA copia e roda cada bloco de comando. | QA |
| PR-21 | Algo no ar nesta fase (SPEC §3.8): todo push em `main` que passa no CI anexa o build estático de `$PROTO` como artifact do workflow `whodeployed-prototype`, no repositório público. O README de `$PROTO` diz como baixar e servir esse build. O deploy em GitHub Pages fica para a fase 3 (SPEC §8). | QA baixa o artifact do último run verde de `main` (`gh run download`), serve com um servidor estático e joga o `01`. | CI + QA |
| **Issue #24 e pendências do GATE-1** (posição completa na subseção abaixo) | | | |
| I24-1 | A lista pública de `$ENGINE/src/index.ts` (nomes de runtime e de tipo) está registrada na ADR-002 §2, incluindo o que a fase 2 acrescentar (EN-4, EN-6). Um teste compara as exportações de runtime de `index.ts` com a lista. | Teste; QA confere a ADR. | CI + QA |
| I24-2 | A ADR-002 registra que `createSimulation` revalida `faults` (o loader da fase 2 depende disso para dar F-7 a quem usa YAML), e o comentário de `SimulationConfig.faults` em `types.ts` diz o mesmo. | QA lê a ADR e o comentário. | QA |
| I24-3 | O limite de ticks da biblioteca (`advance`: `0..100000`; `simulate`: `1..100000`; código `invalid_ticks`) está registrado na ADR-002. | QA lê a ADR. | QA |
| I24-4 | O ciclo ESM `ask.ts` ↔ `sim/simulation.ts` tem decisão registrada em ADR: remover o ciclo ou fixar a regra "sem uso de nível de módulo". O motor carrega no bundle de navegador de `$PROTO` (PR-1 e PR-3 passam). | QA lê a ADR; PR-1/PR-3. | QA |
| I24-5 | A ADR-006 §Validação registra os códigos de `by` inválido (`invalid_question`), `filter: null` (`invalid_filter`), `filter: undefined` (sem filtro) e chave fora do contrato do kind (`invalid_question`, `field = question.<chave>`), que o protótipo usa para mostrar erro de pergunta. | QA lê a ADR. | QA |
| I24-6 | Decidido neste PRD: "igualdade profunda" de Q-2 é igualdade do JSON canônico. Chave com valor `undefined` equivale a chave ausente. O replay (PR-14) compara perguntas assim. | Coberto por PR-14. | CI |
| I24-7 | A issue #24 está fechada antes do Gate 2. Cada item está marcado como feito, com o PR, ou marcado "fora — FASE-2.md" com o motivo desta tabela. | `gh issue view 24` no relatório do gate. | QA |
| **Teste com humano (Gate 2)** | | | |
| TH-1 | Antes da sessão com o júnior, um ensaio completo do roteiro (pessoa qualquer que não seja o júnior) com o mesmo build. O ensaio confere tempos, export dos 5 logs e replay, e confere que o Anexo A tem ≤ 1 página (TH-6). O resultado fica na nota de pesquisa. | Seção "Ensaio" em `docs/research/FASE-2-sessao-01.md`. | Moderador + QA |
| TH-2 | Sessão com 1 júnior do perfil do Roteiro, conduzida exatamente pelo Roteiro desta fase, gravada (tela e áudio) com consentimento escrito. A gravação fica fora do repositório, com o Diretor, e o `GATE-2.md` registra que ela existe e a data. A nota anonimizada `docs/research/FASE-2-sessao-01.md` traz todos os campos do formulário do Roteiro. Os 5 logs (pré, `01`, `03`, `05`, pós) estão em `docs/research/fase-2/` e passam no replay (PR-14). | QA roda PR-14 nos 5 logs e confere a nota; Diretor confirma a gravação no `GATE-2.md`. | QA + Diretor |
| TH-3 | Critério do Gate 2 (SPEC §8): a saída do script de resultados (PR-15) sobre `pre.json` e `post.json` mostra ≥ 1 dos 4 resultados mudando de falso para verdadeiro. A saída é colada no `GATE-2.md`. A decisão GO/NO-GO é do Diretor, que lê também as respostas da entrevista (pergunta 5 do Roteiro, "o que o texto não te disse"). | Script sobre os logs versionados. | QA (mede) + Diretor (decide) |
| TH-4 | A sessão é válida só se o moderador não deu dica sobre as 4 práticas. Toda intervenção fica na nota com o minuto da gravação e a frase dita. Uma intervenção fora das frases permitidas pelo Roteiro invalida a sessão, e é preciso outra sessão com outro júnior. | QA confere a lista de intervenções na nota. | QA |
| TH-5 | Contrabalanceamento da ordem pré/pós (decisão do Diretor no PR #75): com 1 testador, pré = `TA` e pós = `TB`. Com mais de um, o testador de número ímpar (1, 3, …) faz `TA` → `TB` e o de número par faz `TB` → `TA`, e o número de cada um em cada ordem difere no máximo de 1. A ordem usada fica na nota de pesquisa de cada sessão e bate com o `id` dos logs `pre.json` e `post.json`. | QA confere a nota contra os `id` dos logs. | QA |
| TH-6 | Leitura de controle (decisão do Diretor no PR #75): o texto do Anexo A trata de investigação de incidentes e cabe em 1 página, ou seja, ≤ 400 palavras. Ele não cita nenhum componente, falha ou sinal de `TA`, `TB`, `01`, `03` ou `05`. | `wc -w` do bloco do Anexo A; QA confere a ausência de nomes contra os 5 YAML. | QA |

### Dependências do motor (o que a fase 2 consome da `engine-v0.1.0`)

A fase 2 consome o motor pelo workspace do monorepo, a partir de `main` em `4fe9dce` ou depois (o commit verificado no GATE-1). A tag `engine-v0.1.0` e o GitHub Release são do agente Release (ADR-009) e **não** são pré-requisito desta fase. O log de ações (PR-13) registra a versão do pacote e o SHA do build, então uma sessão continua rastreável antes e depois da tag.

| Consumido como está | Para quê na fase 2 |
| --- | --- |
| `createSimulation`, `Simulation.advance`, `Simulation.ask`, `Simulation.telemetry`, `Simulation.world` | Rodar a sessão e responder perguntas (PR-5, PR-7, PR-8) |
| Tipos `Question`, `Answer`, `Signal` e os `*Signal` de ADR-006; tabela de `tickCost` da ADR-006 | Renderizar respostas e avançar o relógio (PR-7, PR-8) |
| `faultCatalog`, `faultKinds`, `resolveFaults`, `EngineError`, `isEngineError` | Loader de YAML e mensagens de erro (CN-4) |
| `defaultShop` | `system: default-shop` dos 5 YAML |
| `serializeRecord`, `toNdjson` | Hash de telemetria no replay e no teste de determinismo (EN-4, PR-14) |

| Novo no motor nesta fase | Critério |
| --- | --- |
| Aplicar `Action` (`restart`, `rollback`) com custo em ticks | EN-4, EN-5, EN-7 |
| Função de impacto sobre a telemetria | EN-6 |
| Registro da API pública e decisões pendentes da #24 | I24-1 a I24-5 |

Não consumidos nesta fase: o CLI (`simulate`), `askNpc` e `compare` com `by: 'lastWeek'` (repertório Sênior). Nenhum critério desta fase muda a telemetria sem ação (EN-2), então a fase 2 não reabre nenhum critério do GATE-1.

### Issue #24 e pendências não bloqueantes do GATE-1: posição da fase 2

Ordem do Diretor: incluir a #24 no escopo ou marcá-la explicitamente como fora. Posição item a item (itens ainda sem marcação de decidido, na lista do GATE-1, pendência 1):

| # | Item da #24 | Posição | Justificativa |
| --- | --- | --- | --- |
| 1 | Lista pública de `index.ts` na ADR-002 §2 | **Dentro** (I24-1) | A fase 2 acrescenta API ao motor (EN-4, EN-6), e a lista vira contrato SemVer com a tag `engine-v0.1.0`. Ela tem que estar escrita antes da primeira mudança. |
| 2 | `createSimulation` revalida `faults` | **Dentro**, só registro (I24-2) | A fase 2 é o primeiro caminho em que `faults` vêm de um arquivo de terceiro (YAML) direto para `createSimulation`. O comportamento atual (F-7 também na biblioteca) é o desejado e precisa estar escrito. |
| 3 | Limite de `ticks` sem ADR | **Dentro**, só registro (I24-3) | O protótipo avança a simulação no navegador. O limite da biblioteca é o teto da sessão (PR-8 usa 360). |
| 4 | `ctx` compartilhado entre falhas compostas | **Fora** | Só importa com ≥ 2 falhas simultâneas (cenário 8, fase 3). CN-2 fixa 1 falha por YAML nesta fase. Exceção: se a ADR de ações implementar ações por hooks que leem ou escrevem `ctx`, a decisão entra na mesma ADR. |
| 5 | Ciclo ESM `ask.ts` ↔ `sim/simulation.ts` | **Dentro** (I24-4) | A fase 2 é a primeira a empacotar o motor num bundle de navegador. Um TDZ quebraria em runtime, não em teste. |
| 6 | Códigos de erro de `by`/`filter`/chave extra na ADR-006 | **Dentro**, só registro (I24-5) | O protótipo traduz `EngineError` em mensagem para o jogador e precisa da lista fechada. |
| 7 | Igualdade de `Answer.question` com `filter: undefined` | **Dentro, decidido aqui** (I24-6) | É leitura de critério do PRD (Q-2), portanto do PM. O replay de log (PR-14) depende dela. JSON canônico, `undefined` ≡ ausente. Sem mudança de código no motor. |
| 8 | `--ticks` alto estoura a memória (100 000 ticks: exit 134) | **Fora** | O protótipo não usa o CLI, e nenhuma sessão passa de 360 ticks. O item fica com o Arquiteto. Recomendação do PM: resolver antes da tag `engine-v0.1.0`, porque o `--help` publicado promete `1..100000`. |
| 9 | Texto da ADR-004 sobre o sinal do `cache_cold_start` citando p95 | **Já resolvido** | A ADR-004 Emenda 2/3 já diz "**p50** de quem usa a cache" (§Semântica e Emenda 3 item 4). Falta só marcar na issue (I24-7). |
| 10 | Default de `bad_deploy` no `gateway` a confirmar | **Fora** | O cenário 4 é da fase 3. CN-2 obriga `target` explícito nos YAML desta fase, então nenhum cenário da fase 2 depende desse default, nem os incidentes de teste se usarem `bad_deploy`. |
| — | "(PM) Redação de D-3" | **Já resolvido** | FASE-1 Emenda 1, item 2. Falta marcar na issue (I24-7). |
| — | "Arquivos tocados" da T1.17–T1.22 (`test/catalog.test.ts`) | **Fora** | Rastreabilidade de tarefas da fase 1, que está encerrada. Sem critério de produto. |

Outras pendências não bloqueantes do GATE-1:

- **Risco do `askNpc` no baseline (pendência 2): fora da fase 2.** `askNpc` é repertório Sênior (SPEC §5), e nenhum cenário desta fase é Sênior. A pergunta não é oferecida, então o risco não se manifesta no Gate 2. Ele passa para o PRD da fase 3 com os dados já medidos (45/50, 49/50 e 50/50 seeds com hint no baseline, `tickCost` 3), antes do cenário 7 (que ensina "usar NPC").
- **Ingress sem jitter (pendência 3; ADR-002 Emenda 1 §5.1): fora da fase 2, decisão do PM.** O ingress continua exato. Motivos: (a) a ADR-002 diz que jitter exige emenda e regeneração de fixtures, o que quebraria EN-2 e reabriria as assinaturas F-3/F-4 aprovadas no GATE-1, numa fase de 1 semana; (b) o risco de SPEC §11 (gamesmanship) cresce com o número de partidas, e o Gate 2 tem 1 jogador e 5 sessões; (c) nenhum dos 4 resultados de SPEC §2 depende de variação do RPS do `gateway`. O sinal de alerta concreto fica em "Riscos": se o júnior usar a linha reta do RPS como pista para decidir, a nota de pesquisa registra, e o PRD da fase 3 decide junto com a variação de seed e de noise por partida (SPEC §11).
- **Notas para o Eng. Conteúdo sobre os cenários 3 e 8 (pendência 4).** A parte do cenário 3 entra nesta fase em CN-6: seed com alvo exercitado na janela, e pool esgotado no `alert.tick`. O exemplo de SPEC §7 (`leakPerTick: 2`, alerta no tick 18) só esgota o pool no tick 21, então o YAML `03` não pode copiá-lo sem ajustar `leakPerTick`, `startTick` ou `alert.tick`. O cenário 8 é da fase 3.
- **Nome do artifact de CI (pendência 6) e versão do pacote × tag (divergência 2): fora.** São do Arquiteto e do Release. Nenhum critério desta fase depende deles.

### Decisões registradas no PR #75

**Decisão do Diretor (textual, no PR #75):** "aprovado o desenho com leitura de controle: texto de ≤ 1 página sobre investigação de incidentes → pré-teste com incidente inédito → campanha com os cenários 1, 3 e 5 → pós-teste com segundo incidente inédito de dificuldade equivalente ao primeiro. Os dois incidentes de teste não podem reaparecer na campanha, e a ordem pré/pós deve ser contrabalanceada entre testadores quando houver mais de um." Aplicada em CN-1, CN-3, CN-9, PR-4, PR-15, TH-5, TH-6 e no Roteiro. SPEC §2 e §10 foram emendadas para este desenho pela ADR-011 (SPEC v1.1; PR #78, aprovado pelo Diretor): "pré e pós-teste com dois incidentes inéditos de dificuldade equivalente, ausentes da campanha, gerados a partir de FaultKinds existentes com seed e noise próprios; ordem contrabalanceada entre testadores quando houver mais de um". Este PRD segue a SPEC v1.1.

**Decisões delegadas do PM** (pontos levantados no PR #75; nenhum é item de SPEC §12):

1. **`scale` fora dos níveis de SPEC §5** (justificativa: SPEC §5, tabela de níveis; §6, `Action`; §7, exemplo de `referencePath`). Na fase 2, `scale` não é oferecido em nenhum repertório, e nenhum `referencePath` desta fase o usa (CN-5). Isso é escopo de fase, do PM. Fica registrado para o PRD da fase 3: se algum cenário precisar de `scale`, o nível dele é mudança de SPEC §5, portanto do Diretor.
2. **`_TEMPLATE.yaml` com `declareMitigated` num exemplo `junior`** (justificativa: SPEC §5, Sênior "declarar mitigação sem root cause"; §3.7; §9, Eng. Conteúdo dono dos cenários). SPEC §5 prevalece: os YAML desta fase passam em CN-5 e não usam `declareMitigated`. A correção do template (trocar o exemplo por item do repertório Júnior) vira tarefa do Eng. Conteúdo, que o Arquiteto inclui em `FASE-2.tasks.md`.
3. **Princípio 8 sem GitHub Pages na fase 2** (justificativa: SPEC §3.8, "cada fase termina com algo no ar"; §8, Pages é entregável da fase 3; §3.6). "No ar" nesta fase é o build estático do protótipo publicado como artifact de CI em todo push verde em `main` no repositório público (PR-21). O repositório também traz a nota de pesquisa e os logs. O deploy em Pages continua na fase 3.

## Fora de escopo nesta fase

- **Mapa de serviços, gráficos, painel visual, CSS, arte, animação** (SPEC §4 Interface e "Fora"; §8 fase 3; CLAUDE.md "placeholder geométrico até v0.3"). A escolha Canvas/SVG × Phaser (SPEC §12, aberta) é da fase 3 e não é necessária aqui (PR-2 proíbe `<canvas>` e `<svg>`). Caderno, relógio e revisão existem nesta fase só como texto, porque fazem parte do loop de SPEC §4 que o Gate 2 julga. As versões de interface deles são entregáveis da fase 3.
- **Cenários 2, 4, 6, 7 e 8**, e a campanha de 8 (SPEC §8 fase 3).
- **Progressão entre cenários** (SPEC §5 "Como sobe"): subir de nível, salvar progresso de campanha, contar hipóteses erradas para promover. Nesta fase o repertório vem do `level` fixo do cenário.
- **Repertório Sênior e `scale`:** `askNpc`, `compare` com `by: 'lastWeek'`, `flagOff`, `declareMitigated`, `escalate`; `scale`, que não está em nenhum nível de SPEC §5. Texto de NPC (SPEC §3.7, fase 3). O `_TEMPLATE.yaml` atual usa `declareMitigated` num exemplo `junior`. Nesta fase vale SPEC §5 (CN-5), e o template é corrigido pelo Eng. Conteúdo (ver "Decisões registradas no PR #75").
- **Variação de seed e de noise por partida** (mitigação de SPEC §11): nesta fase cada cenário roda com a `seed` do YAML, para que a sessão do Gate 2 seja reproduzível (PR-14). **Jitter no ingress** (decisão acima).
- **Falhas simultâneas** (cenário 8) e a decisão sobre `ctx` (#24 item 4).
- **`schema.json`, comando `validate` em CI, CONTRIBUTING completo, templates de issue/PR, issues `good first scenario`** (SPEC §8 fase 4). CN-4 exige só o erro legível do loader.
- **GitHub Pages, largura de 390 px, Lighthouse a11y ≥ 90, arquivo de strings i18n** (SPEC §8 fase 3; §9 Eng. UI). **Tradução pt-BR** da interface (SPEC §4: v0.2).
- **Backend, contas, leaderboard, telemetria automática do jogador** (SPEC §3.6, §4 "Fora", §10: export é voluntário).
- **SLO/SLI, design de alerta, OTel, FinOps, integrações com Grafana/New Relic/Datadog** (SPEC §4 "Fora").
- **Tag `engine-v0.1.0` e GitHub Release do motor** (ADR-009, agente Release, depois do GATE-1); **tag `v0.1`, post, GIF, divulgação** (SPEC §8 fase 5); **5 jogadores externos** (SPEC §8 fase 5, §10).
- **Itens da #24 marcados "Fora"** na tabela acima (4, 8, 10, arquivos tocados).

## Riscos específicos da fase

| Risco (SPEC §11) | Sinal de alerta concreto nesta fase | Mitigação nesta fase |
| --- | --- | --- |
| Virar curso com pixel art (escopo infla) | PR que acrescenta à interface texto explicativo, tutorial, dica ou glossário; PR que acrescenta pergunta, ação ou métrica fora do repertório e de SPEC §4. | PR-18 (nenhum texto que ensine as 4 práticas); PR-6 (repertório fechado); QA reprova citando SPEC §3.1. |
| Gamesmanship: jogador decora padrão do jogo | Na sessão, o júnior faz a mesma sequência das 3 primeiras perguntas (mesmos `kind`, mesma ordem) nos cenários `01`, `03`, `05` e no pós-teste; ou diz em voz alta que decide pela forma da linha do RPS ("a linha reta mudou") ou por "da última vez foi X". | CN-3 (incidentes de teste com `kind` não jogado e distintos da campanha); CN-9 (pré e pós em incidentes diferentes de dificuldade equivalente); campo próprio na nota de pesquisa; a decisão sobre jitter e variação de seed vai para o PRD da fase 3 com essa evidência. |
| Motor gera telemetria incoerente | Depois de uma ação, um sinal mostra recuperação e outro não (ex.: `dashboard` normaliza e `logs` seguem com `process exited`); impacto acumulando com as métricas do `gateway` no baseline. | EN-7 (P-1 a P-3 com ações); EN-6 (impacto derivado da telemetria); PR-14 (replay independente da UI). |
| Gating artificial (ferramenta travada) | O júnior diz que quer uma pergunta que não está no repertório (ex.: `trace` no `03`) e fica > 5 min de relógio sem perguntar nada; ou um `referencePath` usa item de nível superior. | CN-5 no CI; pergunta 6 da entrevista; campo próprio na nota de pesquisa. |
| Projeto morre a 70% | A fase passa da semana 4 de SPEC §8 sem PR-1 verde; duas semanas sem commit em `$PROTO` ou `$SCEN`. | Tarefas ≤ 1 dia (Arquiteto); escopo fechado neste PRD; o motor da fase 1 continua sendo release útil mesmo com NO-GO (SPEC §8). |
| Arte consome o tempo | Qualquer `.css`, `<canvas>`, `<svg>` ou dependência de UI kit em `$PROTO`. | PR-2 no CI. |
| Inglês afasta público BR | O júnior pede tradução ou entende errado um texto da interface (a nota registra cada caso com o minuto da gravação). | Triagem de leitura técnica em inglês no perfil do Roteiro; casos registrados viram entrada para a fase 3 e a v0.2 (SPEC §11). |

## Roteiro de teste com humano

Obrigatório nesta fase (SPEC §8, Gate 2). O moderador segue este roteiro ao pé da letra. O que não está aqui não é feito na sessão.

### 0. Perfil e recrutamento

- **Júnior:** dev ou ops com 0 a 3 anos de experiência profissional, que já viu um dashboard de produção (SPEC §2).
- Lê documentação técnica em inglês no trabalho. Triagem: "Você lê documentação técnica em inglês no dia a dia?" Se a resposta for não, a pessoa não serve para esta sessão.
- Não leu `SPEC.md`, PRDs, ADRs nem os YAML de cenário, e não participou do projeto. Pode ter sido leitor do README no GATE-0.
- Assina consentimento para: gravação de tela e áudio, guardada só pelo Diretor e fora do repositório; publicação da nota anonimizada e dos logs no repositório público.

### 1. Preparação (antes do dia)

1. O ensaio (TH-1) está feito com o mesmo SHA de build que vai ser usado.
2. Build de `$PROTO` nesse SHA, servido localmente. O SHA fica anotado na nota.
3. `localStorage` limpo no navegador da sessão. Gravação de tela e áudio testada.
4. Anexo A (≤ 1 página, TH-6) impresso ou numa aba separada que o moderador fecha depois da leitura.
5. Ordem pré/pós definida por TH-5 e anotada na nota antes de começar (sessão 1: `TA` → `TB`).
6. A nota `docs/research/FASE-2-sessao-01.md` está aberta com o formulário do item 9, para o moderador anotar o minuto da gravação de cada observação.

### 2. Abertura (3 min)

O moderador lê em português, sem improvisar:

> "Isto é o protótipo de um jogo sobre investigar incidentes de produção. Estamos testando o jogo, não você. A interface está em inglês e não tem visual nenhum: é de propósito. Pense em voz alta o tempo todo: diga o que está olhando, o que acha que está acontecendo e por que vai fazer cada coisa. Eu não posso te ajudar com o incidente; só posso responder como usar a tela. A sessão está sendo gravada."

### 3. Leitura de controle (5 min)

O júnior lê o Anexo A, texto de no máximo 1 página sobre investigação de incidentes (as 4 práticas). Depois o moderador recolhe o texto. Isso separa "aprendeu lendo" de "aprendeu jogando": o pré-teste já é medido depois da leitura, então só conta como aprendizado da sessão o que melhorar além do que o texto ensinou (Gate 2: "aprendeu algo que não aprenderia lendo").

### 4. Pré-teste (até 15 min de relógio)

1. O moderador abre pelo modo de teste o incidente de pré-teste definido por TH-5 (`TA` na sessão 1).
2. O júnior joga até encerrar o incidente. Se chegar a 15 min, o moderador diz: "Encerre o incidente com a melhor hipótese que tiver."
3. O moderador exporta o log como `pre.json`. A revisão do incidente de pré-teste **não** é lida em voz alta nem comentada.

### 5. Cenários da campanha (até 45 min de relógio no total)

Para `01`, `03` e `05`, nessa ordem:

1. O júnior escolhe o cenário na lista e joga até encerrar (teto de 15 min por cenário, com a mesma frase do pré-teste).
2. O júnior lê a revisão em voz alta e diz o que achou de cada frase.
3. O moderador exporta o log (`01.json`, `03.json`, `05.json`).

### 6. Pós-teste (até 15 min de relógio)

O moderador abre pelo modo de teste o **outro** incidente de teste (`TB` na sessão 1), com as mesmas regras do pré-teste. O moderador exporta `post.json`. É um segundo incidente inédito, de dificuldade equivalente ao primeiro (CN-9), conforme decisão do Diretor no PR #75. Assim a melhora não vem de lembrar o incidente do pré-teste. A revisão do pós-teste é mostrada normalmente.

### 7. Regras do moderador durante as etapas 4 a 6

- Frases permitidas, e só elas:
  - "Continue pensando em voz alta."
  - "O que você está procurando agora?"
  - "Para [mecânica de tela], clique em [controle]."
  - "O que você faria no trabalho?" (resposta a qualquer pergunta sobre o incidente ou sobre as práticas)
  - a frase de teto de tempo.
- Qualquer outra fala é intervenção. Ela fica anotada com o minuto e a frase. Uma dica sobre as 4 práticas invalida a sessão (TH-4).
- O moderador não aponta componente, sinal, hipótese nem ação.

### 8. O que observar (anotar com o minuto da gravação)

- A primeira pergunta de cada sessão e a justificativa falada antes dela.
- Cada vez que o júnior menciona "o que mudou", deploy ou config.
- Cada hipótese dita em voz alta, inclusive as que não entraram no caderno, e cada abandono de hipótese com o motivo dito.
- O momento da decisão de agir (`restart` ou `rollback`) e o que ele disse sobre impacto e causa nessa hora.
- Pedidos de pergunta que não existe no repertório ("queria ver o trace") e quanto tempo ficou parado depois (risco de gating).
- Frases como "da última vez foi…" ou decisão pela forma de uma série ("a linha reta") (risco de gamesmanship).
- Dúvida ou erro de leitura de texto em inglês.
- Reação a cada frase da revisão.

### 9. Entrevista (10 min, depois do pós-teste)

O moderador pergunta, nesta ordem, e anota as respostas ao pé da letra:

1. "O que você fez diferente no último incidente em relação ao primeiro? Por quê?"
2. "Quando o alerta chegou, o que você olhou primeiro e por quê?"
3. "Teve um momento em que você abandonou uma ideia? O que te fez abandonar?"
4. "Em que momento você decidiu agir? Você já sabia a causa naquela hora?"
5. "O que o jogo te mostrou que o texto do começo não tinha te dito?" (pergunta central do Gate 2)
6. "Teve alguma coisa que você quis perguntar ao sistema e não conseguiu?"
7. "Alguma frase da revisão te surpreendeu? Qual?"
8. "Em algum momento você sentiu que estava adivinhando pelo padrão do jogo em vez de raciocinar?"
9. "Você jogaria os outros 5 incidentes? Por quê?" (informativo, não é critério)

**Formulário da nota de pesquisa** (`docs/research/FASE-2-sessao-01.md`): data; SHA do build; número do testador e ordem pré/pós (TH-5); perfil anonimizado (anos de experiência, papel dev/ops, triagem de inglês); ensaio (TH-1: tempos e problemas); duração real de cada etapa; observações do item 8, por etapa, com minuto; intervenções do moderador com minuto e frase; respostas da entrevista; saída do script de resultados (PR-15); lista dos 5 logs em `docs/research/fase-2/`.

### 10. Análise e definição dos 4 resultados (usada por PR-15 e TH-3)

Os resultados são calculados do log de pré-teste e do log de pós-teste, cada um contra o YAML do próprio incidente (`TA` ou `TB`): o `target`, o `referencePath` e o `impactBudget` usados são os do incidente daquele log. "Pergunta de sinal" = `dashboard`, `logs`, `trace` ou `compare`.

| ID | Resultado de SPEC §2 | Verdadeiro quando |
| --- | --- | --- |
| R-1 | (1) Perguntar "o que mudou?" antes de abrir qualquer gráfico | O log tem `whatChanged` antes de qualquer `dashboard`, `trace` ou `compare`. |
| R-2 | (2) Escolher qual sinal olhar primeiro e justificar | A primeira pergunta de sinal é sobre um componente do conjunto S = {`target` da falha} ∪ {componente da primeira pergunta de sinal do `referencePath`} **e** existe justificativa antes da segunda pergunta de sinal: uma entrada de caderno com texto no log, ou uma justificativa falada registrada na nota com o minuto. O script avalia a parte do log e imprime `justification: check research note` quando não há texto no log. O QA fecha o resultado com a nota. |
| R-3 | (3) Descartar uma hipótese com evidência | O log tem ≥ 1 descarte que cita ≥ 1 resposta anterior (PR-9). |
| R-4 | (4) Mitigar antes de ter root cause quando o impacto justifica | O log tem uma ação que é mitigação eficaz (o replay simula os 30 ticks seguintes sem outra ação). Ela acontece antes da primeira hipótese correta (ou não há hipótese correta), com impacto acumulado < `impactBudget` no momento da ação. |

- **Mudança de comportamento** = resultado falso em `pre.json` e verdadeiro em `post.json`. Critério do Gate 2 (TH-3): ≥ 1 mudança.
- **Informativo, não é critério:** número de perguntas de sinal até a primeira hipótese correta, pré e pós (métrica de SPEC §10, alvo de −30% com vários testadores na v0.1).
- **Limite conhecido:** pré e pós são incidentes diferentes. A equivalência de CN-9 controla a estrutura (orçamento, tamanho do caminho, papel do engano, impacto na mitigação), mas não garante a mesma dificuldade percebida. Com 1 testador, a ordem fixa `TA` → `TB` não separa efeito de ordem de efeito de incidente; o contrabalanceamento de TH-5 trata isso quando houver mais testadores. O Diretor pesa o resultado junto com as respostas 1 e 5 da entrevista e com os logs de `01`, `03` e `05`.
- **NO-GO:** volta para a fase 2 com o loop ajustado, nunca para a fase 3 (SPEC §8). O ajuste entra como emenda deste PRD, a partir da nota de pesquisa.

### Anexo A — texto de leitura de controle (≤ 1 página, ≤ 400 palavras; entregue ao júnior na etapa 3)

> **Quatro práticas para investigar um incidente**
>
> 1. Antes de abrir qualquer gráfico, pergunte o que mudou: deploys e mudanças de configuração recentes.
> 2. Escolha um sinal para olhar primeiro e saiba dizer por quê. O serviço que dispara o alerta nem sempre é o que tem o problema.
> 3. Trate cada ideia como hipótese. Quando um dado contradiz uma hipótese, descarte-a e diga qual dado a derrubou.
> 4. Se o impacto nos usuários é alto, mitigue primeiro (reiniciar, voltar a versão) e procure a causa raiz depois.

## Bloqueios

Nenhum. Nenhum critério desta fase depende de decisão aberta de SPEC §12:

- **Canvas/SVG × Phaser:** não se aplica. Esta fase não tem mapa (PR-2).
- **Tom narrativo:** nenhum critério fixa tom. Os únicos textos de conteúdo desta fase são títulos, alertas em formato de mensagem de monitoramento e as 3 frases da revisão, montadas de dados do log (PR-11). Se o Diretor decidir o tom antes de o Eng. Conteúdo escrever os modelos das frases da revisão, eles seguem a decisão. Se não, são reescritos na fase 3 sem mudar nenhum critério daqui.
