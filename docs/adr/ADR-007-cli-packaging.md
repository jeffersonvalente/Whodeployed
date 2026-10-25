# ADR-007 — CLI, fronteira da biblioteca e empacotamento (zero dependências de runtime)

- **Status:** aceita
- **Data:** 2026-10-25
- **Decisor:** Arquiteto (decisão delegada, SPEC §12: "estrutura interna do motor"). Refina ADR-001 sem alterá-la; o Diretor pode vetar no PR.
- **Referência:** SPEC §3.6, §6; ADR-001; PRD CT-3, D-5, CLI-1..CLI-5, PUB-1..PUB-4, P-4, B-1

## Contexto

ADR-001 diz, ao mesmo tempo, "`packages/engine` sem dependências de runtime" e "CLI do motor: `tsx` + `commander`". O PRD (CT-3) exige que a biblioteca não importe nada externo nem built-in do Node, deixando para ADR a localização do CLI, a sintaxe de sobrescrita do `--fault` (CLI-2), uma eventual flag de arquivo de saída (D-5) e o comando `$CLI`. O canal de publicação (B-1) é do Diretor.

## Decisão

### Leitura de CT-3 e de ADR-001

A restrição estrutural de ADR-001 ("sem dependências de runtime") prevalece sobre o item de ferramenta ("`commander`"), porque é ela que garante a biblioteca usável no browser e o pacote instalável sem árvore de dependências. Portanto:

- `package.json` do engine tem **`dependencies` vazio**. `commander` não é usado.
- Biblioteca = `packages/engine/src/**` **exceto** `src/cli/**`. Só imports relativos (CT-3), só `import type` de `types.ts`.
- CLI = `packages/engine/src/cli/` (`main.ts`, `args.ts`, `help.ts`). Pode importar a biblioteca e **apenas** os built-ins `node:util` (`parseArgs`, que cobre o que `commander` daria com zero cerimônia) e `node:process`. Proibidos `node:http`, `node:https`, `node:net`, `node:dgram`, `node:fs`, `fetch` (D-5).
- `tsx` fica como devDependency, só para o script de desenvolvimento `dev:cli`; nada publicado depende dele.

### Build, bin e `$CLI`

- ESM (`"type": "module"`), `tsc -p tsconfig.build.json` emite `dist/` (JS + `.d.ts`); imports relativos com extensão `.js` (NodeNext).
- Nome do binário: **`whodeployed-engine`**, `bin` → `dist/cli/main.js` (com shebang `#!/usr/bin/env node`).
- **`$CLI` do PRD** = `node packages/engine/dist/cli/main.js`, depois de `pnpm --filter ./packages/engine build`. É o mesmo código que o tarball publica, o que torna a comparação de PUB-1 direta. (`pnpm run` não serve como `$CLI` porque imprime cabeçalho no stdout.)
- Nome provisório do pacote: `@whodeployed/engine`, versão `0.1.0-alpha.0`, `"license": "Apache-2.0"`, sem `private`. O nome definitivo depende de B-1 e muda só o campo `name`; o `bin` não muda.
- `files`: `["dist", "README.md", "LICENSE"]` (PUB-2). `dist/` não contém testes porque `tsconfig.build.json` inclui só `src/`.

### Interface do CLI

```
whodeployed-engine simulate --seed <string> --ticks <int> [--fault <spec>]...
whodeployed-engine --help | simulate --help
```

- `--seed` e `--ticks` obrigatórios; `--ticks` inteiro em `1..100000`.
- **Sintaxe de `--fault` (CLI-2):** `<kind>[:<key>=<value>[,<key>=<value>]...]`. Chaves reservadas: `target` (string) e `startTick` (inteiro); qualquer outra chave é parâmetro do kind (número). Exemplos: `--fault connection_pool_exhaustion`, `--fault 'connection_pool_exhaustion:target=cart,startTick=5,poolSize=10'`. `--fault` repetido = falhas simultâneas (F-6), na ordem dada. Valor numérico inválido, chave desconhecida ou fora de faixa → erro de uso com a lista válida (via `resolveFaults`, ADR-004).
- Saída: NDJSON canônico (ADR-005) só no **stdout**. **Não há flag de arquivo de saída** (D-5): quem quer arquivo redireciona.
- Erros (CLI-3): `EngineError` → mensagem no stderr, nada no stdout, exit **2** para erro de uso/validação; exit **1** para erro interno inesperado. A validação completa acontece antes da primeira linha ser escrita.
- `--help` (CLI-4) lista `--seed`, `--fault`, `--ticks`, a sintaxe de `--fault` e, gerado do catálogo, os 6 kinds com alvo, `startTick` e parâmetros padrão com faixas.

### Scripts fora da biblioteca

`packages/engine/scripts/` (não publicado, fora de `src/`): `verify-coherence.mjs` (P-4, ADR-005), `gen-fixtures.mjs` (D-3), `pack-smoke.sh` (PUB-1: `pnpm pack`, instala o tarball com `npm install` num diretório temporário fora do repo, roda `npx whodeployed-engine simulate --seed pub --fault connection_pool_exhaustion --ticks 30` e compara SHA-256 com `$CLI`).

### Publicação (B-1)

Esta ADR **não** escolhe canal, nome definitivo nem conta. Só PUB-4 depende de B-1; PUB-1..PUB-3 usam o tarball local.

## Consequências

- O pacote instala sem baixar nada além dele mesmo; a biblioteca roda no browser sem polyfill.
- Um parser próprio sobre `parseArgs` é ~100 linhas testáveis como função pura (`ParseCliArgs` em `types.ts`).
- Se o Diretor preferir manter `commander`, a alternativa compatível é empacotá-lo no build (bundling), mas isso exige ADR nova e uma ferramenta de bundle.

## Alternativas descartadas

- **`commander` como `dependency`:** contradiz "sem dependências de runtime" de ADR-001.
- **`commander` como devDependency + bundler (esbuild/tsup):** adiciona ferramenta e passo de build sem ganho funcional sobre `node:util.parseArgs`.
- **CLI em pacote separado (`packages/engine-cli`):** o PRD pede `$ENGINE` com CLI e um só tarball (PUB-1); dois pacotes dobram empacotamento e publicação.
- **Flag `--out <file>`:** traria `node:fs` ao CLI sem necessidade; redirecionamento do shell resolve.
