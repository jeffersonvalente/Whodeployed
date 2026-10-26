# GATE-1 — Motor

- **Fase encerrada:** 1 — Motor (`packages/engine`)
- **Libera:** Fase 2 — Protótipo de texto
- **Data do relatório:** 2026-10-26 (rascunho; Recomendação pendente)
- **Relator:** agente QA do gate. Não escreveu código do motor nem participou como engenheiro de nenhuma tarefa T1.n (requisito do Diretor).
- **`main` na abertura do relatório:** `c6cec55` (PR #71). O SHA do `main` final, sobre o qual os comandos são re-executados, entra na seção "Re-execução no main final".
- **Entrada:** SPEC §3, §4, §8; `docs/prd/FASE-1.md` (Emendas 1–3); `docs/prd/FASE-1.tasks.md`; ADR-001 a ADR-010; `docs/gates/GATE-0.md`; PRs #1–#71 e issues no GitHub.

## Como ler este relatório

- **Resultado por PR**: o critério foi verificado no(s) PR(s) citado(s), com CI verde e comentário `## QA — APROVADO` no próprio PR. Todos os 38 PRs de código da fase têm esse comentário (alguns depois de uma reprovação: #3, #52, #54, #56, #59, #69; o QA do #65 está como review).
- **Re-execução no main final**: por decisão do Diretor, nenhum resultado de comando antigo vale para a Recomendação. Todos os comandos (install, lint, typecheck, testes, cobertura, determinismo, verificador de coerência, build, pack, instalação isolada) são rodados de novo num checkout limpo do `main` final, depois do merge da T1.29. Até lá a coluna fica ⏳.
- Legenda: ✅ verificado · ⏳ pendente · ⚠️ divergência que pede decisão do Diretor · ❌ reprovado.
- No PRD, "validador" desta fase é o verificador independente de coerência (`packages/engine/scripts/verify-coherence.mjs`, P-4). O validador de cenários (`packages/scenarios`) está fora de escopo da fase 1 (PRD, "Fora de escopo").

## Critérios do gate (SPEC §8, fase 1)

| Critério SPEC §8 | Critérios do PRD que o cobrem | Resultado por PR | Re-execução no main final | Evidência |
| --- | --- | --- | --- | --- |
| Entregável: `packages/engine` com `World`, 6 `FaultKind`, métricas/logs/traces/eventos, `ask()`, CLI `simulate --seed --fault --ticks` | CT-1, F-1, S-1..S-4, Q-1..Q-10, CLI-1..CLI-4 | ✅ | ⏳ | Tabelas abaixo; T1.1–T1.28, T1.30–T1.37 mergeadas |
| Testes ≥ 80% em `sim` e `faults` | QC-1 | ✅ | ⏳ | `packages/engine/vitest.config.ts` (thresholds 80/80/80/80 em `src/sim/**` e `src/faults/**`); PR #3 |
| Seed idêntica = saída byte-idêntica | D-1, D-2, D-3 | ✅ | ⏳ | `packages/engine/scripts/ci-engine.sh` (D-1/D-2); `test/fixtures.test.ts` (D-3); PRs #49, #53 |
| Propriedade "métrica agregada é derivável dos spans do tick" | P-1, P-2, P-3, P-4 | ✅ | ⏳ | `test/properties/coherence.test.ts` (PR #38); `scripts/verify-coherence.mjs` (PRs #19, #49) |
| Roadmap do Gate 1: "6 falhas" | F-1..F-7 | ✅ | ⏳ | `test/faults/*.test.ts`, `test/properties/multi-fault.test.ts` |
| Roadmap do Gate 1: "CLI publicado" | PUB-1..PUB-4 | ⏳ / ⚠️ | ⏳ | PUB-1..PUB-3 ✅ por PR; PUB-4 pendente da T1.29 e com divergência registrada abaixo |

## Critérios do PRD FASE-1

### Contrato

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| CT-1 | ✅ | ⏳ | `test/contract.types.test.ts` (`expectTypeOf` contra cópia literal de SPEC §6); PR #3, #5 fechada |
| CT-2 | ✅ | ⏳ | `tsconfig.json` com `"strict": true`; `pnpm --filter ./packages/engine typecheck` no CI; PR #3 |
| CT-3 | ✅ | ⏳ | `test/boundaries.test.ts` + `no-restricted-imports` em `eslint.config.js` (ADR-008); PR #3, #6 fechada |

### Mundo

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| W-1 | ✅ | ⏳ | `test/world/default-shop.test.ts`; PR #14 |
| W-2 | ✅ | ⏳ | `test/world/default-shop.test.ts`; PR #14 |
| W-3 | ✅ | ⏳ | `test/world/build.test.ts`, `test/sim/simulation.test.ts` (mundo de 2 serviços + 1 dependência, 30 ticks); PRs #14, #26 |
| W-4 | ✅ | ⏳ | `test/properties/coherence.test.ts`, `test/sim/serialize.test.ts`; PRs #12, #26, #38 |

### Falhas

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| F-1 | ✅ | ⏳ | Teste de tipo em `test/contract.types.test.ts`; mapeamento kind → linha SPEC §7 conferido em ADR-004 (tabela: 1 `service_crash_loop`, 2 `disk_full`, 3 `connection_pool_exhaustion`, 4 `bad_deploy`, 5 `slow_dependency`, 7 `cache_cold_start`; 6 = noise, 8 = F-6) |
| F-2 | ✅ | ⏳ | Bloco F-2 em cada `test/faults/<kind>.test.ts`; PRs #32, #34, #36, #37, #40, #43 |
| F-3 linha 1 (`service_crash_loop`) | ✅ | ⏳ | `test/faults/service_crash_loop.test.ts` sobre o helper R1–R5; PRs #32, #65 (T1.34) |
| F-3 linha 2 (`disk_full`) | ✅ | ⏳ | `test/faults/disk_full.test.ts`; `failRatio` 0,9 (ADR-004 Emenda 3); PRs #36, #59 (T1.36) |
| F-3 linha 3 (`connection_pool_exhaustion`) | ✅ | ⏳ | `test/faults/connection_pool_exhaustion.test.ts`; `leakPerTick` 4; R6 com teto; quantificador do trace da Emenda 3; PRs #43, #56 (T1.37) |
| F-3 linha 4 (`bad_deploy`) | ✅ | ⏳ | `test/faults/bad_deploy.test.ts`; PRs #34, #50, #65 |
| F-3 linha 5 (`slow_dependency`) | ✅ | ⏳ | `test/faults/slow_dependency.test.ts`; PRs #37, #69 (T1.35) |
| F-3 linha 7 (`cache_cold_start`) | ✅ | ⏳ | `test/faults/cache_cold_start.test.ts`; p50 (Emenda 1), curva de miss nova (ADR-004 Emenda 3), leitura "≥ 1 usuário da cache" (Emenda 3 item 5); PRs #40, #69 |
| F-4 | ✅ | ⏳ | Par fixo via `assertEligibleF4` em cada suíte de falha: crash loop (`gateway`, `errorPct`), bad deploy (`auth`, `rps`), disk full (`orders-worker`, `errorPct`), pool (`gateway`, `p95`), slow dependency (`gateway`, `p95`), cache cold start (`postgres`, `connections`); PRs #56, #59, #65, #69 |
| F-5 | ✅ | ⏳ | `test/faults/bad_deploy.test.ts` (R3 na instância afetada, R5 nos tetos); PRs #34, #65 |
| F-6 | ✅ | ⏳ | `test/properties/multi-fault.test.ts` (pool em `payment` + crash loop em `catalog`, R1–R6, determinismo); PR #47 (T1.25); caso combinado também em PR #56 |
| F-7 | ✅ | ⏳ | `test/faults/resolve.test.ts`, `test/errors.test.ts`, `test/cli/main.test.ts` (`__proto__`); PRs #20, #30 (`null`), #33 |

#### Regras de agregação e elegibilidade (Emendas 2 e 3)

| Regra | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| R1 — ≥ 10 seeds em lista fixa; QA repete com outra lista | ✅ | ⏳ | `signatureSeeds` + `ENGINE_QA_SEEDS` em `test/support/signature.ts` (PR #52; #60 fechada). Na re-execução o QA roda as suítes de falha com uma lista própria |
| R2 — limiar na média | ✅ | ⏳ | `effect()` em `test/support/signature.ts`; `test/support/signature.test.ts` |
| R3 — piso de 75% por seed | ✅ | ⏳ | idem |
| R4 — existência em toda seed | ✅ | ⏳ | `everySeed()`; condições de log/evento/`poolSize`/trace nas suítes |
| R5 — tetos só na média | ✅ | ⏳ | `ceiling()`; tetos de F-3 linhas 3, 4, 5, 7 e F-5 |
| R6 — seed sem exercício do alvo, só linha 3, teto ≤ 2% em ≥ 1 000 seeds por caso | ✅ | ⏳ | `exercised`/`exempt` no helper; bloco de teto em `connection_pool_exhaustion.test.ts` e `multi-fault.test.ts`; PRs #56, #47; escopo da Emenda 3 conferido (nenhuma outra suíte usa `exempt`) |
| E1 — uma das 8 métricas de S-1, agregado | ✅ | ⏳ | `assertEligibleF4` |
| E2 — pisos absolutos no baseline | ✅ | ⏳ | idem; `signature.test.ts` nos limites |
| E3 — erro % em p.p. (≥ +5 média, ≥ +3,75 por seed) | ✅ | ⏳ | idem |
| E4 — par fixo em todas as seeds | ✅ | ⏳ | idem; pares listados em F-4 |

### Sinais

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| S-1 | ✅ | ⏳ | `test/properties/coherence.test.ts`, `test/sim/metrics.test.ts`; PRs #13, #38 |
| S-2 | ✅ | ⏳ | `test/sim/logs.test.ts`, `test/properties/coherence.test.ts` (chaves de `attrs`, vocabulário fechado); PRs #17, #38 |
| S-3 | ✅ | ⏳ | `test/sim/traffic.test.ts`, `test/properties/coherence.test.ts`; PRs #25, #31, #38 |
| S-4 | ✅ | ⏳ | `test/sim/simulation.test.ts` (2 noises, byte-idêntico sem eventos); PRs #26, #34, #40 |
| S-5 | ✅ | ⏳ | `grep -rniE "launch-day\|0[1-8]-[a-z]" packages/engine/src` vazio (conferido em `c6cec55`); `test/properties/seed-variation.test.ts`; PR #47 |

### Coerência (propriedade do Gate 1)

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| P-1 | ✅ | ⏳ | `test/properties/coherence.test.ts` (≥ 100 seeds × baseline + 6 kinds × 30 ticks); PR #38 |
| P-2 | ✅ | ⏳ | idem |
| P-3 | ✅ | ⏳ | idem |
| P-4 | ✅ | ⏳ | `scripts/verify-coherence.mjs` (sem import de `src/`), passo P-4 de `ci-engine.sh` nos 6 kinds a 60 ticks; PRs #19, #49. O QA roda de novo sobre `$CLI simulate --seed qa --fault <kind> --ticks 60` |

### Perguntas (`ask`)

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| Q-1 | ✅ | ⏳ | `test/questions/ask.test.ts`; `grep -rniE "junior\|pleno\|senior\|playerLevel" packages/engine/src` vazio (conferido em `c6cec55`); PR #35 |
| Q-2 | ✅ | ⏳ | `test/questions/ask.test.ts` contra a tabela de `tickCost` da ADR-006; PR #35 |
| Q-3 | ✅ | ⏳ | `test/questions/ask.test.ts` (20 perguntas em 60 ticks), `test/sim/store.test.ts` (ADR-010); PRs #28, #35, #51 |
| Q-4 | ✅ | ⏳ | `test/questions/dashboard.test.ts`; PR #11 |
| Q-5 | ✅ | ⏳ | `test/questions/logs.test.ts`; PR #11 |
| Q-6 | ✅ | ⏳ | `test/questions/trace.test.ts` (desempate #21), `test/properties/coherence.test.ts` (simulação real × 6 kinds); PRs #10, #35, #38 |
| Q-7 | ✅ | ⏳ | `test/questions/whatChanged.test.ts`; PR #11 |
| Q-8 | ✅ | ⏳ | `test/questions/compare.test.ts`, `test/questions/ask.test.ts` (`lastWeek` ≥ `now`, seed derivada); PRs #10, #35 |
| Q-9 | ✅ | ⏳ | `test/questions/askNpc.test.ts`; PR #16. Risco para a fase 2 registrado em "Pendências não bloqueantes" |
| Q-10 | ✅ | ⏳ | `test/questions/validate.test.ts`, `test/errors.test.ts`; PR #35 |

### Determinismo

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| D-1 | ✅ | ⏳ | Passo D-1 de `ci-engine.sh` (baseline + 6 kinds, seed `gate1`, 120 ticks, 2 processos); `test/cli/main.test.ts` (`spawnSync`); PRs #33, #49, #57. Na re-execução o QA compara também o hash do `$CLI` do repo com o do CLI instalado a partir do tarball |
| D-2 | ✅ | ⏳ | Passo D-2 de `ci-engine.sh` (`TZ=UTC LANG=C` × `TZ=Asia/Tokyo LANG=pt_BR.UTF-8`); PR #49 |
| D-3 | ✅ | ⏳ | `packages/engine/fixtures/*.ndjson` = 7 arquivos (baseline + 6 kinds; `fixtures/answers/` não conta, Emenda 1); `test/fixtures.test.ts` regenera e compara byte a byte, teto 3 MiB (ADR-005 Emenda 2); PR #53 |
| D-4 | ✅ | ⏳ | `grep` de D-4 em `packages/engine/src` vazio (conferido em `c6cec55`); `no-restricted-properties`/`no-restricted-globals` em `eslint.config.js`; `test/boundaries.test.ts`; PRs #3, #8 |
| D-5 | ✅ | ⏳ | Imports de `src/cli/*.ts` em `c6cec55`: só `node:util`, `node:process` e módulos relativos da biblioteca; nenhum `node:http`, `node:https`, `node:net`, `node:dgram`, `node:fs` nem `fetch` em `src/`; sem flag de arquivo de saída (ADR-007) |
| DET (por tarefa) | ✅ | ⏳ | Cada tarefa T1.n traz o seu teste de determinismo, conferido no comentário QA do PR (`FASE-1.tasks.md`, "Critérios de aceite por tarefa") |

### CLI

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| CLI-1 | ✅ | ⏳ | `test/cli/main.test.ts` (baseline 10 ticks, `type` ∈ {metric, log, span, event}); PR #33 |
| CLI-2 | ✅ | ⏳ | `test/cli/main.test.ts`, `test/cli/args.test.ts`; rodada manual do QA no PR #33. O QA repete: 6 kinds com padrão, 1 sobrescrita, 2 falhas, todos com D-1 |
| CLI-3 | ✅ | ⏳ | Passo CLI-3 de `ci-engine.sh`; `test/cli/main.test.ts`; PRs #33, #49 |
| CLI-4 | ✅ | ⏳ | Passo CLI-4 de `ci-engine.sh`; PRs #18, #33, #49 |
| CLI-5 | ✅ | ⏳ | Passo CLI-5 de `ci-engine.sh` (`timeout 10`, 360 ticks, 6 kinds); PR #49 |

### Empacotamento e publicação ("CLI publicado")

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| PUB-1 | ✅ | ⏳ | `scripts/pack-smoke.sh` no CI (`pnpm --dir packages/engine pack`, `npm install` fora do repo, `npx whodeployed-engine simulate --seed pub --fault connection_pool_exhaustion --ticks 30`, SHA-256 igual ao `$CLI`); PR #49; comando conforme ADR-007 Emenda 2 e PRD Emenda 3 |
| PUB-2 | ✅ | ⏳ | `pack-smoke.sh` confere entradas e campos; `package.json`: `license` Apache-2.0, `bin.whodeployed-engine`, `files` = `dist`, `README.md`, `LICENSE`, versão `0.1.0-alpha.0`, sem `private`, `dependencies` vazio (conferido em `c6cec55`). A checagem de `.tgz` dentro de `dist/` é da T1.29 (ADR-009, "Consequências") |
| PUB-3 | ✅ | ⏳ | `packages/engine/README.md`; PR #54 (reprovado, depois aprovado; #61 fechada). O QA roda de novo cada bloco de comando verbatim |
| PUB-4 | ⏳ pendente / ⚠️ | ⏳ | **T1.29 não mergeada; nenhum PR da T1.29 aberto em 2026-10-26** (`gh pr list --state all`: último PR é o #71). Escopo da T1.29 (ADR-009 revista, PR #71): tarball gerado em CI por `pnpm --dir packages/engine pack --pack-destination dist/`, anexado como artifact do workflow, comando no README e teste de instalação isolada. O GitHub Release e a tag `engine-v0.1.0` são do agente Release, depois do gate. Ver "Divergências para decisão do Diretor", item 1 |

### Qualidade e CI

| ID | Resultado por PR | Re-execução | Evidência |
| --- | --- | --- | --- |
| QC-1 | ✅ | ⏳ | Thresholds na config (`vitest.config.ts`, l. 5 e 23–26); `test` = `vitest run --coverage` |
| QC-2 | ✅ | ⏳ | `.github/workflows/ci.yml`: install com lockfile → lint → typecheck → test (cobertura) → build → `ci-engine.sh` (D-1, D-2, CLI-3, CLI-4, CLI-5, P-4) → `pack-smoke.sh` (PUB-1, PUB-2). Últimos runs em `main` verdes (`gh run list --branch main`); o run final entra na re-execução |
| QC-3 | ✅ | — | `gh api repos/jeffersonvalente/Whodeployed/branches/main/protection` em 2026-10-26: `required_status_checks.contexts = ["check"]`, `enforce_admins.enabled = true` |

### Gate

| ID | Resultado | Evidência |
| --- | --- | --- |
| G-1 | ✅ | Tabela de dois leitores preenchida em `docs/gates/GATE-0.md` (júnior: sim; sênior: sim), registrada em 2026-10-26; PRs #7 e #70. O feedback do sênior ("batido") fica como risco de posicionamento para o Release |

## Tarefas da fase (rastreabilidade)

| Tarefa | PR | Merge | Tarefa | PR | Merge |
| --- | --- | --- | --- | --- | --- |
| T1.1 | #3 | `0f35895` | T1.20 | #34 (+#50) | `496fc7f` |
| T1.2 | #8 | `4904b51` | T1.21 | #37 | `4fc7603` |
| T1.3 | #14 | `9db1f76` | T1.22 | #40 | `b5904d4` |
| T1.4 | #20 | `229cd0f` | T1.23 | #33 (+#57) | `b938f1f` |
| T1.5 | #12 | `00fa342` | T1.24 | #38 | `b083c67` |
| T1.6 | #13 | `17ac671` | T1.25 | #47 | `988c61e` |
| T1.7 | #17 | `4a28b87` | T1.26 | #49 | `573b774` |
| T1.8 | #9 | `07be68a` | T1.27 | #53 | `112984b` |
| T1.9 | #11 | `9af9269` | T1.28 | #54 | `7215960` |
| T1.10 | #10 | `d339758` | **T1.29** | **— (pendente)** | — |
| T1.11 | #16 | `bac638c` | T1.30 | #30 | `773c1bc` |
| T1.12 | #18 | `e395459` | T1.31 | #28 | `4f9357d` |
| T1.13 | #19 | `ea130c4` | T1.32 | #31 | `40d7a21` |
| T1.14 | #25 | `4a2c6cb` | T1.33 | #52 | `c7d1a96` |
| T1.15 | #26 | `cdbc149` | T1.34 | #65 | `fe9fb47` |
| T1.16 | #35 (+#51) | `2b26f1e` | T1.35 | #69 | `ce9a490` |
| T1.17 | #32 | `dd135be` | T1.36 | #59 | `eb1b8d6` |
| T1.18 | #36 | `a3ae8c4` | T1.37 | #56 | `c71fb4e` |
| T1.19 | #43 | `97e5c9d` | | | |

Documentos da fase: PRD #1, Emenda 1 #42, Emenda 2 #46, Emenda 3 #68; Arquitetura #2, #27, #48, #55, #67, #71; ADR-009 #4 (revista em #71); G-1 #7, #70.

## Divergências para decisão do Diretor

O QA registra; não decide.

### 1. PUB-4 × B-1 (levantada pelo Arquiteto no PR #71)

- **PUB-4** (PRD) exige o pacote "disponível publicamente no canal decidido pelo Diretor" e a instalação a partir desse canal.
- **B-1** (PRD, "Bloqueios") diz que o Gate 1 "só pode ser aprovado com PUB-4 resolvido ou com dispensa registrada pelo Diretor em `GATE-1.md`".
- **ADR-009 revista** (PR #71): o GitHub Release e a tag `engine-v0.1.0` são do agente Release, **depois** do GATE-1 aprovado. A T1.29 entrega só o artifact de CI.

Do jeito que os textos estão, PUB-4 não pode fechar antes do gate. Saídas possíveis:

| Opção | O que é | Quem age | Efeito no gate |
| --- | --- | --- | --- |
| (i) Emenda do PM | PUB-4 passa a ser verificado contra o artifact de CI da T1.29 (mesmos bytes do futuro asset), e a publicação no canal vira passo do Release depois do gate, com o mesmo roteiro. O texto proposto está no corpo do PR #71. B-1 passa a "resolvido pela ADR-009" | PM (PR no PRD) | PUB-4 vira verificável pelo QA na re-execução (baixar o artifact do run de CI do `main` final e repetir o roteiro de PUB-1) |
| (ii) Dispensa do Diretor | O Diretor registra em "Decisão do Diretor" deste arquivo a dispensa da parte "disponível publicamente" de PUB-4 até o Release | Diretor | PUB-4 fica dispensado no gate; o QA ainda verifica o roteiro contra o artifact de CI como evidência |

### 2. Versão do pacote × tag combinada (do PR #71)

`packages/engine/package.json` está em `0.1.0-alpha.0`; a tag combinada na ADR-009 é `engine-v0.1.0`. PUB-2 só exige SemVer ≠ `0.0.0`, então não há critério violado. Falta decidir quem muda a versão do pacote (para `0.1.0` ou outra) e em que commit: o Diretor ou o Release, no commit da tag. Enquanto não mudar, o tarball do artifact da T1.29 sai como `whodeployed-engine-0.1.0-alpha.0.tgz`, e o asset do Release teria nome e versão diferentes da tag.

## Pendências não bloqueantes

Nenhuma destas viola critério do PRD da fase 1.

1. **Issue #24 (aberta, `needs-architect`).** Pontos não bloqueantes do QA das ondas 1 a 4. Ainda sem marcação de decidido: lista pública de `index.ts` na ADR-002 §2 (vira contrato SemVer quando publicada); revalidação de `faults` em `createSimulation`; limite de `ticks` não registrado em ADR; `ctx` compartilhado entre falhas compostas; ciclo ESM `ask.ts` ↔ `sim/simulation.ts`; códigos de erro de `by`/`filter`/chave extra não registrados na ADR-006; igualdade de `Answer.question` com `filter: undefined`; `--ticks` alto estoura a memória (100 000 ticks: exit 134) contra a faixa `1..100000` da ADR-007; texto da ADR-004 sobre o sinal do `cache_cold_start` ainda citando p95; default de `bad_deploy` no `gateway` a confirmar. Itens já resolvidos por PR e ainda sem marca na issue: redação de D-3 (Emenda 1), leitura de ≥ 10 seeds e F-4 com ruído (Emenda 2), #41, #44, `it.todo` do `Answer` (PR #51), pontos da T1.14 (decididos em #27 e T1.32). Recomendação do QA: o Arquiteto atualiza a issue antes da fase 2; nada aqui bloqueia o gate.
2. **Risco do `askNpc` no baseline, para a fase 2** (PRD, "Riscos específicos da fase"; QA do #35 em #24). Sem falha, `askNpc` devolve pelo menos um hint em 45/50 seeds (`dev`), 49/50 (`dba`) e 50/50 (`oncall`). Q-9 e SPEC §3.4 não são violados, mas na fase 2 a pergunta mais cara (`tickCost` 3, nível Sênior) pode virar ruído puro. Entrada para o PRD da fase 2 decidir (limiar ou normalização na ADR-006).
3. **Ingress sem jitter** (ADR-002 Emenda 1 §5.1): RPS do `gateway` plano no baseline, risco de padrão decorável (SPEC §11), também deixado para o PRD da fase 2.
4. **Para o Eng. Conteúdo (fase 3)**, sem ser critério desta fase: os cenários 3 e 8 precisam de seed em que o alvo recebe request na janela (PRD Emenda 3, R6); o exemplo de SPEC §7 (`leakPerTick: 2`, alerta no tick 18) só esgota o pool no tick 21 (`FASE-1.tasks.md`, Notas da Emenda 2).
5. **Issue #64** (ponto de retomada da fase) segue aberta; operacional, sem critério associado.

## Princípios (SPEC §3)

Verificação preliminar em `c6cec55`, por leitura e `grep`; a confirmação por comando entra na re-execução.

| # | Princípio | Resultado | Como foi verificado nesta fase |
| --- | --- | --- | --- |
| 1 | A mecânica é a habilidade | ✅ | O motor só gera sinais e responde perguntas; nenhum ponto, XP ou narrativa em `src/`; `askNpc` devolve dado estruturado sem prosa (Q-9, PR #16). |
| 2 | Progressão = perguntas, não ferramentas | ✅ | Os 6 `kind` de `Question` respondem desde o tick 0 sem parâmetro de nível (Q-1); `grep` de `junior\|pleno\|senior\|playerLevel` em `src/` vazio; o custo é só `tickCost` (ADR-006). |
| 3 | Telemetria gerada, nunca roteirizada | ✅ | PRNG seedado por streams (ADR-003); métricas derivadas dos spans (P-1/P-2) e verificadas por script independente (P-4); `grep` de S-5 e de D-4 vazio; seeds diferentes dão hashes diferentes (`seed-variation.test.ts`). |
| 4 | Sinais mentem como na vida real | ✅ | F-4 com par fixo elegível em cada kind (sinal fora do alvo); F-5 (agregado esconde instância); linha 3 (p50 do `gateway` ≤ 1,5× com p95 subindo); linha 5 (quem grita não é o alvo); linha 7 (p50 sobe, p95 mal se mexe). |
| 5 | Mitigar é válido sem root cause | ✅ | Efeito das `Action`s está fora da fase 1 (PRD); `Action` está no contrato com os 6 `kind` (CT-1), e nada no motor impede mitigação na fase 2. |
| 6 | Web-first, zero instalação | ✅ | Biblioteca sem import externo nem built-in (CT-3); `dependencies` vazio; CLI só com `node:util`/`node:process`, saída só em stdout/stderr; nenhum backend, rede ou telemetria do jogador. |
| 7 | Conteúdo é dado | ✅ | Sistema, falhas e noise são entrada do motor (W-3, S-4); parâmetros de falha em catálogo (`src/faults/catalog.ts`, ADR-004); nenhum id, título ou texto de cenário em `src/` (S-5). |
| 8 | Escopo pequeno e público | ✅ | 37 tarefas ≤ 1 dia, todas em PR público com QA; motor com CLI e tarball reprodutível (PUB-1); a publicação do canal depende da divergência 1 acima. |

## Escopo (SPEC §4)

- Só o `default-shop` com os 9 componentes (W-1); só as 8 métricas de S-1, logs estruturados, traces simplificados (formato próprio, não OTLP) e eventos de deploy/config.
- `grep -rniE "slo|otlp|opentelemetry|burn.?rate|hit.?rate|grafana|datadog" packages/engine/src` só encontra falsos positivos (`slow_dependency`, `slot`); nenhum conceito fora de SPEC §4.
- `apps/web` e `packages/scenarios` não foram tocados na fase 1 (`git log -- apps packages/scenarios`: último commit `c07d262`, fase 0).
- Nenhuma UI, i18n, backend, alerta, SLO ou integração externa.

## Re-execução no main final

Pendente: aguarda o merge da T1.29 e o aviso de que o `main` é final.

Roteiro, num checkout limpo do SHA final, com Node 22 e o pnpm de `packageManager`:

1. `pnpm install --frozen-lockfile`
2. `pnpm -r --if-present run lint` e `pnpm -r --if-present run typecheck` (CT-2, CT-3, D-4)
3. `pnpm --filter ./packages/engine test` com cobertura (QC-1: os 4 números de `sim` e `faults`), e as suítes de falha com `ENGINE_QA_SEEDS` de uma lista própria do QA (R1)
4. `pnpm --filter ./packages/engine build`
5. Determinismo: `bash packages/engine/scripts/ci-engine.sh` (D-1, D-2, CLI-3, CLI-4, CLI-5, P-4) e, à parte, `$CLI simulate --seed gate1 --fault <kind> --ticks 120 | sha256sum` duas vezes por kind e para o baseline, comparado à mão
6. P-4: `verify-coherence.mjs` sobre `$CLI simulate --seed qa --fault <kind> --ticks 60` nos 6 kinds
7. CLI-2: 6 kinds com padrão, 1 sobrescrita, 2 falhas; todos exit 0 e com D-1
8. Pack e instalação: `bash packages/engine/scripts/pack-smoke.sh` (PUB-1, PUB-2); `pnpm --dir packages/engine pack --pack-destination dist/` em build limpo, duas vezes, comparando o SHA-256 do tarball; `npm install` do tarball num diretório vazio fora do repo e hash do CLI instalado igual ao do `$CLI` do repo (seed `pub` e seed `gate1`)
9. PUB-4: artifact do run de CI do SHA final, baixado e instalado num diretório vazio, com o roteiro de PUB-1
10. PUB-3: cada bloco de comando de `packages/engine/README.md` verbatim
11. `gh run list --branch main` no SHA final (QC-2)

| Passo | Comando | Saída resumida | Resultado |
| --- | --- | --- | --- |
| — | — | — | ⏳ |

## Recomendação

**Pendente da re-execução no main final.** Esta seção só é escrita depois de todos os comandos acima rodarem no SHA final do `main`, com as saídas registradas na tabela da seção anterior.

## Decisão do Diretor

