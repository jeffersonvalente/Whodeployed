# ADR-011 — Pré e pós-teste com dois incidentes inéditos de dificuldade equivalente

- **Status:** proposta, aguardando aprovação do Diretor
- **Data:** 2026-10-26
- **Decisor:** Diretor (Jefferson Valente). Mudança de SPEC §2 e §10: só o Diretor altera `SPEC.md` (SPEC §9, regra 4). O Arquiteto redige a ADR e o PR por pedido do Diretor.
- **Referência:** SPEC §2 ("Como medir"), §8 (Gate 2), §10 (métricas de aprendizado), §11 (gamesmanship); PRD FASE-2 (PR #75: CN-1, CN-3, CN-9, PR-4, PR-15, TH-5, TH-6, Roteiro); ADR-004 (catálogo de `FaultKind`)
- **Numeração:** o Diretor chamou esta decisão de "ADR-010". O número 010 já estava ocupado (`ADR-010-telemetry-immutability.md`), então ela foi registrada como ADR-011. O conteúdo é o da decisão do Diretor de 2026-10-26.

## Contexto

SPEC §2 dizia: "pré e pós-teste com o **mesmo** incidente inédito". SPEC §10 dizia, na linha de aprendizado: "Pré e pós-teste com cenário inédito (não da campanha)".

Com o mesmo incidente no pré e no pós, o jogador já viu o alerta, os sinais e, muitas vezes, a causa antes do pós-teste. A melhora medida mistura duas coisas: o que ele aprendeu jogando a campanha e o que ele lembra do próprio pré-teste (efeito de prática). A métrica de §10 ("redução ≥ 30% de sinais pedidos entre pré e pós") e o Gate 2 ("o júnior aprendeu algo que não aprenderia lendo") ficam inflados por esse segundo efeito e não separam um do outro.

O PM levou o desenho ao Diretor no PR #75 (PRD FASE-2). O Diretor aprovou pré e pós em dois incidentes inéditos diferentes (`TA` e `TB`), de dificuldade equivalente, ausentes da campanha, com ordem contrabalanceada quando houver mais de um testador. O PRD registrou que §2 e §10 ainda diziam "mesmo incidente inédito" e que ajustar o texto do spec é do Diretor, por ADR.

## Decisão

Decisão do Diretor (2026-10-26, textual): "SPEC §2 — opção 1. [...] emendando SPEC §2 (“Como medir”) e §10 (linha de aprendizado) para: “pré e pós-teste com dois incidentes inéditos de dificuldade equivalente, ausentes da campanha, gerados a partir de FaultKinds existentes com seed e noise próprios; ordem contrabalanceada entre testadores quando houver mais de um”."

1. **SPEC §2, "Como medir":** "pré e pós-teste com o mesmo incidente inédito" é substituído pelo texto do Diretor. O resto da frase não muda: a métrica (sinais pedidos até a hipótese correta e mitigação dentro do orçamento de impacto) e "Detalhes na seção 10".
2. **SPEC §10, linha "Aprendizado: sinais pedidos até hipótese correta"**, coluna "Como coletar": "Pré e pós-teste com cenário inédito (não da campanha)" é substituído pelo texto do Diretor; "log de ações exportado pelo jogador" e o alvo ("Redução ≥ 30% entre pré e pós") não mudam. A linha seguinte ("mitigou dentro do orçamento de impacto", coletada pelo "Mesmo teste") herda a mudança sem edição.
3. O contrato do motor (SPEC §6) não muda. "Gerados a partir de FaultKinds existentes" quer dizer: os incidentes de teste usam o catálogo de ADR-004 como está; nenhum `FaultKind` novo é criado para o teste. "Seed e noise próprios" quer dizer: `seed` e `noise` do YAML de cada incidente de teste são diferentes dos da campanha e diferentes entre si.

## Motivo

Eliminar o efeito de prática na métrica de §10. Com dois incidentes diferentes, o jogador não pode resolver o pós-teste lembrando o pré-teste; o que melhora entre os dois é o que a campanha ensinou. A equivalência de dificuldade mantém pré e pós comparáveis; o contrabalanceamento evita que uma diferença residual entre os dois incidentes vire sempre a favor (ou contra) o pós-teste.

## Consequências

- **PRD FASE-2 (PR #75).** O desenho com `TA`/`TB` passa a ser o do spec, não uma exceção a ele. Depois do merge desta emenda, o PM alinha o PRD: a nota da seção de decisões ("SPEC §2 e §10 ainda dizem 'mesmo incidente inédito' [...]") passa a citar SPEC §2/§10 emendados e esta ADR. Nenhum critério do PRD muda de conteúdo:
  - **CN-3** já exige incidentes inéditos, fora da campanha, com `kind` do catálogo existente e fora dos kinds jogados (`01`, `03`, `05`), e `seed`/`title`/`alert.text` próprios. É uma leitura mais estrita de "gerados a partir de FaultKinds existentes com seed e noise próprios"; CN-3 não exige hoje `noise` distinto, e o PM decide se acrescenta essa verificação para refletir "noise próprio".
  - **CN-9** é o critério verificável de "dificuldade equivalente" (mesmo nível, mesmo orçamento, mesma forma do caminho de referência, mesmo número de eventos de noise, mesmo papel do engano, impacto na mitigação dentro de 20%, mesmo tamanho de S). O spec não fixa o critério; ele fica no PRD de cada fase que mede aprendizado.
  - **TH-5** é a regra de contrabalanceamento ("ordem contrabalanceada entre testadores quando houver mais de um"): ímpares `TA → TB`, pares `TB → TA`, diferença ≤ 1 entre as ordens.
  - **PR-15** (script de resultados lê dois logs de incidentes diferentes e recusa dois logs do mesmo incidente) e **PR-4** (incidentes de teste fora da lista) seguem a emenda sem mudança.
- **Limite conhecido.** Dois incidentes diferentes trocam o efeito de prática por uma diferença residual de dificuldade. CN-9 controla a estrutura, não a dificuldade percebida. Com 1 testador (fase 2), a ordem é fixa (`TA → TB`) e não separa efeito de ordem de efeito de incidente; o contrabalanceamento só atua com mais de um testador (fase 5, SPEC §8: "5 jogadores externos com pós-teste respondido"). O PRD FASE-2 já registra esse limite no Roteiro.
- **Fase 3 em diante.** Os incidentes de teste são conteúdo (YAML, SPEC §3.7) e não entram na campanha de 8 cenários (SPEC §7). Quem escrever a campanha completa não pode reaproveitar `TA`/`TB` como cenário jogável, nem o inverso.
- **Princípios (SPEC §3).** Nenhum conceito novo de observabilidade (§3.1); nenhuma ferramenta ou pergunta nova (§3.2); incidentes de teste gerados pelo motor determinístico a partir de seed (§3.3); sem backend, coleta por log exportado pelo jogador (§3.6); incidentes de teste em YAML (§3.7). Escopo de SPEC §4 inalterado.
- **Outras seções do spec.** §8 (Gate 2 e fase 5: "pós-teste") e §10 ("respondeu ao pós-teste") continuam corretos sem edição: falam de pós-teste, não de qual incidente ele usa.

## Alternativas descartadas

- **Manter o mesmo incidente no pré e no pós (texto anterior de §2):** a métrica de §10 mede memória do pré-teste junto com aprendizado; é o problema que esta ADR resolve.
- **Pós-teste sem pré-teste (só comparar com o caminho de referência):** perde a linha de base do próprio jogador; o Gate 2 pede mudança de comportamento, não desempenho absoluto.
- **Incidentes de teste com `FaultKind` novo, criado só para o teste:** exigiria mudar o catálogo do motor (ADR-004) e a interface fixada na fase 1 sem ganho de medição; o Diretor fixou "FaultKinds existentes".

## Histórico

- 2026-10-26 — proposta pelo Arquiteto a pedido do Diretor (decisão "SPEC §2 — opção 1"), com PR emendando SPEC §2 e §10. Número ajustado de 010 para 011 por colisão com `ADR-010-telemetry-immutability.md`.
