// ESLint flat config for packages/scenarios (ADR-008 style, ADR-014 §1.1).
//
// src/**: the engine is a *types-only* dependency (SPEC §6 "engine (types)"). Every import of
// '@whodeployed/engine' must be `import type` / `export type`; the runtime is injected by the
// caller as an EngineRuntime. Deep imports of the engine are refused (public entry only), and so
// are `import { type X }` (with verbatimModuleSyntax it still loads the module at runtime) and
// dynamic import()/require of the engine. Determinism (SPEC §3.3, D-4): no clock or unseeded
// randomness in src/.
// test/, scripts/ and configs may import engine values: they build the EngineRuntime.
// test/type-only-engine.test.ts proves the src/ rules reject a value import.
import tseslint from 'typescript-eslint'

const ENGINE = '@whodeployed/engine'

const typeOnlyMessage =
  "src/ imports only types from the engine (SPEC §6, ADR-014 §1.1): use `import type`, and take engine values as an EngineRuntime argument."

const nondeterministicProperties = [
  ['Math', 'random'],
  ['Date', 'now'],
  ['performance', 'now'],
  ['crypto', 'getRandomValues'],
  ['crypto', 'randomUUID'],
].map(([object, property]) => ({
  object,
  property,
  message: 'Non-deterministic source (SPEC §3.3, D-4): scenarios code is a pure function of its input.',
}))

const nondeterministicGlobals = ['Date', 'performance', 'crypto', 'setTimeout', 'setInterval'].map((name) => ({
  name,
  message: `'${name}' is forbidden in src/ (SPEC §3.3, D-4).`,
}))

// esquery regex literals cannot contain '/', so '.' stands for it: matches the engine and its subpaths.
const engineSource = '/^@whodeployed.engine/'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: ENGINE, allowTypeImports: true, message: typeOnlyMessage }],
          patterns: [
            {
              group: [`${ENGINE}/*`],
              message: 'Import the engine only through its public entry (ADR-014 §1).',
            },
          ],
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-restricted-properties': ['error', ...nondeterministicProperties],
      'no-restricted-globals': ['error', ...nondeterministicGlobals],
      'no-restricted-syntax': [
        'error',
        { selector: `ImportExpression[source.value=${engineSource}]`, message: typeOnlyMessage },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=${engineSource}]`,
          message: typeOnlyMessage,
        },
      ],
    },
  },
)
