## What

<!-- One sentence. Which task ID from docs/prd/FASE-N.tasks.md does this close? -->

Closes task: `T_._`

## Checklist (filled by the author, verified by QA)

- [ ] I read `SPEC.md` and this PR does not violate any principle in §3 (list the ones most at risk and how you checked):
  - §3.__ — 
- [ ] This PR stays inside the current phase's scope (`docs/prd/FASE-N.md`). Nothing from "fora de escopo".
- [ ] Tests added/updated and `pnpm test` passes locally.
- [ ] (engine) Determinism test passes: same seed ⇒ byte-identical output.
- [ ] (engine) No `Math.random()` outside `test/`.
- [ ] (scenarios) `pnpm validate` passes; `referencePath` uses only questions of the scenario's own level.
- [ ] (web) No simulation logic in the UI; works at 390 px; strings in `i18n/en.json`.
- [ ] No backend, no runtime network, no player telemetry.
- [ ] Conventional Commit messages.

## Evidence

<!-- Paste command output: tests, validator, build. QA will re-run them anyway. -->

## For QA

Label: `needs-qa`. The author does not review their own PR.
