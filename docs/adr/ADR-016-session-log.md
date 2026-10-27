# ADR-016 — Formato do log de sessão (v1) e JSON canônico

- **Status:** aceita
- **Data:** 2026-10-26
- **Decisor:** Arquiteto (decisão delegada; PRD FASE-2 PR-13 "O formato está em ADR, com número de versão")
- **Referência:** SPEC §3.3, §3.6, §8, §10 ("log de ações exportado pelo jogador"); PRD FASE-2 PR-9, PR-12..PR-16, I24-6, TH-2, R-1..R-4; ADR-005, ADR-006, ADR-012, ADR-013, ADR-015

## Contexto

O log de ações é a evidência do Gate 2: o QA repete cada sessão no motor (PR-14, TH-2) e o script de resultados mede R-1..R-4 sobre ele (PR-15, TH-3). Ele sai do navegador do jogador por export voluntário (SPEC §10), sem rede e sem dado pessoal.

## Decisão

### 1. Estrutura

Tipo `SessionLogV1` em `apps/web/src/session/types.ts`. Um arquivo JSON, UTF-8, com as chaves nesta ordem:

| Chave | Conteúdo |
| --- | --- |
| `format` | `"whodeployed-session-log"` |
| `version` | `1` |
| `scenario` | `{ id, seed }` do YAML |
| `engine` | `{ version }` — `version` de `packages/engine/package.json` no build |
| `build` | `{ sha }` — SHA do commit do build (ADR-015 §6) |
| `steps` | lista de passos (abaixo), na ordem em que aconteceram |
| `finalHypothesis` | `null` até o fim; depois, `{ kind: 'active', hypothesisSeq }`, `{ kind: 'new', component, text }` ou `{ kind: 'unknown' }` |
| `review` | `null` até o fim; depois, as 3 frases (PR-11) |

Cada passo tem `seq` (1, 2, …), `tickBefore`, `type`, os campos do tipo, `tickCost`, `impactAfter` e `wallMs`, nesta ordem:

| `type` | Campos do tipo | `tickCost` |
| --- | --- | --- |
| `ask` | `question` (a `Question` pedida), `answer` (o `Answer` inteiro devolvido pelo motor) | `answer.tickCost` |
| `act` | `action`, `result` (o `ActionResult`) | `result.tickCost` |
| `wait` | — | 1 |
| `hypothesis` | `component`, `text` | 0 |
| `discard` | `hypothesisSeq`, `citedSeqs` (≥ 1 `seq` de passo `ask` anterior), `text` (opcional, omitido quando vazio) | 0 |
| `end` | `final`, `reason` (`player` ou `tickLimit`) | 0 |

`tickCost` de `ask`/`act` registra o custo pago, já limitado ao tick 360 (ADR-015 §5). `impactAfter` = impacto acumulado (ADR-013) no tick `tickBefore + tickCost`. `wallMs` = ms inteiros de relógio de parede desde o início da sessão.

**Proibido no log** (PR-13, SPEC §3.6): nome, identificador do jogador, data ou hora absoluta, user agent, idioma do navegador, qualquer dado do ambiente.

O `answer` inteiro vai no log para que o replay compare resposta por resposta e para que o QA leia o que o júnior viu. Uma sessão de 40 perguntas tem algumas centenas de KB.

### 2. JSON canônico (I24-6)

Usado na serialização do log, no replay (PR-14) e no teste de determinismo (PR-12):

- Chaves de objeto na ordem declarada acima e, dentro de `question`, `answer` e `action`, na ordem do contrato do motor (é a ordem em que o motor devolve as cópias validadas, ADR-006).
- Chave com valor `undefined` é omitida; `undefined` ≡ ausente (I24-6). `null` só onde o tipo diz.
- Números como `JSON.stringify`; sem espaços; uma quebra de linha no fim do arquivo.
- Comparação "igual" = strings canônicas iguais. Para PR-12, os `wallMs` são zerados antes de comparar.

### 3. Replay (PR-14)

`replayLog(log, scenario)` cria a simulação do cenário, avança até `alert.tick` e, para cada passo: confere `tickBefore`; para `ask`, chama `ask(question)` e compara o `Answer` canônico; para `act`, chama `act(action)` e compara o `ActionResult`; avança `tickCost` (conferindo que é o custo esperado, limitado a 360); confere `impactAfter`. No fim, recalcula as 3 frases e compara com `review`. O primeiro desvio devolve `{ ok: false, seq, field, message }`. `format`/`version` desconhecidos: `field: 'format'`. Versão do motor diferente da do log: aviso no stderr, sem falhar (o replay é a prova).

### 4. Versionamento

Mudança que quebra leitura (campo removido, significado mudado) sobe `version` para 2 e mantém o leitor da v1 no replay. Campo novo opcional não sobe a versão.

## Consequências

- O replay não confia na UI: só no log, no YAML e no motor (H9).
- Os 5 logs da sessão do júnior (`docs/research/fase-2/`) são públicos e não identificam a pessoa (TH-2).
- PR-15 lê `R-1..R-4` só dos passos (`ask` de `whatChanged` antes de sinal, primeira pergunta de sinal, `discard` com `citedSeqs`, ação eficaz via `checkMitigations`, ADR-014 §3.1).

## Alternativas descartadas

- **Hash da resposta no lugar da resposta inteira:** log menor, mas o QA não leria o que o jogador viu e um desvio não teria diagnóstico.
- **Só as entradas, sem `answer` e `impactAfter`:** o replay não teria contra o que comparar; PR-14 pede conferir cada resposta e cada impacto.
- **Timestamp absoluto por passo:** é dado do ambiente do jogador (PR-13 proíbe data absoluta); `wallMs` relativo basta para tempos.
