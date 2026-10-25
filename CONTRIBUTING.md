# Contributing to Whodeployed

Thanks for being here. The single most valuable thing you can contribute is **an incident you actually lived through**, turned into a playable scenario. You don't need to write code for that.

> Phase 0 note: the scenario validator and the game don't exist yet. Until Phase 4, scenario contributions are welcome as draft PRs or issues using the template below; they'll be wired in once `packages/scenarios` lands.

## 1. Contribute a scenario (no code needed)

1. Open an issue with the **"New scenario"** template, or copy `packages/scenarios/scenarios/_TEMPLATE.yaml`.
2. Fill in the fields. The ones that matter most:
   - `teaches` — the one thing a player should walk away knowing. One sentence.
   - `trap` — the misleading signal the scenario plants on purpose (the green dashboard, the loud-but-innocent service).
   - `referencePath` — the sequence of questions and actions a strong engineer would take. This is what the post-incident review compares against.
3. Keep it to **one fault, one lesson**. Two faults at once is a senior-level scenario; propose those only after the first eight exist.
4. Anonymize everything. No company names, no real hostnames, no real people.

Full format: `SPEC.md`, section 7.

## 2. Contribute code

- Read `SPEC.md` first, especially sections 3 (principles) and 6 (architecture). PRs that violate a principle are closed with the principle number cited, not with opinion.
- One PR, one goal. Branch from `main` as `<area>/<short-slug>`.
- Conventional Commits: `feat(engine): ...`, `fix(web): ...`, `docs: ...`.
- `pnpm test` must pass. Engine changes need tests; determinism by seed is non-negotiable (`Math.random()` outside tests fails review).
- English for code, filenames, commit messages and UI strings. Portuguese is fine in internal docs (`docs/`).

## 3. What we won't merge

- Features without a playable scenario behind them (SLO theory, alert design, OTel instrumentation — out of scope for v0.x).
- Anything that gates a *tool* behind a level. Only *questions* unlock.
- A backend, accounts, or player telemetry.
- Art before the mechanics work.

## 4. Review process

Every PR is reviewed against the current phase's PRD (`docs/prd/FASE-N.md`) and `SPEC.md §3`. A rejection names the criterion. Maintainers may use AI agents for review; a human (the Director) approves every gate.

## 5. Code of conduct

Be kind. Incidents are stressful enough in real life. We're all juniors at something.
