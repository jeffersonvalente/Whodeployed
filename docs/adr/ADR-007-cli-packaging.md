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
- Nome provisório do pacote: `@whodeployed/engine`, versão `0.1.0` (publicada como `engine-v0.1.0`; até o release era `0.1.0-alpha.0`, ver Emenda 3), `"license": "Apache-2.0"`, sem `private`. O nome definitivo depende de B-1 e muda só o campo `name`; o `bin` não muda.
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

## Emenda 1 — 2026-10-25 (issue #24, #15, #22)

Implementação de tudo abaixo: T1.23.

- **Uma só classe de erro (#15):** `src/cli/args.ts` deixa de definir `CliUsageError` e lança o `EngineError` de `src/errors.ts` com `code: 'usage'`, para `instanceof EngineError` valer também nos erros de parse.
- **Exit 2 = todo `EngineError`:** qualquer `EngineError`, de qualquer código (`usage`, `invalid_seed` — seed vazia rejeitada por `buildWorld` —, `invalid_system`, os de F-7, ...), sai com exit 2, mensagem no stderr, stdout vazio. Qualquer outro erro (invariante interna, ADR-002 §7) sai com exit 1.
- **`params` sem protótipo (#22):** `parseFaultSpec` monta `params` com `Object.create(null)`, para que `--fault kind:__proto__=1` chegue a `resolveFaults` e falhe como `unknown_param` (ADR-004, Emenda 1). Um caso de teste.
- **Forma dos inteiros:** `--ticks` e `startTick` aceitam inteiro decimal com sinal opcional (`/^[+-]?\d+$/`); `--ticks +5` é 5 e `--ticks 007` é 7. Isso não afeta determinismo (o valor é o mesmo) e é a mesma regra de `startTick`; a faixa `1..100000` continua valendo. Não muda.

## Emenda 2 — 2026-10-25 (issue #58)

**Fato (reproduzido pelo Arquiteto):** com o pnpm fixado em `packageManager` (`pnpm@9.12.0`), `pnpm --filter ./packages/engine pack` sai com `ERROR Unknown option: 'recursive'`; `pnpm --dir packages/engine pack` gera `whodeployed-engine-0.1.0-alpha.0.tgz` (versão da época; hoje `whodeployed-engine-0.1.0.tgz`, Emenda 3). É o mesmo pacote e o mesmo tarball, e é o que `scripts/pack-smoke.sh` (T1.26) e o README (T1.28) já usam.

**Decisão:** o comando de empacotamento do motor é **`pnpm --dir packages/engine pack`** (opção (a) de #58). O pnpm não é atualizado: trocar `packageManager` muda o lockfile e a stack fixada na ADR-001, só para um comando que já tem forma equivalente. A convenção do PRD ("comandos pnpm usam filtro por caminho") continua valendo para `build`, `test`, `lint` etc.; `pack` é a exceção, porque no pnpm 9.12 ele não é um comando recursivo.

**Quem altera o texto:** PUB-1 em `docs/prd/FASE-1.md` é do PM; a linha "O asset é o tarball gerado por `pnpm --filter ./packages/engine pack`" da ADR-009 é do Diretor (decisor da ADR-009). O texto proposto para os dois está no PR desta emenda. Enquanto não mudarem, o QA lê o comando de PUB-1 e o da ADR-009 como `pnpm --dir packages/engine pack`, por esta emenda. Nenhum código muda.

## Emenda 3 — 2026-10-26 (decisão do Diretor; #64)

**Fato:** o Release publicou `engine-v0.1.0` (commit `d22fba5`, PR #74). `packages/engine/package.json` passou de `0.1.0-alpha.0` para **`0.1.0`**, e o asset do GitHub Release é `whodeployed-engine-0.1.0.tgz`. As menções a `0.1.0-alpha.0` acima foram atualizadas para a versão publicada; onde o texto registra uma medição feita antes do release (Emenda 2), o valor antigo fica, marcado como versão da época.

**Decisão do Diretor (2026-10-26):** "atualizar a ADR-007 para a versão publicada e incluir a versão no nome do artifact de CI (whodeployed-engine-<version>)."

- O artifact de CI da T1.29 (ADR-009) passa de `whodeployed-engine-tarball` para **`whodeployed-engine-<version>`**. `<version>` é lido de `packages/engine/package.json` no próprio job de CI (passo `engine-version` em `.github/workflows/ci.yml`), nunca fixado no YAML: quando a versão do pacote mudar, o nome do artifact muda junto, sem editar o workflow.
- O mesmo passo falha se `packages/engine/dist/whodeployed-engine-<version>.tgz` não existir, para que o nome do artifact e o nome do `.tgz` de dentro não divirjam.
- Não muda: `actions/upload-artifact` fixado por SHA, upload só de `packages/engine/dist/*.tgz`, comando de pack (Emenda 2), bytes do tarball, `bin`, `files`, `dependencies` vazio.
- Registros históricos (`docs/gates/GATE-1.md`, `docs/release/v0.1-engine.md`) citam o nome antigo e não são alterados. Isso fecha a nota do QA do PR #73 e o item 6 das divergências do GATE-1.

