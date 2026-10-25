// ESLint flat config for packages/engine (ADR-008).
// Determinism rules (D-4, ADR-003 §5) apply to all of src/; the library boundary (CT-3)
// applies to src/ except src/cli/; the CLI may import only node:util and node:process (D-5).
// Everything is relaxed in test/, where Math.random is allowed (CLAUDE.md).
import tseslint from 'typescript-eslint'

const nondeterministicProperties = [
  ['Math', 'random'],
  ['Date', 'now'],
  ['performance', 'now'],
  ['crypto', 'getRandomValues'],
  ['crypto', 'randomUUID'],
  ['process', 'hrtime'],
].map(([object, property]) => ({
  object,
  property,
  message: 'Non-deterministic source (D-4): use the seeded RngFactory from src/sim/rng.ts.',
}))

const nondeterministicGlobals = ['Date', 'Intl', 'performance', 'crypto', 'setTimeout', 'setInterval'].map(
  (name) => ({ name, message: `'${name}' is forbidden in src/ (D-4, ADR-003 §5).` }),
)

// Runtime I/O and host globals: the library is a pure function (SPEC §3.6, CT-3, D-5).
const ioGlobals = ['process', 'Buffer', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'globalThis'].map(
  (name) => ({ name, message: `'${name}' is forbidden in the engine library (CT-3, D-5).` }),
)

const localeSyntax = {
  selector: 'MemberExpression[property.name=/^(toLocaleString|toLocaleDateString|toLocaleTimeString|localeCompare)$/]',
  message: 'Locale-dependent API (D-2, ADR-003 §5): compare with < / > and format with JSON.stringify.',
}

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...nondeterministicProperties],
      'no-restricted-globals': ['error', ...nondeterministicGlobals, ...ioGlobals],
      'no-restricted-syntax': ['error', localeSyntax],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/)',
              message: 'Engine library imports only relative modules (CT-3, ADR-007).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/cli/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...nondeterministicGlobals],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!(\\.{1,2}/|node:util$|node:process$))',
              message: 'The CLI may import only the library, node:util and node:process (D-5, ADR-007).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**', '*.config.ts', '*.config.js'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },
)
