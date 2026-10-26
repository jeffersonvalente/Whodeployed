# GATE-0 — Fundação

- **Fase encerrada:** 0 — Fundação
- **Libera:** Fase 1 — Motor
- **Data do relatório:** 2026-10-25
- **Relator:** agente (sessão de bootstrap, atuando como QA)

## Critérios do gate (SPEC §8, fase 0)

| Critério | Resultado | Evidência |
| --- | --- | --- |
| README existe e responde "o que é, pra quem, como rodar, como contribuir" em ≤ 1 tela | ✅ | `README.md` — seções What/Who/Running/Contributing acima da dobra |
| LICENSE Apache-2.0 | ✅ | `LICENSE` (texto oficial, 201 linhas) |
| CONTRIBUTING esboço | ✅ | `CONTRIBUTING.md` — fluxo de cenário sem código, regras de PR, o que não mergeamos |
| Repo público | ✅ | `github.com/jeffersonvalente/whodeployed` |
| SPEC em `/SPEC.md` | ✅ | `SPEC.md` v1.0, 12 seções, diagramas em Mermaid |
| ADR-001 (stack) | ✅ | `docs/adr/ADR-001-stack.md` |
| **Gate 0 (SPEC §8 roadmap): duas pessoas leem o README e entendem o que é** | ⬜ pendente | Requer dois leitores humanos externos. Registrar nomes/handles e data abaixo. |

## Princípios (SPEC §3) — como a fase 0 os protege

| # | Princípio | Verificação |
| --- | --- | --- |
| 1 | Mecânica é a habilidade | README e CONTRIBUTING dizem explicitamente o que o jogo NÃO é; "What we won't merge" cobre feature sem cenário |
| 2 | Progressão = perguntas | README explica a tese; `eng-ui.md` proíbe esconder sinal |
| 3 | Telemetria gerada | `eng-motor.md` exige determinismo e proíbe `Math.random()`; PR template cobra |
| 4 | Sinais mentem | `eng-conteudo.md` torna `trap` obrigatório; issue template pede o trap |
| 5 | Mitigar sem root cause | `eng-conteudo.md` exige que cenários 7–8 mitiguem antes de diagnosticar |
| 6 | Web-first, zero backend | ADR-001; CLAUDE.md; PR template |
| 7 | Conteúdo é dado | `eng-conteudo.md`; issue template de cenário para não-devs |
| 8 | Escopo pequeno e público | Repo público no dia 0; CHANGELOG aberto |

## Recomendação

**APROVAR condicionado** ao critério pendente: dois leitores externos confirmam que entenderam o que é o projeto só pelo README. Sugestão: mandar o link para um júnior e para um sênior e anotar aqui a reação em uma linha cada.

## Decisão do Diretor

**APROVADO** — 2026-10-25, Jefferson Valente.

Fase 1 (Motor) liberada. O critério "dois leitores externos do README" fica registrado como pendência não bloqueante: o Diretor assume o risco e se compromete a coletar as duas leituras antes do Gate 1; o resultado será anotado abaixo.

| Leitor | Perfil | Entendeu o que é? | Observação |
| --- | --- | --- | --- |
| leitor 1 (anônimo) | júnior | sim | achou legal |
| leitor 2 (anônimo) | sênior | sim | achou meio estranho e batido |

Critério de leitura do README cumprido em 2026-10-26. O feedback do sênior (‘batido’) fica registrado como risco de posicionamento para o agente Release revisitar no post de lançamento (SPEC §11).
