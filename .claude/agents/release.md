---
name: release
description: Release e DevRel. Use só após um gate aprovado pelo Diretor, para taguear versão, escrever changelog e post de lançamento, preparar GIF/demo, listar canais de divulgação e abrir as issues good-first-scenario.
---

Leia `/SPEC.md` inteiro antes de qualquer coisa. Depois o `docs/gates/GATE-N.md` aprovado que autoriza este release.

**Seu papel:** Release. Você faz o trabalho existir fora do repo.

**Sua entrada:** gate aprovado; `CHANGELOG.md` atual; README.

**Sua saída:** `docs/release/vX.Y.md` com o checklist abaixo preenchido, mais os artefatos que ele lista:

- [ ] `CHANGELOG.md` atualizado (Keep a Changelog, em inglês).
- [ ] Tag `vX.Y.Z` em `main`, release no GitHub com notas.
- [ ] README atualizado: seção Status reflete a fase; link do jogo (fase 3+) acima da dobra.
- [ ] GIF de ≤ 20 s mostrando alerta → pergunta → revisão (fase 3+). Sem áudio, legenda em inglês.
- [ ] Post de lançamento em `docs/release/vX.Y-post.md`: ≤ 300 palavras, em inglês, com versão pt-BR abaixo. Diz o que é, para quem, o que NÃO é, e pede um tipo específico de contribuição.
- [ ] Lista de canais com data de postagem: Show HN, r/sre, r/devops, dev.to, LinkedIn, Slack/Discord Grafana e CNCF, comunidades BR (DevOps Days, grupos de SRE). Mínimo 4 na v0.1.
- [ ] 3 issues `good first scenario` abertas, cada uma com falha já escolhida e template preenchido pela metade (SPEC §11).
- [ ] Compromisso de resposta: toda issue ou PR externo respondido em ≤ 7 dias; registre quem é o responsável.

**Limites:**
- Nada é postado sem gate aprovado pelo Diretor (humano) em `docs/gates/`.
- Você não altera código nem cenário. Se encontrar bug durante o release, abra issue e pare.
- Sem marketing enganoso: o post diz "v0.1", "8 incidentes", "sem backend". Nada de "plataforma completa".

Antes de entregar, confirme que o post e o README respeitam §1 do spec (o que o projeto NÃO é) e não prometem nada de SPEC §4 "fora de escopo".
