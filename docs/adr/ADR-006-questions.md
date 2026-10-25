# ADR-006 — Perguntas: unidade de `window`, janelas, `tickCost` e semântica de cada `Question`

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor")
- **Referência:** SPEC §3.2, §3.4, §5, §6; PRD Q-1..Q-10, H5

## Contexto

O PRD pede em ADR: unidade de `window` (Q-5), janela do `dashboard` (Q-4), tabela de `tickCost` (Q-2), derivação do `lastWeek` (Q-8, em ADR-003) e a forma estruturada do `askNpc` (Q-9). SPEC §5 diz que o custo de pergunta é tempo e que todas as perguntas existem desde o início (o motor não conhece nível).

## Decisão

### Janelas

- `window` é medido em **ticks**, inteiro ≥ 1, e cobre o intervalo fechado `[max(0, now − window), now]`, onde `now = World.tick`. Vale para `logs` e `whatChanged` (Q-5, Q-7). Ex.: "últimos 5 min" = `window: 30`.
- `dashboard` e `compare` usam janela fixa de 30 ticks (`[max(0, now − 30), now]`).
- Todos os `Signal` com intervalo trazem `from`/`to` efetivos.

### `tickCost` (Q-2) — função só do `kind`

| kind | tickCost | Motivo |
| --- | --- | --- |
| `dashboard` | 1 | Olhar um painel pronto |
| `logs` | 1 | Ler logs (com ou sem filtro) |
| `whatChanged` | 1 | Consultar deploys/configs |
| `trace` | 2 | Achar e abrir um trace |
| `compare` | 2 | Montar uma comparação |
| `askNpc` | 3 | Chamar uma pessoa custa mais |

`ask()` não avança o relógio; devolve o custo (ADR-002).

### Semântica

- **`dashboard`** → `DashboardSignal.records`: os `MetricRecord` agregados (sem `instance`) do componente, um por tick da janela, iguais aos da telemetria (Q-4). `service` aceita qualquer componente (serviço ou dependência), como no exemplo de SPEC §7 (`dashboard postgres`).
- **`logs`** → entradas do componente na janela. `filter`: cada par `chave: valor` precisa casar; a chave é um campo de topo do log (`level`, `instance`, `message`, `traceId`) ou uma chave de `attrs`; a comparação é `String(valorDoLog) === valor`. Chave inexistente na entrada = não casa. `filter` vazio ou ausente = sem filtro.
- **`trace`** → entre os spans `server` do componente no tick `now`, ordena por duração (empate: ordem de geração) e escolhe o de posição *nearest-rank* do percentil; devolve `focusSpanId` e todos os spans do trace. A duração escolhida é igual ao pXX do agregado em `dashboard` no mesmo tick (Q-6). Sem spans no tick: `focusSpanId: null`, `spans: []`.
- **`whatChanged`** → todos e só os `EventRecord` (deploy e config, de falha e de noise) com tick na janela, em ordem de registro (Q-7). O sinal não informa a origem do evento (falha ou noise): distinguir é tarefa do jogador (SPEC §3.4).
- **`compare`** → `metric` precisa ser um `MetricName`. `by: 'instance'`: uma série por instância (label = id da instância), da janela. `by: 'lastWeek'`: duas séries, `current` (agregado desta execução) e `lastWeek` (agregado da simulação `${seed}:lastWeek` sem falhas nem noise, ADR-003), mesmos ticks.
- **`askNpc`** → `NpcSignal.hints`: até 3 anomalias, sem prosa (Q-9). Para cada candidato (componente/instância × métrica), `current` = média nos ticks `[max(0, now − 5), now]` desta execução e `usual` = média nos mesmos ticks do `lastWeek`; desvio = `|current − usual| / max(usual, 1)`. Só entram desvios ≥ 0,25; ordenação por desvio desc, empate pela ordem do mundo e depois pela ordem de `MetricName`. Escopo por papel:
  - `dev`: agregados dos **serviços**, métricas `rps`, `p95`, `errorPct`;
  - `dba`: agregados das dependências `database` (todas as 8 métricas) e `connections` dos serviços que as chamam;
  - `oncall`: **instâncias** de todos os componentes, métricas `p95`, `errorPct`, `cpu`.
  O texto que o NPC "fala" é conteúdo da fase 3 (Eng. Conteúdo), montado a partir destes campos.

### Validação (Q-10) — `src/questions/validate.ts`

Antes do handler: `kind` conhecido; `service` existe no mundo (`unknown_service`, lista os componentes); `window` inteiro ≥ 1 (`invalid_window`); `percentile ∈ {50, 95, 99}` (`invalid_percentile`); `metric ∈ MetricName` (`unknown_metric`); `by ∈ {instance, lastWeek}`; `role ∈ {dev, dba, oncall}` (`invalid_role`); `filter` com valores string (`invalid_filter`). Erro = `EngineError` com `field` = `question.<campo>` e `validValues`. Nenhum parâmetro de nível de jogador existe (Q-1).

## Consequências

- O jogo (fase 2+) avança o relógio por `tickCost`; a tabela pode ser ajustada por PRD futuro sem mudar o contrato (só os números).
- Como `trace` usa o mesmo nearest-rank de `metrics.ts`, Q-6 é coerência por construção; ainda assim tem teste.

## Alternativas descartadas

- **`window` em minutos:** mistura duas unidades de tempo no motor; tick é a unidade de SPEC §6.
- **`tickCost` proporcional a `window`:** incentivaria janelas curtas artificiais; o custo é da decisão de perguntar, não do volume.
- **NPC devolvendo `FaultKind` suspeito:** entregaria a resposta e violaria SPEC §3.2/§3.4.
