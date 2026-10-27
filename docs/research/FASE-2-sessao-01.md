# FASE-2 — Nota de pesquisa, sessão 01

- **Estado:** modelo (T2.34). Campos `____` e caixas `[ ]` são preenchidos pelo moderador no ensaio e na sessão; a subseção "Conferência do QA" é preenchida pelo QA (T2.35); a seção 10 é fechada pelo QA (T2.36).
- **Fonte:** `docs/prd/FASE-2.md`, Roteiro de teste com humano (itens 0 a 10) e critérios TH-1, TH-2, TH-4, TH-5 e TH-6. Este modelo não acrescenta etapa, pergunta nem regra ao Roteiro; onde houver diferença, o Roteiro vale.
- **Termo de consentimento:** `docs/research/FASE-2-consentimento.md`. A cópia assinada fica com o Diretor, fora do repositório.
- **Logs da sessão:** `docs/research/fase-2/` (seção 10).

## Regras de preenchimento

1. **Anonimização.** Esta nota e os logs são públicos (repositório Apache-2.0). Não escreva nome, e-mail, empresa, cidade, rosto, voz, link ou caminho da gravação, nem detalhe que identifique o júnior. O júnior é "testador 1". Ao citar uma fala ao pé da letra, troque qualquer nome próprio dito por `[nome]` e qualquer empresa por `[empresa]`.
2. **Minuto.** Todo minuto é o tempo decorrido da gravação, no formato `mm:ss`, a partir do início da gravação.
3. **Ao pé da letra.** Falas do júnior na entrevista e falas do moderador nas intervenções são transcritas como foram ditas, entre aspas. Resumo só nas observações do item 8, e sempre com minuto.
4. **Sem telemetria.** Nada desta nota vem de coleta automática. Os logs saem do navegador por export manual do moderador (SPEC §3.6, §10; PR-3, PR-13).
5. **Não preenchido = não feito.** Campo obrigatório vazio na entrega para o QA é tratado como etapa não realizada.

## 1. Identificação

| Campo | Valor |
| --- | --- |
| Data da sessão | `____-__-__` |
| SHA do commit do build (`apps/web`) | `____` (40 caracteres; o mesmo do ensaio, seção 3) |
| Versão do pacote do motor (do log exportado) | `____` |
| Navegador e versão | `____` |
| Sistema operacional da máquina da sessão | `____` |
| Moderador | `____` (identificação definida pelo Diretor; pendência do gate) |
| O moderador escreveu código do protótipo? | `[ ] não` (se "sim", a sessão não pode acontecer com este moderador; FASE-2.tasks.md, "Não são tarefas de engenharia") |
| Número do testador | `1` |
| Gravação de tela e áudio existe | `[ ] sim`; guardada pelo Diretor fora do repositório; o `GATE-2.md` registra a existência e a data (TH-2) |
| Termo de consentimento assinado antes do início | `[ ] sim`, em `____-__-__`; cópia com o Diretor |

### 1.1 Ordem pré/pós (TH-5) — preenchida antes da sessão

Regra de TH-5: com 1 testador, pré = `TA` e pós = `TB`. Com mais de um, testador ímpar faz `TA` → `TB` e testador par faz `TB` → `TA`.

| Campo | Valor |
| --- | --- |
| Número do testador | 1 (ímpar) |
| Incidente de pré-teste | `TA` — `id` no YAML: `test-____` |
| Incidente de pós-teste | `TB` — `id` no YAML: `test-____` |
| Ordem anotada em (data e hora, antes da abertura) | `____` |
| `id` lido em `fase-2/pre.json` (depois da sessão) | `____` (tem que ser o `id` de `TA`) |
| `id` lido em `fase-2/post.json` (depois da sessão) | `____` (tem que ser o `id` de `TB`) |
| Ordem bate com os logs? (QA, T2.36) | `[ ] sim  [ ] não` |

## 2. Perfil anonimizado (Roteiro, item 0)

| Campo | Valor |
| --- | --- |
| Anos de experiência profissional | `__` (tem que estar entre 0 e 3) |
| Papel | `[ ] dev  [ ] ops` |
| Já viu um dashboard de produção? | `[ ] sim` |
| Triagem de inglês: "Você lê documentação técnica em inglês no dia a dia?" | `[ ] sim` (se "não", a pessoa não serve para esta sessão) |
| Não leu `SPEC.md`, PRDs, ADRs nem os YAML de cenário e não participou do projeto | `[ ] confirmado` |
| Foi leitor do README no GATE-0? | `[ ] sim  [ ] não` (permitido; registrar) |

## 3. Ensaio (TH-1)

O ensaio é o roteiro completo, itens 1 a 9, feito antes da sessão por uma pessoa que **não** é o júnior, com o **mesmo** SHA de build da sessão. Os logs do ensaio não vão para `docs/research/fase-2/`, que guarda só os 5 logs da sessão (TH-2); a evidência do ensaio é o que está registrado nesta seção.

| Campo | Valor |
| --- | --- |
| Data do ensaio | `____-__-__` |
| SHA do commit do build | `____` (igual ao da seção 1: `[ ] sim`) |
| Pessoa do ensaio | `____` (só o papel, ex.: "contribuidor do projeto"; não é o júnior) |
| Moderador do ensaio | `____` |

### 3.1 Tempos do ensaio

| Etapa do Roteiro | Teto | Início (`mm:ss`) | Fim (`mm:ss`) | Duração | Passou do teto? |
| --- | --- | --- | --- | --- | --- |
| 2. Abertura | 3 min | | | | |
| 3. Leitura de controle | 5 min | | | | |
| 4. Pré-teste | 15 min | | | | |
| 5. Cenário `01` | 15 min | | | | |
| 5. Cenário `03` | 15 min | | | | |
| 5. Cenário `05` | 15 min | | | | |
| 5. Campanha (total) | 45 min | | | | |
| 6. Pós-teste | 15 min | | | | |
| 9. Entrevista | 10 min | | | | |
| **Total** | | | | | |

### 3.2 Export dos 5 logs e replay (PR-13, PR-14)

Comando de replay (ADR-015), rodado na raiz do repositório para cada log, com o YAML do incidente daquele log:

```sh
pnpm --filter @whodeployed/web replay -- <log.json> <scenario.yaml>
```

| Log do ensaio | Exportado (download) | `id` no log | YAML usado | Exit do replay | Primeiro passo divergente (se exit ≠ 0) |
| --- | --- | --- | --- | --- | --- |
| `pre.json` | `[ ]` | | | | |
| `01.json` | `[ ]` | | | | |
| `03.json` | `[ ]` | | | | |
| `05.json` | `[ ]` | | | | |
| `post.json` | `[ ]` | | | | |

Saída do script de resultados sobre `pre.json` e `post.json` do ensaio (confere que o comando roda; não é medida):

```text
(colar aqui a saída de: pnpm --filter @whodeployed/web results -- <pre.json> <post.json> --scenarios <dir>)
```

### 3.3 Anexo A (TH-6)

| Campo | Valor |
| --- | --- |
| Palavras do Anexo A (comando abaixo) | `____` (tem que ser ≤ 400; contagem na entrega do modelo: 87) |
| Impresso ou aberto em aba separada, cabe em 1 página | `[ ] sim` |
| A aba foi fechada (ou o papel recolhido) depois da leitura | `[ ] sim` |

Contagem, na raiz do repositório (texto do bloco citado, sem os marcadores `>` e `**`):

```sh
awk '/^### Anexo A/{f=1;next} /^## /{f=0} f && /^>/' docs/prd/FASE-2.md | sed -e 's/^> \{0,1\}//' -e 's/\*\*//g' | wc -w
```

### 3.4 Problemas encontrados no ensaio

| # | Etapa | Minuto | Problema | O que foi feito antes da sessão |
| --- | --- | --- | --- | --- |
| 1 | | | | |

### 3.5 Conferência do QA (T2.35)

Preenchida pelo QA, no build do SHA da sessão. Cada linha cita o critério.

| Critério | Resultado | Evidência |
| --- | --- | --- |
| TH-1: ensaio com o mesmo SHA, tempos registrados, 5 logs exportados com replay exit 0 | `[ ] ok  [ ] falha` | |
| TH-6: Anexo A ≤ 400 palavras | `[ ] ok  [ ] falha` | contagem: |
| TH-6: nenhum componente, falha ou sinal de `TA`, `TB`, `01`, `03`, `05` citado (nomes dos 5 YAML contra o texto) | `[ ] ok  [ ] falha` | lista de nomes conferida: |
| PR-3: `01` jogável com DevTools *Offline*, 0 requisições depois do carregamento | `[ ] ok  [ ] falha` | |
| PR-17: ≤ 1 s entre clicar em `dashboard` no tick 300 e a resposta | `[ ] ok  [ ] falha` | tempo, máquina, navegador: |
| PR-18: nenhum texto que ensine as 4 práticas nas telas dos 5 cenários | `[ ] ok  [ ] falha` | |
| PR-20 / PR-21: comandos do README rodam verbatim | `[ ] ok  [ ] falha` | |

## 4. Checklist de preparação (Roteiro, item 1)

Marcar no dia, antes da abertura. Sessão não começa com caixa vazia.

- [ ] 1. O ensaio (TH-1, seção 3) está feito com o mesmo SHA de build que vai ser usado, e a conferência do QA (seção 3.5) está sem falha.
- [ ] 2. Build de `apps/web` nesse SHA, servido localmente. SHA anotado na seção 1.
- [ ] 3. `localStorage` limpo no navegador da sessão. Gravação de tela e áudio testada (grava, toca, áudio audível).
- [ ] 4. Anexo A (≤ 1 página, TH-6) impresso ou numa aba separada que o moderador fecha depois da leitura.
- [ ] 5. Ordem pré/pós definida por TH-5 e anotada na seção 1.1 antes de começar (sessão 1: `TA` → `TB`).
- [ ] 6. Esta nota está aberta, pronta para anotar o minuto da gravação de cada observação.
- [ ] 7. Termo de consentimento (`docs/research/FASE-2-consentimento.md`) assinado pelo júnior antes de a gravação começar (Roteiro, item 0).
- [ ] 8. O júnior passou pela triagem do perfil (seção 2).

## 5. Duração real de cada etapa

| Etapa do Roteiro | Teto | Início (`mm:ss`) | Fim (`mm:ss`) | Duração | Frase de teto usada? |
| --- | --- | --- | --- | --- | --- |
| 2. Abertura (texto lido sem improviso) | 3 min | | | | n/a |
| 3. Leitura de controle | 5 min | | | | n/a |
| 4. Pré-teste (`TA`) | 15 min | | | | `[ ] sim  [ ] não` |
| 5. Cenário `01` | 15 min | | | | `[ ] sim  [ ] não` |
| 5. Cenário `03` | 15 min | | | | `[ ] sim  [ ] não` |
| 5. Cenário `05` | 15 min | | | | `[ ] sim  [ ] não` |
| 5. Campanha (total) | 45 min | | | | n/a |
| 6. Pós-teste (`TB`) | 15 min | | | | `[ ] sim  [ ] não` |
| 9. Entrevista | 10 min | | | | n/a |

- Abertura lida ao pé da letra (Roteiro, item 2): `[ ] sim  [ ] não` (se "não", registrar o que mudou: `____`)
- Revisão do pré-teste **não** lida em voz alta nem comentada (Roteiro, item 4.3): `[ ] confirmado`

## 6. Observações (Roteiro, item 8), por etapa, com minuto

Códigos das observações (um por item do Roteiro, item 8):

| Código | O que anotar |
| --- | --- |
| O-1 | A primeira pergunta da sessão e a justificativa falada antes dela |
| O-2 | Menção a "o que mudou", deploy ou config |
| O-3 | Hipótese dita em voz alta (inclusive as que não entraram no caderno) |
| O-4 | Abandono de hipótese, com o motivo dito |
| O-5 | Decisão de agir (`restart` ou `rollback`) e o que disse sobre impacto e causa nessa hora |
| O-6 | Pedido de pergunta fora do repertório ("queria ver o trace") e quanto tempo ficou parado depois |
| O-7 | "Da última vez foi…" ou decisão pela forma de uma série ("a linha reta") |
| O-8 | Dúvida ou erro de leitura de texto em inglês |
| O-9 | Reação a cada frase da revisão (não se aplica ao pré-teste) |

### 6.1 Pré-teste (`TA`)

| Minuto | Código | O que foi dito ou feito |
| --- | --- | --- |
| | O-1 | |
| | | |

### 6.2 Cenário `01`

| Minuto | Código | O que foi dito ou feito |
| --- | --- | --- |
| | O-1 | |
| | | |

### 6.3 Cenário `03`

| Minuto | Código | O que foi dito ou feito |
| --- | --- | --- |
| | O-1 | |
| | | |

### 6.4 Cenário `05`

| Minuto | Código | O que foi dito ou feito |
| --- | --- | --- |
| | O-1 | |
| | | |

### 6.5 Pós-teste (`TB`)

| Minuto | Código | O que foi dito ou feito |
| --- | --- | --- |
| | O-1 | |
| | | |

### 6.6 Sinais de alerta da fase (PRD, "Riscos específicos da fase")

| Risco (SPEC §11) | Sinal concreto | Observado? | Minuto(s) e evidência |
| --- | --- | --- | --- |
| Gamesmanship | As 3 primeiras perguntas têm os mesmos `kind` na mesma ordem em `01`, `03`, `05` e no pós-teste (conferir nos logs) | `[ ] sim  [ ] não` | sequência por etapa: |
| Gamesmanship | Fala do tipo O-7 | `[ ] sim  [ ] não` | |
| Gating artificial | Pedido O-6 seguido de > 5 min de relógio sem nenhuma pergunta | `[ ] sim  [ ] não` | |
| Motor incoerente | Depois de uma ação, um sinal mostra recuperação e outro não | `[ ] sim  [ ] não` | |
| Inglês afasta público BR | Pedido de tradução ou erro de leitura (O-8) | `[ ] sim  [ ] não` | quantidade: |

## 7. Intervenções do moderador (TH-4; Roteiro, item 7)

Durante as etapas 4 a 6, **toda** fala do moderador entra nesta tabela, com o minuto e a frase ao pé da letra, inclusive as permitidas.

Frases permitidas, e só elas:

| Código | Frase permitida |
| --- | --- |
| P-1 | "Continue pensando em voz alta." |
| P-2 | "O que você está procurando agora?" |
| P-3 | "Para [mecânica de tela], clique em [controle]." |
| P-4 | "O que você faria no trabalho?" (resposta a qualquer pergunta sobre o incidente ou sobre as práticas) |
| P-5 | "Encerre o incidente com a melhor hipótese que tiver." (frase de teto de tempo) |

| # | Etapa | Minuto | Frase dita (ao pé da letra) | Código (P-1..P-5 ou "fora") | Aponta componente, sinal, hipótese ou ação, ou dá dica sobre as 4 práticas? |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | `[ ] não  [ ] sim` |

**Validade da sessão (TH-4):** a sessão é válida só se nenhuma linha está marcada "fora" e nenhuma linha tem "sim" na última coluna. Uma intervenção fora das frases permitidas invalida a sessão, e é preciso outra sessão com outro júnior.

- Linhas "fora": `__` · Linhas com "sim" na última coluna: `__`
- Sessão válida pelo moderador: `[ ] sim  [ ] não`
- Sessão válida pelo QA (T2.36): `[ ] sim  [ ] não`

## 8. Entrevista (Roteiro, item 9)

Perguntas nesta ordem, respostas ao pé da letra.

1. "O que você fez diferente no último incidente em relação ao primeiro? Por quê?"
   > ____
2. "Quando o alerta chegou, o que você olhou primeiro e por quê?"
   > ____
3. "Teve um momento em que você abandonou uma ideia? O que te fez abandonar?"
   > ____
4. "Em que momento você decidiu agir? Você já sabia a causa naquela hora?"
   > ____
5. "O que o jogo te mostrou que o texto do começo não tinha te dito?" (pergunta central do Gate 2)
   > ____
6. "Teve alguma coisa que você quis perguntar ao sistema e não conseguiu?"
   > ____
7. "Alguma frase da revisão te surpreendeu? Qual?"
   > ____
8. "Em algum momento você sentiu que estava adivinhando pelo padrão do jogo em vez de raciocinar?"
   > ____
9. "Você jogaria os outros 5 incidentes? Por quê?" (informativo, não é critério)
   > ____

## 9. Saída do script de resultados (PR-15)

Comando (ADR-015), na raiz do repositório:

```sh
pnpm --filter @whodeployed/web results -- docs/research/fase-2/pre.json docs/research/fase-2/post.json --scenarios packages/scenarios/scenarios
```

```text
(colar aqui a saída completa, sem editar)
```

**Fechamento de R-2 pela nota** (só quando o script imprime `justification: check research note`): justificativa falada antes da segunda pergunta de sinal.

| Log | Minuto | Fala (ao pé da letra) | R-2 fechado pelo QA |
| --- | --- | --- | --- |
| `pre.json` | | | `[ ] verdadeiro  [ ] falso` |
| `post.json` | | | `[ ] verdadeiro  [ ] falso` |

## 10. Logs da sessão em `docs/research/fase-2/` (TH-2)

Exatamente estes 5 arquivos, exportados pelo moderador na sessão. Antes do commit, o moderador confere que os textos livres do caderno não têm nome de pessoa ou empresa (regra 1); se tiver, a sessão não é editada à mão (o replay falharia): o caso é registrado aqui e levado ao Diretor.

| Arquivo | Etapa | `id` esperado | `id` no log | Exit do replay (QA, T2.36) |
| --- | --- | --- | --- | --- |
| `pre.json` | 4. Pré-teste | `id` de `TA` (seção 1.1) | | |
| `01.json` | 5. Cenário `01` | `01-…` | | |
| `03.json` | 5. Cenário `03` | `03-…` | | |
| `05.json` | 5. Cenário `05` | `05-…` | | |
| `post.json` | 6. Pós-teste | `id` de `TB` (seção 1.1) | | |

- Textos livres do caderno sem dado pessoal: `[ ] conferido`
