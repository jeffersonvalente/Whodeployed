# ADR-009 — Canal de publicação do motor (B-1)

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Diretor (Jefferson Valente)
- **Referência:** SPEC §8 (Gate 1, "CLI publicado"); PRD FASE-1 B-1, PUB-4; ADR-007

## Contexto

O PRD da fase 1 deixou bloqueado para o Diretor o canal onde o CLI do motor é "publicado" (B-1): registry npm público, GitHub Release do repositório, ou outro. Publicar em registry externo cria identidade e credencial pública do projeto, o que não está entre as decisões delegadas de SPEC §12.

## Decisão

O motor é publicado como **tarball anexado a um GitHub Release** do repositório `jeffersonvalente/Whodeployed` (opção b de B-1). O repositório é público, então o Release e o download do asset não têm custo.

- O asset é o tarball gerado por `pnpm --filter ./packages/engine pack` (o mesmo de PUB-1).
- PUB-4 é verificado instalando a partir da URL do asset do Release (`npm install <url-do-tarball>`) num diretório vazio e repetindo o roteiro de PUB-1.
- O nome `@whodeployed/engine` permanece provisório: não há registro no npm, então não há escopo a reservar nem conta a criar nesta fase.
- A criação do Release e da tag é feita pelo papel Release após o Gate 1 aprovado, ou pela T1.29 como pré-release, conforme `docs/prd/FASE-1.tasks.md`.

## Consequências

- Nenhuma credencial de registry externo é necessária na v0.1.
- Instalação pública exige a URL do asset, não `npm install @whodeployed/engine`. Publicar no npm passa a exigir nova ADR do Diretor.
- B-1 está resolvido; T1.29 e PUB-4 ficam desbloqueados.

## Alternativas descartadas

- **Registry npm público:** exige conta e escopo; sem ganho para a v0.1 além de um comando de instalação mais curto.
