# ADR-009 — Canal de publicação do motor (B-1)

- **Status:** aceita (2026-10-26)
- **Data:** 2026-10-25 (canal, B-1); revista em 2026-10-26 (comando do asset e divisão T1.29 / Release)
- **Decisor:** Diretor (Jefferson Valente). O canal (B-1) é decisão do Diretor. O comando do asset é decisão delegada (SPEC §12, "estrutura interna do motor"; ADR-007 Emenda 2), aprovada pelo Diretor em 2026-10-26: "ADR-009 aprovada: `pnpm --dir packages/engine pack --pack-destination dist/`. Marcar status 'aceita'; decisão delegada (SPEC §12)."
- **Referência:** SPEC §8 (Gate 1, "CLI publicado"); PRD FASE-1 B-1, PUB-1, PUB-2, PUB-4; ADR-007 (e Emenda 2); issue #58; PR #67

## Contexto

O PRD da fase 1 deixou bloqueado para o Diretor o canal onde o CLI do motor é "publicado" (B-1): registry npm público, GitHub Release do repositório, ou outro. Publicar em registry externo cria identidade e credencial pública do projeto, o que não está entre as decisões delegadas de SPEC §12.

A primeira versão desta ADR citava `pnpm --filter ./packages/engine pack`, que falha no pnpm 9.12 fixado em `packageManager` (`ERROR Unknown option: 'recursive'`; issue #58, ADR-007 Emenda 2). Ela também deixava aberto se a T1.29 criaria o Release como pré-release.

## Decisão

O motor é publicado como **tarball anexado a um GitHub Release** do repositório `jeffersonvalente/Whodeployed` (opção b de B-1). O repositório é público, então o Release e o download do asset não têm custo.

- O asset é o tarball gerado, a partir da raiz do repositório e depois do build, por exatamente:

  ```sh
  pnpm --dir packages/engine pack --pack-destination dist/
  ```

  É o comando de pack da ADR-007 Emenda 2 (`pnpm --dir packages/engine pack`, o mesmo pacote de PUB-1) com destino fixo. O tarball cai em **`packages/engine/dist/whodeployed-engine-<versão>.tgz`** (o destino é resolvido a partir do diretório do pacote, por causa do `--dir`; ver "Verificação").
- O nome `@whodeployed/engine` permanece provisório: não há registro no npm, então não há escopo a reservar nem conta a criar nesta fase.

### Quem faz o quê

- **T1.29 (Eng. Motor, fase 1) não publica GitHub Release nem cria tag.** Ela fecha com:
  1. o tarball gerado em CI pelo comando acima e anexado como **artifact do workflow** `whodeployed-engine-<version>`, com `<version>` lido de `packages/engine/package.json` em CI (não é Release, não é público fora do GitHub Actions; nome desde 2026-10-26, ADR-007 Emenda 3);
  2. o comando de pack documentado no `packages/engine/README.md`;
  3. teste de instalação isolada: num diretório limpo fora do repositório, `npm install` do tarball de `packages/engine/dist/*.tgz` e execução do CLI instalado (`npx whodeployed-engine simulate --seed pub --fault connection_pool_exhaustion --ticks 30`), com saída byte-idêntica à de `$CLI` com os mesmos argumentos (o roteiro de PUB-1).
- **Release (agente Release), só depois do `docs/gates/GATE-1.md` aprovado:** cria a tag `engine-v0.1.0` e o GitHub Release, com o tarball gerado pelo mesmo comando, no commit da tag, como asset. Repete o roteiro de PUB-1 instalando a partir da URL do asset (`npm install <url-do-asset>`) num diretório vazio.

### Verificação (Arquiteto, 2026-10-26, pnpm 9.12.0 via corepack, Node 22.23.4)

1. Num checkout limpo, `packages/engine/dist/` não existe antes do build (está no `.gitignore`). `pnpm --filter ./packages/engine build` cria `dist/` com o JS e os `.d.ts`.
2. `pnpm --dir packages/engine pack --pack-destination dist/` sai 0 e grava `packages/engine/dist/whodeployed-engine-0.1.0-alpha.0.tgz` (70 562 bytes, 71 entradas). Na raiz do repositório não aparece `dist/` nem `.tgz`.
3. Primeiro pack sobre `dist/` sem `.tgz`: o tarball **não** contém a si mesmo (nenhuma entrada `.tgz`).
4. `rm -rf packages/engine/dist`, build e pack de novo: SHA-256 idêntico ao do passo 2 (`9269ad66…3f6b45`). O tarball é reprodutível a partir de um build limpo.
5. Instalação isolada: diretório vazio fora do repo, `npm install ./whodeployed-engine-0.1.0-alpha.0.tgz`, `npx whodeployed-engine simulate --seed pub --fault connection_pool_exhaustion --ticks 30` → SHA-256 `a97830b7…8f978e91`, igual ao de `node packages/engine/dist/cli/main.js` com os mesmos argumentos.
6. **Conflito com o build:** rodar o pack de novo sem limpar `dist/` empacota o `.tgz` anterior, porque `dist` está em `files` (ADR-007). Medido: segundo pack com 72 entradas, `package/dist/whodeployed-engine-0.1.0-alpha.0.tgz` dentro, 143 579 bytes. Um `.tgz` de outra versão deixado em `dist/` também entra. O build (`tsc`) não limpa `dist/`, então o `.tgz` sobrevive a um novo build.

## Consequências

- Nenhuma credencial de registry externo é necessária na v0.1.
- Instalação pública exige a URL do asset, não `npm install @whodeployed/engine`. Publicar no npm passa a exigir nova ADR do Diretor.
- **Tarball dentro de `dist/` (item 6 da verificação).** Um tarball com outro `.tgz` dentro viola PUB-2 ("só o necessário"). A decisão do Diretor não muda; a T1.29 lida com isso assim:
  - o pack para `dist/` roda sobre um `dist/` sem `.tgz`: em CI, checkout limpo e o passo da T1.29 vem **depois** de `scripts/pack-smoke.sh` (que empacota num diretório temporário e conferiria PUB-2 contra um `.tgz` esquecido em `dist/`); fora de CI, o README documenta `rm -rf packages/engine/dist` antes do build;
  - o passo da T1.29 falha se, antes do pack, existir `packages/engine/dist/*.tgz`, e falha se depois do pack existir mais de um `.tgz` ou se o tarball tiver entrada fora de `package.json`, `README.md`, `LICENSE` e `dist/**/*.{js,d.ts}` (a mesma lista de PUB-2 de `pack-smoke.sh`);
  - o artifact do workflow anexa só `packages/engine/dist/*.tgz`, não o `dist/` inteiro.
  - Alternativa que a T1.29 **não** adota sem nova emenda: excluir `dist/*.tgz` em `files` do `package.json`. Ela muda o manifesto publicado e a T1.29 só toca o `package.json` se B-1 exigir (não exige mais).
- O Release usa o mesmo comando e o mesmo cuidado (checkout limpo da tag), então o asset tem o mesmo conteúdo do artifact de CI daquele commit.
- **PUB-4 e o Gate 1.** PUB-4 pede o pacote "disponível publicamente no canal decidido pelo Diretor" e instalação a partir desse canal; o Release só existe depois do GATE-1, e B-1 no PRD diz que o Gate 1 só aprova "com PUB-4 resolvido ou com dispensa registrada pelo Diretor em `GATE-1.md`". Com esta divisão, antes do gate o roteiro de PUB-4 é executado contra o artifact de CI (mesmos bytes do futuro asset), e a parte "disponível publicamente" fica com o Release. O texto de PUB-4 é do PM; a dispensa no gate é do Diretor. A proposta de texto está no PR desta revisão.
- B-1 está resolvido; T1.29 está desbloqueada.

## Alternativas descartadas

- **Registry npm público:** exige conta e escopo; sem ganho para a v0.1 além de um comando de instalação mais curto.
- **`pnpm --filter ./packages/engine pack`:** falha no pnpm 9.12 (ADR-007 Emenda 2).
- **T1.29 criar o Release como pré-release:** publicaria antes do Gate 1; o Diretor reservou a publicação ao Release, depois do GATE-1.

## Emenda 1 — 2026-10-26 (decisão do Diretor): artifact de CI não é distribuição

**Decisão do Diretor (2026-10-26, textual):** "artifact de CI gerado a partir de main é snapshot de desenvolvimento e não tem garantia de bytes; a única distribuição válida é o asset da GitHub Release apontada por tag. Bump de versão acontece exclusivamente no commit de release." Não exige versão nova por mudança de README.

**Por que nesta ADR e não na ADR-007:** a ADR-009 decide o canal de publicação (B-1) e quem publica (T1.29 = artifact de CI; Release = tag e GitHub Release). A regra trata exatamente disso: o que conta como distribuição e quando a versão muda. A ADR-007 fixa o pacote em si (`bin`, `files`, `dependencies`, comando de pack, nome do artifact na Emenda 3) e não muda.

**Leitura:**

- O artifact `whodeployed-engine-<version>` (ADR-007 Emenda 3) gerado em qualquer commit de `main` serve para CI e desenvolvimento. Ninguém deve instalar a partir dele nem citá-lo como versão publicada. Como `<version>` vem de `packages/engine/package.json` e a versão só muda no commit de release, artifacts de commits diferentes podem ter o mesmo nome e bytes diferentes. Exemplo: `README.md` está em `files` (ADR-007), então uma mudança de README em `main` depois de `engine-v0.1.0` gera outro `whodeployed-engine-0.1.0.tgz`, diferente do asset do Release. Isso é esperado e não pede versão nova.
- **A única distribuição válida** é o asset `whodeployed-engine-<version>.tgz` do GitHub Release apontado pela tag `engine-v<version>`. Instruções de instalação (README, PRDs, roteiros de teste, gates) apontam para a URL desse asset.
- **Bump de versão** (`version` em `packages/engine/package.json`) só acontece no commit de release (como `d22fba5`, PR #74, para `0.1.0`), feito pelo agente Release depois do gate. Nenhuma tarefa de engenharia muda a versão.
- **Relação com o texto acima.** O que a seção "Consequências" diz sobre o asset ter "o mesmo conteúdo do artifact de CI daquele commit" e sobre o roteiro de PUB-4 contra o artifact de CI ("mesmos bytes do futuro asset") vale só para o artifact gerado **no commit da tag**. É a reprodutibilidade verificada (item 4 da verificação: build limpo + pack = mesmo SHA-256), não uma garantia sobre artifacts de outros commits de `main`. O texto acima não é alterado.

## Histórico

- 2026-10-25 — aceita pelo Diretor: canal = tarball em GitHub Release (B-1).
- 2026-10-26 — revista: comando do asset `pnpm --dir packages/engine pack --pack-destination dist/` (decisão delegada, SPEC §12, aprovada pelo Diretor); T1.29 = artifact de CI + README + teste de instalação isolada; Release (tag `engine-v0.1.0`) = agente Release após GATE-1; verificação do comando e consequência do `.tgz` dentro de `dist/`. Issue #58, PR #67.
- 2026-10-26 — nome do artifact de CI: `whodeployed-engine-tarball` → `whodeployed-engine-<version>` (decisão do Diretor; ADR-007 Emenda 3; #64). Nada mais muda.
- 2026-10-26 — Emenda 1 (decisão do Diretor): artifact de CI gerado a partir de `main` é snapshot de desenvolvimento, sem garantia de bytes; a única distribuição válida é o asset do GitHub Release apontado por tag; bump de versão só no commit de release; mudança de README não exige versão nova. Registrada aqui, não na ADR-007, por ser regra de canal de publicação. Linhas anteriores da ADR mantidas (decisão do Diretor).
