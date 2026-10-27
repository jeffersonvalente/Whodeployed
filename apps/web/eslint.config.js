// ESLint flat config for apps/web (ADR-015 §4, pattern of ADR-008).
//
// src/ (the browser bundle):
//   PR-19  imports @whodeployed/* only through the public entries (@whodeployed/engine,
//          @whodeployed/scenarios, @whodeployed/scenarios/data); no deep @whodeployed/*/src|dist
//          path, no other subpath, and no YAML library ("the UI does not know YAML", SPEC §6);
//   PR-3   no network or beacon API (SPEC §3.6); scripts/check-static.sh greps the same;
//   DET    no Math.random / Date.now / new Date (D-4); the only clock is the injected wallClock;
//          no Node built-ins (the bundle runs in the browser).
// scripts/ (Node CLIs, ADR-015 §7) may also import @whodeployed/scenarios/node.
// test/ and config files: free, except the PR-19 import rule, which also applies to tests.
import tseslint from 'typescript-eslint'

const publicEntries = ['@whodeployed/engine', '@whodeployed/scenarios', '@whodeployed/scenarios/data']

function boundaryImports(allowed) {
  const allowedRegex = allowed
    .map((name) => name.replace(/^@whodeployed\//, '').replace(/[/.]/g, '\\$&'))
    .join('|')
  return {
    paths: [
      { name: 'yaml', message: 'The UI does not know YAML (SPEC §6, PR-19): use @whodeployed/scenarios/data.' },
      { name: 'js-yaml', message: 'The UI does not know YAML (SPEC §6, PR-19): use @whodeployed/scenarios/data.' },
    ],
    patterns: [
      {
        regex: '^@whodeployed/[^/]+/(src|dist)(/|$)',
        message: 'Deep import into a package (PR-19): use its public entry point.',
      },
      {
        regex: `^@whodeployed/(?!(${allowedRegex})$)`,
        message: `Only the public entries ${allowed.join(', ')} may be imported (PR-19, ADR-015 §4).`,
      },
      {
        regex: '(^|/)(yaml|js-yaml)(/|$)',
        message: 'The UI does not know YAML (SPEC §6, PR-19).',
      },
    ],
  }
}

const networkGlobals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
  name,
  message: `'${name}' is forbidden: no network at runtime (SPEC §3.6, PR-3).`,
}))

const nodeGlobals = ['process', 'require', 'Buffer'].map((name) => ({
  name,
  message: `'${name}' is a Node global; src/ runs in the browser.`,
}))

const forbiddenProperties = [
  ['Math', 'random', 'Non-deterministic source (D-4): randomness lives in the seeded engine.'],
  ['Date', 'now', 'Wall clock (D-4): use the injected wallClock (SessionDeps).'],
  ['navigator', 'sendBeacon', 'No player telemetry (SPEC §3.6, PR-3).'],
].map(([object, property, message]) => ({ object, property, message }))

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...boundaryImports(publicEntries),
          patterns: [
            ...boundaryImports(publicEntries).patterns,
            { regex: '^node:', message: 'Node built-ins are not available in the browser bundle.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...networkGlobals, ...nodeGlobals],
      'no-restricted-properties': ['error', ...forbiddenProperties],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: 'Wall clock (D-4): use the injected wallClock.' },
      ],
    },
  },
  {
    files: ['scripts/**/*.{ts,mts,js,mjs}'],
    rules: {
      'no-restricted-imports': ['error', boundaryImports([...publicEntries, '@whodeployed/scenarios/node'])],
    },
  },
  {
    files: ['test/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', boundaryImports([...publicEntries, '@whodeployed/scenarios/node'])],
    },
  },
)
