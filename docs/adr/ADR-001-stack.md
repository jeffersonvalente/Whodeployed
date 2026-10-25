# ADR-001 — Stack técnica e estrutura do monorepo

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Diretor
- **Referência:** SPEC §6

## Contexto

O projeto precisa de (a) um motor de simulação determinístico reaproveitável fora do jogo, (b) conteúdo em dados editável por não-programadores, (c) um jogo que roda no browser sem backend e sem instalação, publicado em GitHub Pages. O autor é engenheiro de plataforma, não game dev; a stack deve minimizar atrito e maximizar testabilidade.

## Decisão

| Camada | Escolha | Motivo |
| --- | --- | --- |
| Linguagem | TypeScript 5, `strict: true` | Um idioma do motor ao browser; tipos são o contrato entre pacotes |
| Monorepo | pnpm workspaces | Leve, rápido, sem tooling extra |
| Testes | Vitest | Mesmo bundler do Vite; cobertura nativa |
| Build web | Vite | Site estático trivial; deploy em Pages |
| UI | React + SVG/Canvas para o mapa | Equipe conhece React; Phaser só se a fase 3 provar necessidade (ADR própria) |
| Validação de cenário | JSON Schema (`ajv`) sobre YAML (`yaml`) | Erro legível em CI; schema serve de documentação |
| CLI do motor | `tsx` + `commander` | Zero cerimônia |
| Estado do jogador | `localStorage` | Sem backend por princípio (SPEC §3.6) |
| Aleatoriedade | PRNG seedado próprio (mulberry32 ou xoshiro) | Determinismo byte-idêntico por seed (SPEC §3.3) |
| CI | GitHub Actions: lint, test, validate, build | Bloqueia merge |
| Deploy | GitHub Pages via Actions | Zero custo |

Estrutura:

```
packages/engine      sem dependências de runtime
packages/scenarios   depende de engine (tipos)
apps/web             depende de engine e scenarios
```

## Consequências

- O motor é publicável como pacote npm independente a partir da fase 1 (release útil mesmo sem jogo).
- Qualquer decisão de UI que exija Phaser, WebGL ou assets pesados precisa de ADR nova.
- Sem backend significa sem leaderboard, sem analytics automático. Métricas de aprendizado vêm de export voluntário (SPEC §10).

## Alternativas descartadas

- **Godot exportando para web:** curva para quem não é game dev; pior integração com testes e CI; motor ficaria preso ao engine.
- **Python/Textual (TUI):** não roda no browser sem instalação; fere SPEC §3.6.
- **Backend (Next.js, Supabase):** fere SPEC §3.6 e adiciona custo e manutenção sem ganho na v0.x.
